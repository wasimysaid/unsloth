// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { PermissionMode } from "../chat/stores/chat-runtime-store";
import { type CodingInputDraft, createInputDraft } from "./input.ts";
import { handoffBlockedReason, handoffContextError } from "./model-handoff.ts";
import { codingPlanDecisionReason, type CodingRunState } from "./run-session.ts";
import type { NativePlan } from "./plan-types.ts";
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
  ReviewedPlanSource,
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
  /** The composer draft of the current view: text, selected mentions, images.
   * A conversation created from the landing takes the landing's draft over as
   * it is when the create lands. Every other opening, and New, starts a fresh one. */
  draft: CodingInputDraft;
  /** The folder a new conversation starts in; remembered across New and reloads. */
  project: string | null;
  /** The new conversation's first model, remembered likewise. */
  selection: CodingConfigurationChange | null;
  /** Applies only to the first turn of this draft project. */
  terminalMode: PermissionMode;
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
    setTerminalMode?: (conversation: CodingConversation, mode: PermissionMode) => Promise<void>;
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
    draft: createInputDraft(),
    project: recall(memory, PROJECT_KEY, isProject),
    selection: recall(memory, MODEL_KEY, isSelection),
    autoSend: false,
    terminalMode: "auto",
  };
  const listeners = new Set<() => void>();
  let historyRevision = 0;
  let navigation = 0;
  let current: { abort: AbortController; pending: PendingOpening } | null =
    null;
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
    terminalMode: PermissionMode = "auto",
    firstMessage?: string,
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
      let permissionError: string | null = null;
      if (terminalMode !== "auto") {
        try {
          if (!active.cwd || !options.setTerminalMode)
            throw new Error("Terminal permissions are unavailable.");
          await options.setTerminalMode(active, terminalMode);
        } catch (error) {
          // Creation succeeded. Keep the draft attached to its real conversation.
          permissionError = `Your message is still a draft. Check terminal permissions before sending. ${errorText(error)}`;
        }
      }
      current = null;
      // Synchronous lifecycle boundary: retire old runtime observations before
      // publishing this owner, including deliberate same-ID reopenings.
      options.onOpened?.(active);
      // The canonical cwd and conversation ID come from Mimir, never the browser input.
      // A deliberate same-ID reopening also needs a fresh native view after
      // disconnect/closure; identity alone is not a subscription incarnation.
      if (kind === "create") remember(PROJECT_KEY, active.cwd);
      const draft = fromLanding ? state.draft : createInputDraft();
      if (firstMessage) draft.syncText(firstMessage);
      update({
        active,
        pending: null,
        openingUncertainty: null,
        openingGeneration: state.openingGeneration + 1,
        reopened: kind === "open",
        draft,
        autoSend: !permissionError && Boolean(draft.getSnapshot().text.trim()),
        terminalMode: "auto",
        openingError: permissionError,
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

  type HandoffTarget = { provider: string; model: string };
  async function startHandoff(
    source: CodingRunState,
    target: HandoffTarget,
    transfer: { kind: "brief"; context: string } | { kind: "plan"; plan: NativePlan },
  ) {
    const active = state.active;
    const native = source.native;
    if (!active || !native || active.id !== native.info.id || state.pending) return false;
    const reject = (openingError: string) => {
      update({ openingError });
      return false;
    };
    const blocked = handoffBlockedReason(source, active.cwd !== null);
    if (blocked) return reject(blocked);
    const draft = state.draft.getSnapshot();
    if (draft.text || draft.images.length || draft.reading.length)
      return reject("Send or clear your current draft before handing off.");
    if (!target.provider || !target.model ||
        (target.provider === native.configuration.provider && target.model === native.configuration.model))
      return reject("Choose a different model for the handoff.");

    let mode = native.configuration.mode;
    let context: string;
    let planSource: ReviewedPlanSource | undefined;
    if (transfer.kind === "plan") {
      const plan = native.plan;
      if (!plan || plan.id !== transfer.plan.id || plan.revision !== transfer.plan.revision)
        return reject("This plan has changed. Review the latest version first.");
      const reason = codingPlanDecisionReason(source, plan, "implement_fresh");
      if (reason) return reject(reason);
      if (plan.clipped || !plan.markdown.trim())
        return reject("The complete plan is unavailable for handoff.");
      if (!active.runtime_generation) return reject("Reopen this conversation before handing off its plan.");
      planSource = { conversation_id: active.id, runtime_generation: active.runtime_generation, plan_id: plan.id, revision: plan.revision };
      mode = "build";
      context = "Implement the following reviewed plan.\n\n" + plan.markdown;
    } else {
      context = transfer.context;
    }
    const contextError = handoffContextError(context);
    if (contextError) return reject(contextError);
    if (mode !== "plan" && mode !== "build")
      return reject("The current coding mode cannot be carried to another conversation.");
    const permissions = source.terminalPermissions;
    return open(
      () => api.createConversation(active.cwd, { ...target, mode }, planSource),
      "create", null,
      active.cwd && permissions?.kind === "ready" ? permissions.mode : "auto",
      context,
    );
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
    /** Start with the chosen model, with or without a project. */
    startConversation(cwd: string | null = state.project) {
      return open(
        () => api.createConversation(cwd, state.selection),
        "create",
        null,
        !state.active && state.project ? state.terminalMode : "auto",
      );
    },
    handoff: (source: CodingRunState, target: HandoffTarget, context: string) =>
      startHandoff(source, target, { kind: "brief", context }),
    implementPlanWithModel: (source: CodingRunState, plan: NativePlan, target: HandoffTarget) =>
      startHandoff(source, target, { kind: "plan", plan }),
    openConversation: (id: string) =>
      open((signal) => api.openConversation(id, signal), "open", id),
    /** A blank landing at once: a pending open is abandoned, never awaited.
     * A pending create is never withdrawn (false): it opens what it created. */
    startNew() {
      if (!supersede()) return false;
      // New work starts where the open conversation is.
      const project = state.active ? state.active.cwd : state.project;
      remember(PROJECT_KEY, project);
      update({
        active: null,
        pending: null,
        openingError: null,
        reopened: false,
        openingGeneration: state.openingGeneration + 1,
        draft: createInputDraft(),
        autoSend: false,
        terminalMode: "auto",
        project,
      });
      return true;
    },
    selectDraftTerminalMode(mode: PermissionMode) {
      if (state.project && !state.active && !state.pending) update({ terminalMode: mode });
    },
    selectProject(cwd: string | null) {
      if (state.pending?.operation === "create") return;
      remember(PROJECT_KEY, cwd);
      update({
        project: cwd,
        openingError: null,
        terminalMode: cwd === state.project ? state.terminalMode : "auto",
      });
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
      const preserve = change.provider && change.model
        ? change.preserve_thinking
        : change.preserve_thinking ?? state.selection?.preserve_thinking;
      const next = { ...selection, ...(reasoning ? { reasoning } : {}),
        ...(preserve !== undefined ? { preserve_thinking: preserve } : {}) };
      remember(MODEL_KEY, next);
      update({ selection: next });
    },
    clearAutoSend: () => update({ autoSend: false }),
    clearOpeningError: () => update({ openingError: null }),

  };
}

export type CodingSession = ReturnType<typeof createCodingSession>;
