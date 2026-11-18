// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { CodingApi, CodingProjectDirectory } from "./types.ts";

type FolderResult =
  | { status: "idle" }
  | { status: "loading"; previous: CodingProjectDirectory | null }
  | { status: "ready"; directory: CodingProjectDirectory }
  | { status: "error"; message: string };

export type ProjectFolderState = FolderResult & {
  query: string;
  hidden: boolean;
};

export function displayedDirectory(state: ProjectFolderState) {
  return state.status === "ready"
    ? state.directory
    : state.status === "loading"
      ? state.previous
      : null;
}

/** A picker owns its draft, debounce and requests; conversations own none of them. */
export function createProjectFolderBrowser(
  browse: CodingApi["browseProjects"],
) {
  let state: ProjectFolderState = { status: "idle", query: "", hidden: false };
  let generation = 0;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: ProjectFolderState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation++;
    abort?.abort();
    abort = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    browse(
      query: string,
      options: { hidden?: boolean; debounce?: boolean } = {},
    ) {
      cancel();
      const request = generation;
      const hidden = options.hidden ?? state.hidden;
      const previous = displayedDirectory(state);
      const controller = new AbortController();
      abort = controller;
      update({ status: "loading", query, hidden, previous });
      const load = async () => {
        timer = null;
        try {
          const directory = await browse(query, controller.signal, hidden);
          if (request === generation)
            update({ status: "ready", query, hidden, directory });
        } catch (error) {
          if (request === generation)
            update({
              status: "error",
              query,
              hidden,
              message:
                error instanceof Error
                  ? error.message
                  : "Unable to read this folder. Try another path.",
            });
        }
      };
      if (options.debounce) timer = setTimeout(() => void load(), 120);
      else void load();
    },
    close() {
      cancel();
      update({ status: "idle", query: "", hidden: false });
    },
  };
}
