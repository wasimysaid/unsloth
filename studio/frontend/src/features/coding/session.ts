// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { type CodingInputDraft, createInputDraft } from "./input.ts";
import type { CodingConfigurationChange } from "./model-selection.ts";
import {
  MODEL_KEY,
  type Memory,
  PROJECT_KEY,
  browserMemory,
  isProject,
  isSelection,
  recall,
} from "./new-conversation-memory.ts";
import type {
  CodingApi,
  CodingConversation,
  CodingProjectDirectory,
} from "./types.ts";

/** A navigation the page is waiting on. A pending open is superseded by any
 * newer navigation; a create runs to its native outcome and is never doubled. */
export interface PendingOpening {
  operation: "create" | "open";
  id: string | null;
}
export interface CodingSessionState {
  conversations: CodingConversation[];
  active: CodingConversation | null;
  openingGeneration: number;
  reopened: boolean;
  loadingConversations: boolean;
  historyError: string | null;
  pending: PendingOpening | null;
  openingError: string | null;
  openingUncertainty: {
    operation: "create" | "open";
    id: string | null;
    inspected: boolean;
  } | null;
  directory: CodingProjectDirectory | null;
  browsing: boolean;
  browseError: string | null;
  /** The composer draft of the current view: text, selected mentions, images.
   * A conversation created from the landing takes the landing's draft over as
   * it is when the create lands. Every other opening, and New, starts a fresh one. */
  draft: CodingInputDraft;
  /** The folder a new conversation starts in; remembered across New and reloads. */
  project: string | null;
  /** The new conversation's first model, remembered likewise. */
  selection: CodingConfigurationChange | null;
  /** The just-created conversation sends the carried draft once it can. */
  autoSend: boolean;
}

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The coding request failed. Please try again.";

