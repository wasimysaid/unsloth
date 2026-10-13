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
  loadingConversations: boolean;
  historyError: string | null;
  opening: boolean;
  openingError: string | null;
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
    loadingConversations: false,
    historyError: null,
    opening: false,
    openingError: null,
    directory: null,
    browsing: false,
    browseError: null,
  };
  const listeners = new Set<() => void>();
  let historyRevision = 0;
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
        update({ conversations, loadingConversations: false });
    } catch (error) {
      if (revision === historyRevision)
        update({ historyError: errorText(error), loadingConversations: false });
    }
  }

  async function open(
    operation: () => Promise<CodingConversation>,
  ): Promise<boolean> {
    // One native opening at a time, including repeated keyboard activation.
    if (state.opening) return false;
    update({ opening: true, openingError: null });
    try {
      const active = await operation();
      // The canonical cwd and conversation ID come from Mimir, never the browser input.
      // A deliberate same-ID reopening also needs a fresh native view after
      // disconnect/closure; identity alone is not a subscription incarnation.
      update({ active, opening: false, openingGeneration: state.openingGeneration + 1 });
      void refreshConversations();
      return true;
    } catch (error) {
      update({ opening: false, openingError: errorText(error) });
      // Do not replace an already-open conversation when validation/opening fails.
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
      open(() => api.createConversation(cwd)),
    openConversation: (id: string) => open(() => api.openConversation(id)),
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
