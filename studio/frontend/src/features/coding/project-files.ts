// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export type ProjectEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
};
export type DirectoryPage = {
  path: string;
  entries: ProjectEntry[];
  truncated: boolean;
};
export type SearchPage = { entries: ProjectEntry[]; truncated: boolean };
type FileMetadata = {
  path: string;
  size: number;
  revision: string;
  offset: number;
  next_offset: number | null;
};
export type FileDocument = FileMetadata &
  (
    | { kind: "text"; text: string }
    | { kind: "binary" | "unsupported"; text: null }
  );
export type ReadState<T> =
  | { phase: "loading" }
  | { phase: "ready"; value: T }
  | { phase: "failed"; message: string };
export type FilePosition = { offset: number; firstLine: number };
export type FileTab = {
  path: string;
  position: FilePosition;
  previous: FilePosition[];
  mode: "preview" | "source";
  revision?: string;
};
export interface ProjectFilesApi {
  directory(
    root: string,
    path: string,
    hidden: boolean,
    signal: AbortSignal,
  ): Promise<DirectoryPage>;
  search(
    root: string,
    query: string,
    hidden: boolean,
    signal: AbortSignal,
  ): Promise<SearchPage>;
  file(
    root: string,
    path: string,
    offset: number,
    revision: string | undefined,
    signal: AbortSignal,
  ): Promise<FileDocument>;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Could not read project files.";
const documentKey = (tab: FileTab) => `${tab.path}\0${tab.position.offset}`;
const MAX_CACHED_DOCUMENTS = 4;
type ProjectFilesState = {
  tabs: FileTab[];
  selected: string | null;
  expanded: Set<string>;
  directories: Map<string, ReadState<DirectoryPage>>;
  documents: Map<string, ReadState<FileDocument>>;
  query: string;
  search: ReadState<SearchPage> | null;
  hidden: boolean;
};
export function createProjectFiles(root: string, api: ProjectFilesApi) {
  let state: ProjectFilesState = {
    tabs: [],
    selected: null,
    expanded: new Set<string>([""]),
    directories: new Map<string, ReadState<DirectoryPage>>(),
    documents: new Map<string, ReadState<FileDocument>>(),
    query: "",
    search: null,
    hidden: false,
  };
  const listeners = new Set<() => void>();
  const directories = new Map<string, AbortController>();
  let reading: AbortController | null = null;
  let searching: AbortController | null = null;
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const tab = () => state.tabs.find((item) => item.path === state.selected);
  const publishDocument = (key: string, value: ReadState<FileDocument>) => {
    const documents = new Map(state.documents);
    documents.delete(key);
    documents.set(key, value);
    while (documents.size > MAX_CACHED_DOCUMENTS) {
      const first = documents.keys().next().value;
      if (first === undefined) break;
      documents.delete(first);
    }
    update({ documents });
  };
  async function read(selected: FileTab, refresh = false) {
    reading?.abort();
    const key = documentKey(selected);
    if (!refresh && state.documents.get(key)?.phase === "ready") return;
    const abort = new AbortController();
    reading = abort;
    publishDocument(key, { phase: "loading" });
    try {
      const value = await api.file(
        root,
        selected.path,
        selected.position.offset,
        selected.revision,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      update({
        tabs: state.tabs.map((item) =>
          item.path === selected.path
            ? { ...item, revision: value.revision }
            : item,
        ),
      });
      publishDocument(key, { phase: "ready", value });
    } catch (error) {
      if (!abort.signal.aborted)
        publishDocument(key, { phase: "failed", message: message(error) });
    }
  }
  const publishDirectory = (path: string, value: ReadState<DirectoryPage>) => {
    const cache = new Map(state.directories);
    cache.delete(path);
    cache.set(path, value);
    const expanded = new Set(state.expanded);
    while (cache.size > 64) {
      const oldest = [...cache.keys()].find(
        (key) => key !== "" && key !== path,
      );
      if (oldest === undefined) break;
      cache.delete(oldest);
      expanded.delete(oldest);
    }
    update({ directories: cache, expanded });
  };
  async function directory(path: string, refresh = false) {
    if (!refresh && state.directories.get(path)?.phase === "ready") return;
    directories.get(path)?.abort();
    const abort = new AbortController();
    directories.set(path, abort);
    publishDirectory(path, { phase: "loading" });
    try {
      const value = await api.directory(root, path, state.hidden, abort.signal);
      if (!abort.signal.aborted)
        publishDirectory(path, { phase: "ready", value });
    } catch (error) {
      if (!abort.signal.aborted)
        publishDirectory(path, { phase: "failed", message: message(error) });
    } finally {
      if (directories.get(path) === abort) directories.delete(path);
    }
  }
  async function search(query: string) {
    searching?.abort();
    update({ query, search: query ? { phase: "loading" } : null });
    if (!query) return;
    const abort = new AbortController();
    searching = abort;
    try {
      const value = await api.search(root, query, state.hidden, abort.signal);
      if (!abort.signal.aborted) update({ search: { phase: "ready", value } });
    } catch (error) {
      if (!abort.signal.aborted)
        update({ search: { phase: "failed", message: message(error) } });
    }
  }
  async function open(path: string) {
    let selected = state.tabs.find((item) => item.path === path);
    if (!selected) {
      selected = {
        path,
        position: { offset: 0, firstLine: 1 },
        previous: [],
        mode: "preview",
      };
      update({ tabs: [...state.tabs, selected], selected: path });
    } else update({ selected: path });
    await read(selected);
  }
  return {
    root,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    directory,
    search,
    open,
    activeTab: tab,
    activeDocument: () => {
      const selected = tab();
      return selected ? state.documents.get(documentKey(selected)) : undefined;
    },
    async close(path: string) {
      const index = state.tabs.findIndex((item) => item.path === path);
      const tabs = state.tabs.filter((item) => item.path !== path);
      update({ tabs });
      if (path !== state.selected) return;
      reading?.abort();
      const next = tabs[Math.min(index, tabs.length - 1)];
      update({ selected: next?.path ?? null });
      if (next) await read(next);
    },
    move(path: string, index: number) {
      const selected = state.tabs.find((item) => item.path === path);
      if (!selected) return;
      const tabs = state.tabs.filter((item) => item.path !== path);
      tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, selected);
      update({ tabs });
    },
    setMode(mode: FileTab["mode"]) {
      update({
        tabs: state.tabs.map((item) =>
          item.path === state.selected ? { ...item, mode } : item,
        ),
      });
    },
    async next() {
      const selected = tab();
      const document = selected && state.documents.get(documentKey(selected));
      if (
        !selected ||
        document?.phase !== "ready" ||
        document.value.kind !== "text" ||
        document.value.next_offset === null
      )
        return;
      const value = document.value;
      const offset = value.next_offset;
      if (offset === null) return;
      const next = {
        ...selected,
        previous: [...selected.previous, selected.position],
        position: {
          offset,
          firstLine:
            selected.position.firstLine + value.text.split("\n").length - 1,
        },
      };
      update({
        tabs: state.tabs.map((item) =>
          item.path === selected.path ? next : item,
        ),
      });
      await read(next);
    },
    async previous() {
      const selected = tab();
      const position = selected?.previous.at(-1);
      if (!selected || !position) return;
      const next = {
        ...selected,
        position,
        previous: selected.previous.slice(0, -1),
      };
      update({
        tabs: state.tabs.map((item) =>
          item.path === selected.path ? next : item,
        ),
      });
      await read(next);
    },
    async refresh() {
      const selected = tab();
      if (!selected) return directory("", true);
      const next = {
        ...selected,
        position: { offset: 0, firstLine: 1 },
        previous: [],
        revision: undefined,
      };
      update({
        tabs: state.tabs.map((item) =>
          item.path === selected.path ? next : item,
        ),
        documents: new Map(
          [...state.documents].filter(
            ([key]) => !key.startsWith(`${selected.path}\0`),
          ),
        ),
      });
      await read(next, true);
    },
    async toggleDirectory(path: string) {
      const expanded = new Set(state.expanded);
      if (expanded.has(path)) {
        expanded.delete(path);
        update({ expanded });
      } else {
        expanded.add(path);
        update({ expanded });
        await directory(path);
      }
    },
    async refreshTree() {
      const paths = [...state.expanded].filter((path) =>
        state.directories.has(path),
      );
      await Promise.all([
        ...paths.map((path) => directory(path, true)),
        ...(state.query ? [search(state.query)] : []),
      ]);
    },
    collapse() {
      update({ expanded: new Set([""]) });
    },
    async reveal(path: string, kind: "file" | "directory" = "file") {
      const parts = path.split("/");
      const expanded = new Set(state.expanded);
      const parents = [""];
      const depth = parts.length + (kind === "directory" ? 1 : 0);
      for (let index = 1; index < depth; index++)
        parents.push(parts.slice(0, index).join("/"));
      for (const parent of parents) expanded.add(parent);
      update({ expanded });
      await Promise.all(parents.map((parent) => directory(parent)));
    },
    async toggleHidden() {
      for (const abort of directories.values()) abort.abort();
      update({
        hidden: !state.hidden,
        directories: new Map(),
        expanded: new Set([""]),
      });
      await Promise.all([directory(""), search(state.query)]);
    },
    cancelRequests() {
      reading?.abort();
      searching?.abort();
      for (const abort of directories.values()) abort.abort();
    },
  };
}
export type ProjectFiles = ReturnType<typeof createProjectFiles>;