/** Ephemeral presentation state backed exclusively by the native HTTP API. */
export function createCodingSession(
  api: CodingApi,
  options: {
    onOpened?: (conversation: CodingConversation) => void;
    memory?: Memory | null;
  } = {},
) {
  const memory = options.memory === undefined ? browserMemory() : options.memory;
  const remember = (key: string, value: unknown) => {
    try {
      memory?.setItem(key, JSON.stringify(value));
    } catch {
      /* The choice still applies to this page if storage is unavailable. */
    }
  };
  let state: CodingSessionState = {
    conversations: [],
    active: null,
    openingGeneration: 0,
    reopened: false,
    loadingConversations: false,
    historyError: null,
    pending: null,
    openingError: null,
    openingUncertainty: null,
    directory: null,
    browsing: false,
    browseError: null,
    draft: createInputDraft(),
    project: recall(memory, PROJECT_KEY, isProject),
    selection: recall(memory, MODEL_KEY, isSelection),
    autoSend: false,
  };
  const listeners = new Set<() => void>();
  let historyRevision = 0;
  let navigation = 0;
  let current: { abort: AbortController; pending: PendingOpening } | null =
    null;
  let browseRevision = 0;
  let browseAbort: AbortController | null = null;
  const update = (patch: Partial<CodingSessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  async function refreshConversations() {
    const revision = ++historyRevision;
    update({ loadingConversations: true, historyError: null });
    try {
      const conversations = await api.listConversations();
      if (revision === historyRevision)
        update({
          conversations,
          loadingConversations: false,
          ...(state.openingUncertainty
            ? {
                openingUncertainty: {
                  ...state.openingUncertainty,
                  inspected: true,
                },
              }
            : {}),
        });
    } catch (error) {
      if (revision === historyRevision)
        update({
          historyError: errorText(error),
          loadingConversations: false,
        });
    }
  }

  /** Stop waiting on a pending open; a pending create cannot be withdrawn. */
  function supersede() {
    if (current?.pending.operation === "create") return false;
    current?.abort.abort();
    current = null;
    ++navigation;
    return true;
  }

  async function open(
    operation: (signal: AbortSignal) => Promise<CodingConversation>,
    kind: "create" | "open",
    id: string | null,
  ): Promise<boolean> {
    // Uncertain creation is never blindly repeated. Inspect the shared catalog,
    // then deliberately reopen a saved identity; folder equality is not identity.
    if (
      (current?.pending.operation === kind && current.pending.id === id) ||
      (state.openingUncertainty &&
        (kind === "create" || !state.openingUncertainty.inspected)) ||
      !supersede()
    )
      return false;
    const revision = navigation;
    const fromLanding = kind === "create" && state.active === null;
    const pending = { operation: kind, id };
    current = { abort: new AbortController(), pending };
    update({ pending, openingError: null });
    try {
      const active = await operation(current.abort.signal);
      if (revision !== navigation) {
        // Superseded: a create still finished natively, so history shows it.
        if (kind === "create") void refreshConversations();
        return false;
      }
      current = null;
      // Synchronous lifecycle boundary: retire old runtime observations before
      // publishing this owner, including deliberate same-ID reopenings.
      options.onOpened?.(active);
      // The canonical cwd and conversation ID come from Mimir, never the browser input.
      // A deliberate same-ID reopening also needs a fresh native view after
      // disconnect/closure; identity alone is not a subscription incarnation.
      if (kind === "create") remember(PROJECT_KEY, active.cwd);
      update({
        active,
        pending: null,
        openingUncertainty: null,
        openingGeneration: state.openingGeneration + 1,
        reopened: kind === "open",
        draft: fromLanding ? state.draft : createInputDraft(),
        autoSend: fromLanding && Boolean(state.draft.getSnapshot().text.trim()),
        ...(kind === "create" ? { project: active.cwd } : {}),
      });
      void refreshConversations();
      return true;
    } catch (error) {
      const superseded = revision !== navigation;
      if (!superseded) {
        current = null;
        update({ pending: null });
      }
      if (
        error instanceof Error &&
        "admissionRejected" in error &&
        error.admissionRejected === true
      ) {
        if (!superseded) update({ openingError: errorText(error) });
      } else if (!superseded || kind === "create") {
        // An abandoned open's fate is irrelevant; an unconfirmed create is not.
        update({
          openingUncertainty: { operation: kind, id, inspected: false },
          openingError: `${errorText(error)} The conversation may already exist; check the sidebar before starting another.`,
        });
        await refreshConversations(); // Inspection only: never replays create/open.
      }
      // Native errors and uncertainty never replace an already-open identity/cwd.
      return false;
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshConversations,
    /** Create in the chosen folder with the chosen first model. */
    startConversation() {
      const cwd = state.project;
      if (!cwd) return Promise.resolve(false);
      return open(
        () => api.createConversation(cwd, state.selection),
        "create",
        null,
      );
    },
    openConversation: (id: string) =>
      open((signal) => api.openConversation(id, signal), "open", id),
    /** A blank landing at once: a pending open is abandoned, never awaited.
     * A pending create is never withdrawn (false): it opens what it created. */
    startNew() {
      if (!supersede()) return false;
      // New work starts where the open conversation is.
      const project = state.active?.cwd ?? state.project;
      if (project) remember(PROJECT_KEY, project);
      update({
        active: null,
        pending: null,
        openingError: null,
        reopened: false,
        openingGeneration: state.openingGeneration + 1,
        draft: createInputDraft(),
        autoSend: false,
        project,
      });
      return true;
    },
    selectProject(cwd: string) {
      remember(PROJECT_KEY, cwd);
      update({ project: cwd, openingError: null });
    },
    /** A partial change keeps the rest of the remembered selection. */
    selectModel(change: CodingConfigurationChange) {
      const selection: CodingConfigurationChange | null =
        change.provider && change.model
          ? { provider: change.provider, model: change.model }
          : state.selection;
      if (!selection) return;
      const reasoning =
        change.provider && change.model
          ? change.reasoning
          : (change.reasoning ?? state.selection?.reasoning);
      const next = reasoning ? { ...selection, reasoning } : selection;
      remember(MODEL_KEY, next);
      update({ selection: next });
    },
    clearAutoSend: () => update({ autoSend: false }),
    clearOpeningError: () => update({ openingError: null }),
    async browse(path: string) {
      const revision = ++browseRevision;
      browseAbort?.abort();
      const abort = new AbortController();
      browseAbort = abort;
      // Disable choosing while loading so a path edit cannot select a stale folder.
      update({ directory: null, browsing: true, browseError: null });
      try {
        const directory = await api.browseProjects(path, abort.signal);
        if (revision === browseRevision) update({ directory, browsing: false });
      } catch (error) {
        if (revision === browseRevision)
          update({ browseError: errorText(error), browsing: false });
      }
    },
    cancelBrowse() {
      ++browseRevision;
      browseAbort?.abort();
      browseAbort = null;
      update({ directory: null, browsing: false, browseError: null });
    },
  };
}

export type CodingSession = ReturnType<typeof createCodingSession>;
