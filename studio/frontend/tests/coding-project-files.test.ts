// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectFiles,
  type FileDocument,
  type ProjectFilesApi,
  type SearchPage,
  type DirectoryPage,
} from "../src/features/coding/project-files.ts";
import type * as FilesApi from "../src/features/coding/project-files-api.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const document = (
  path: string,
  text = "hello",
  offset = 0,
  next: number | null = null,
): FileDocument => ({
  path,
  text,
  offset,
  next_offset: next,
  size: 1000,
  revision: "rev-1",
  kind: "text",
});
function harness(overrides: Partial<ProjectFilesApi> = {}) {
  const reads: {
    root: string;
    path: string;
    offset: number;
    revision?: string;
    signal: AbortSignal;
  }[] = [];
  const files = createProjectFiles("/project", {
    directory: async (_root, path) => ({ path, entries: [], truncated: false }),
    search: async () => ({ entries: [], truncated: false }),
    file: async (root, path, offset, revision, signal) => {
      reads.push({ root, path, offset, revision, signal });
      return document(path);
    },
    ...overrides,
  });
  return { files, reads };
}

test("selection is immediate; switching files aborts and rejects late bodies", async () => {
  const a = pending<FileDocument>();
  const b = pending<FileDocument>();
  const signals: AbortSignal[] = [];
  const { files } = harness({
    file: (_root, path, _offset, _revision, signal) => {
      signals.push(signal);
      return path === "a.rs" ? a.promise : b.promise;
    },
  });
  const first = files.open("a.rs");
  assert.equal(files.getSnapshot().selected, "a.rs");
  assert.equal(files.activeDocument()?.phase, "loading");
  const second = files.open("b.rs");
  assert.equal(signals[0].aborted, true);
  b.resolve(document("b.rs", "second"));
  await second;
  a.resolve(document("a.rs", "stale"));
  await first;
  assert.deepEqual(files.activeDocument(), {
    phase: "ready",
    value: document("b.rs", "second"),
  });
  assert.equal(
    files.getSnapshot().documents.get("a.rs\0" + 0)?.phase,
    "loading",
  );
});

test("tab switching uses cached bodies and closing selects the nearest tab", async () => {
  const { files, reads } = harness();
  await files.open("a");
  await files.open("b");
  await files.open("c");
  await files.open("b");
  assert.equal(reads.length, 3);
  await files.close("b");
  assert.equal(files.getSnapshot().selected, "c");
  assert.equal(reads.length, 3);
  files.move("c", 0);
  assert.deepEqual(
    files.getSnapshot().tabs.map((tab) => tab.path),
    ["c", "a"],
  );
});

test("section navigation uses backend byte offsets and revision; reload recovers a changed file", async () => {
  const reads: { offset: number; revision?: string }[] = [];
  let changed = false;
  const { files } = harness({
    file: async (_root, path, offset, revision) => {
      reads.push({ offset, revision });
      if (offset && changed) throw new Error("File changed; reload it.");
      return document(path, offset ? "next" : "é\n", offset, offset ? null : 3);
    },
  });
  await files.open("a");
  await files.next();
  assert.deepEqual(reads, [
    { offset: 0, revision: undefined },
    { offset: 3, revision: "rev-1" },
  ]);
  assert.equal(files.activeTab()?.position.firstLine, 2);
  await files.previous();
  assert.equal(reads.length, 2);
  await files.refresh();
  assert.equal(files.getSnapshot().documents.size, 1);
  changed = true;
  await files.next();
  assert.equal(files.activeDocument()?.phase, "failed");
  await files.refresh();
  assert.equal(files.activeDocument()?.phase, "ready");
  assert.equal(files.activeTab()?.position.offset, 0);
  assert.equal(reads.at(-1)?.revision, undefined);
});

test("body and directory caches stay bounded while tabs remain independently addressable", async () => {
  const { files } = harness();
  for (let index = 0; index < 10; index++) await files.open(`file-${index}`);
  assert.equal(files.getSnapshot().documents.size, 4);
  assert.equal(files.getSnapshot().tabs.length, 10);
  await files.directory("");
  for (let index = 0; index < 100; index++)
    await files.toggleDirectory(`dir-${index}`);
  assert.equal(files.getSnapshot().directories.size, 64);
  assert.equal(files.getSnapshot().directories.has(""), true);
  assert.ok(files.getSnapshot().expanded.size <= 64);
});

