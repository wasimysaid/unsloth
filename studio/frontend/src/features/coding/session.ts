// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type {
  CodingApi,
  CodingConversation,
  CodingProjectDirectory,
} from "./types.ts";

export interface CodingSessionState {
  conversations: CodingConversation[];
  active: CodingConversation | null;
  openingGeneration: number;
  reopened: boolean;
  loadingConversations: boolean;
  historyError: string | null;
  opening: boolean;
  openingError: string | null;
  openingUncertainty: {
    operation: "create" | "open";
    id: string | null;
    inspected: boolean;
  } | null;
  directory: CodingProjectDirectory | null;
  browsing: boolean;
  browseError: string | null;
}

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The coding request failed. Please try again.";

/** Ephemeral presentation state backed exclusively by the native HTTP API. */
export function createCodingSession(api: CodingApi) {
  let state: CodingSessionState = {
    conversations: [],
    active: null,
    openingGeneration: 0,
    reopened: false,
    loadingConversations: false,
    historyError: null,
    opening: false,
    openingError: null,
    openingUncertainty: null,
    directory: null,
    browsing: false,
    browseError: null,
  };
  const listeners = new Set<() => void>();
  let historyRevision = 0;
  let openingMutation = false;
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
                opening: openingMutation,
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
          ...(state.openingUncertainty ? { opening: openingMutation } : {}),
        });
    }
  }

  async function open(
    operation: () => Promise<CodingConversation>,
    kind: "create" | "open",
    id: string | null,
  ): Promise<boolean> {
    // Uncertain creation is never blindly repeated. Inspect the shared catalog,
    // then deliberately reopen a saved identity; folder equality is not identity.
    if (
      state.opening ||
      (state.openingUncertainty &&
        (kind === "create" || !state.openingUncertainty.inspected))
    )
      return false;
    openingMutation = true;
    update({ opening: true, openingError: null });
    try {
      const active = await operation();
      openingMutation = false;
      // The canonical cwd and conversation ID come from Mimir, never the browser input.
      // A deliberate same-ID reopening also needs a fresh native view after
      // disconnect/closure; identity alone is not a subscription incarnation.
      update({
        active,
        opening: false,
        openingUncertainty: null,
        openingGeneration: state.openingGeneration + 1,
        reopened: kind === "open",
      });
      void refreshConversations();
      return true;
    } catch (error) {
      openingMutation = false;
      if (
        error instanceof Error &&
        "admissionRejected" in error &&
        error.admissionRejected === true
      ) {
        update({ opening: false, openingError: errorText(error) });
      } else {
        update({
          openingUncertainty: { operation: kind, id, inspected: false },
          openingError: `${errorText(error)} Opening is unconfirmed, not failed. Inspect shared native history, then deliberately reopen a saved conversation; do not create another copy. Close the folder picker to inspect or refresh history.`,
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
    createConversation: (cwd: string) =>
      open(() => api.createConversation(cwd), "create", null),
    openConversation: (id: string) =>
      open(() => api.openConversation(id), "open", id),
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