test("new searches reject older completions and cancellation supports remounting the same owner", async () => {
  const old = pending<SearchPage>();
  const latest = pending<SearchPage>();
  const signals: AbortSignal[] = [];
  const { files } = harness({
    search: (_root, query, _hidden, signal) => {
      signals.push(signal);
      return query === "old" ? old.promise : latest.promise;
    },
  });
  const first = files.search("old");
  const second = files.search("new");
  assert.equal(signals[0].aborted, true);
  latest.resolve({
    entries: [{ name: "new", path: "new", kind: "file" }],
    truncated: false,
  });
  await second;
  old.resolve({ entries: [], truncated: false });
  await first;
  assert.equal(files.getSnapshot().query, "new");
  assert.equal(files.getSnapshot().search?.phase, "ready");
  files.cancelRequests();
  await files.open("after-remount");
  assert.equal(files.activeDocument()?.phase, "ready");
});

test("hidden toggle cancels and discards the old directory generation", async () => {
  const old = pending<DirectoryPage>();
  let signal: AbortSignal | undefined;
  const { files } = harness({
    directory: async (_root, path, hidden, requestSignal) => {
      if (!hidden) {
        signal = requestSignal;
        return old.promise;
      }
      return {
        path,
        entries: [{ name: ".config", path: ".config", kind: "file" }],
        truncated: false,
      };
    },
  });
  const first = files.directory("");
  await files.toggleHidden();
  assert.equal(signal?.aborted, true);
  old.resolve({ path: "", entries: [], truncated: false });
  await first;
  const root = files.getSnapshot().directories.get("");
  assert.equal(
    root?.phase === "ready" && root.value.entries[0].name,
    ".config",
  );
});

const parsers = loadWithStubs<typeof FilesApi>(
  new URL("../src/features/coding/project-files-api.ts", import.meta.url),
  {
    "./api": {
      codingRequest: () => {
        throw new Error("Not called");
      },
    },
  },
);
test("file boundary rejects malformed kinds and non-progressing continuation", () => {
  assert.deepEqual(parsers.parseFileDocument(document("a")), document("a"));
  assert.throws(() =>
    parsers.parseFileDocument({ ...document("a"), kind: "executable" }),
  );
  assert.throws(() =>
    parsers.parseFileDocument({ ...document("a"), offset: 3, next_offset: 3 }),
  );
  assert.throws(() =>
    parsers.parseFileDocument({ ...document("a"), text: null }),
  );
  assert.throws(() =>
    parsers.parseDirectoryPage({
      path: "",
      entries: [{ name: "a", path: "a", kind: "unknown" }],
      truncated: false,
    }),
  );
});

test("revealing a directory search result loads its ancestor chain and children", async () => {
  const loaded: string[] = [];
  const { files } = harness({
    directory: async (_root, path) => {
      loaded.push(path);
      return { path, entries: [], truncated: false };
    },
  });
  await files.search("nested");
  await files.search("");
  await files.reveal("src/nested", "directory");
  assert.equal(files.getSnapshot().query, "");
  assert.deepEqual(loaded, ["", "src", "src/nested"]);
  assert.equal(files.getSnapshot().expanded.has("src/nested"), true);
});

test("refresh tree observes file additions/deletions in expanded directories only", async () => {
  const reads: string[] = [];
  let generation = "before";
  const { files } = harness({
    directory: async (_root, path) => {
      reads.push(path);
      return {
        path,
        entries: [
          { name: generation, path: `${path}/${generation}`, kind: "file" },
        ],
        truncated: false,
      };
    },
  });
  await files.directory("");
  await files.toggleDirectory("expanded");
  await files.toggleDirectory("collapsed");
  await files.toggleDirectory("collapsed");
  reads.length = 0;
  generation = "after";
  await files.refreshTree();
  assert.deepEqual(reads, ["", "expanded"]);
  for (const path of ["", "expanded"]) {
    const page = files.getSnapshot().directories.get(path);
    assert.equal(
      page?.phase === "ready" && page.value.entries[0].name,
      "after",
    );
  }
});
