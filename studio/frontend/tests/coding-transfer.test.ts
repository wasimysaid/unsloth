// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  assemblePublicEntry,
  readCompleteEntryPage,
  replaceEntryContent,
} from "../src/features/coding/entry-content.ts";
import { trimSavedEntries } from "../src/features/coding/entry-window.ts";
import {
  applyTextDelta,
  type TextDelta,
} from "../src/features/coding/live-rows.ts";
import {
  projectTranscript,
  latestWindow,
} from "../src/features/coding/transcript-model.ts";
import type {
  CodingRow,
  ContentReference,
  EntryPage,
  JournalCut,
  RunApi,
} from "../src/features/coding/run-types.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cut: JournalCut = { journal: "root", leaf: "entry" };
function fixture(rows: CodingRow[]) {
  const ref: ContentReference = { cut, entry_id: "entry" };
  const calls: string[] = [];
  const readPublicEntry: RunApi["readPublicEntry"] = async (id, requested) => {
    assert.deepEqual(requested, ref);
    calls.push(id);
    return rows;
  };
  const placeholder: CodingRow = {
    id: "entry",
    entry_id: "entry",
    request_id: null,
    kind: "content_ref",
    content_ref: ref,
  };
  const page: EntryPage = {
    cut,
    rows: [placeholder],
    first_id: "entry",
    last_id: "entry",
    older: false,
    newer: false,
  };
  return { ref, calls, page, readPublicEntry };
}
const saved = (text = "漢🙂"): CodingRow[] => [
  { id: "a", entry_id: "entry", request_id: null, kind: "assistant", text },
  {
    id: "b",
    entry_id: "entry",
    request_id: null,
    kind: "reasoning",
    text: "exact second row",
  },
];

test("saved multirow entry resolves all 2.52MiB of Unicode in one owned HTTP transfer", async () => {
  const rows = saved("漢🙂".repeat(360000));
  const f = fixture(rows);
  assert.deepEqual(
    await assemblePublicEntry(
      f,
      "conversation",
      f.ref,
      new AbortController().signal,
    ),
    rows,
  );
  assert.deepEqual(f.calls, ["conversation"]);
});

test("a deferred native entry with no public rows removes its reference without losing the pagination cursor", async () => {
  const f = fixture([]);
  const rows = await assemblePublicEntry(
    f,
    "conversation",
    f.ref,
    new AbortController().signal,
  );
  const page = {
    ...f.page,
    rows: replaceEntryContent(f.page.rows, f.ref, rows),
  };
  assert.deepEqual(page.rows, []);
  assert.equal(page.first_id, "entry");
  assert.equal(page.last_id, "entry");
  assert.deepEqual(f.calls, ["conversation"]);
});

test("complete entry rejects recursive references, duplicate rows, unrelated entries and non-row JSON", async () => {
  for (const rows of [
    [{ id: "entry", entry_id: "entry", kind: "content_ref" }],
    [
      {
        ...saved()[0],
        content_ref: { cut, entry_id: "entry" },
      },
    ],
    [saved()[0], saved()[0]],
    [{ ...saved()[0], entry_id: "other" }],
  ] as CodingRow[][]) {
    const f = fixture(rows);
    await assert.rejects(
      assemblePublicEntry(
        f,
        "conversation",
        f.ref,
        new AbortController().signal,
      ),
      /immutable cut/,
    );
  }
  for (const data of [{}, null, "invalid"]) {
    await assert.rejects(
      assemblePublicEntry(
        { readPublicEntry: async () => data as CodingRow[] },
        "conversation",
        { cut, entry_id: "entry" },
        new AbortController().signal,
      ),
      /immutable cut/,
    );
  }
});

test("page reference cuts and placeholder identity are validated before content requests", async () => {
  const f = fixture(saved());
  for (const patch of [
    { id: "other" },
    { entry_id: "other" },
    { request_id: "request" },
    { content_ref: { ...f.ref, entry_id: "" } },
    { content_ref: { ...f.ref, cut: { journal: "root", leaf: "other" } } },
  ]) {
    await assert.rejects(
      readCompleteEntryPage(
        {
          ...f,
          readEntries: async () => ({
            ...f.page,
            rows: [{ ...f.page.rows[0], ...patch } as CodingRow],
          }),
        },
        "conversation",
        cut,
        "latest",
        new AbortController().signal,
        () => {},
        () => {},
      ),
      /immutable cut/,
    );
  }
  assert.deepEqual(f.calls, []);
});

test("failed reference is explicit and retryable without keeping capture pending", async () => {
  const f = fixture(saved());
  let fail = true;
  let fatal = false;
  let page!: EntryPage;
  page = await readCompleteEntryPage(
    {
      readEntries: async () => f.page,
      readPublicEntry: async (...args) => {
        if (fail) throw new Error("temporary entry read failure");
        return f.readPublicEntry(...args);
      },
    },
    "conversation",
    cut,
    "latest",
    new AbortController().signal,
    (ref, rows) => {
      page.rows = replaceEntryContent(page.rows, ref, rows);
    },
    () => {
      fatal = true;
    },
  );
  await tick();
  assert.equal(page.rows[0].kind, "content_ref");
  assert.equal(page.rows[0].content?.status, "error");
  assert.match(
    page.rows[0].content?.error ?? "",
    /temporary entry read failure/,
  );
  assert.equal(fatal, false);
  assert.equal(
    projectTranscript(page.rows, latestWindow())[0].kind,
    "content_ref",
  );
  fail = false;
  page.rows[0].content?.retry();
  await tick();
  assert.deepEqual(
    page.rows.map((row) => row.text),
    ["漢🙂", "exact second row"],
  );
});

test("retry aborts a slow content request and its late result cannot overwrite the replacement", async () => {
  const f = fixture(saved());
  let release!: (chunk: CodingRow[]) => void;
  let firstSignal: AbortSignal | undefined;
  let reads = 0;
  let page!: EntryPage;
  page = await readCompleteEntryPage(
    {
      readEntries: async () => f.page,
      readPublicEntry: async (...args) => {
        if (++reads === 1) {
          firstSignal = args[2];
          return await new Promise<CodingRow[]>((done) => {
            release = done;
          });
        }
        return f.readPublicEntry(...args);
      },
    },
    "conversation",
    cut,
    "latest",
    new AbortController().signal,
    (ref, rows) => {
      page.rows = replaceEntryContent(page.rows, ref, rows);
    },
    () => {},
  );
  assert.equal(page.rows[0].content?.status, "loading");
  page.rows[0].content?.retry();
  await tick();
  assert.equal(firstSignal?.aborted, true);
  assert.equal(page.rows[0].text, "漢🙂");
  release([{ ...saved()[0], entry_id: "wrong" }]);
  await tick();
  assert.equal(page.rows[0].text, "漢🙂");
});

test("abort discards incomplete entry assembly and genuine owner-loss errors are not swallowed", async () => {
  const f = fixture(saved("x".repeat(4000)));
  const abort = new AbortController();
  const api = {
    readPublicEntry: async (...args: Parameters<RunApi["readPublicEntry"]>) => {
      const chunk = await f.readPublicEntry(...args);
      abort.abort();
      return chunk;
    },
  };
  await assert.rejects(
    assemblePublicEntry(api, "conversation", f.ref, abort.signal),
    { name: "AbortError" },
  );
  assert.equal(f.calls.length, 1);
  const loss = Object.assign(new Error("runtime changed"), {
    requiresReopen: true,
  });
  let observed: unknown;
  await readCompleteEntryPage(
    {
      readEntries: async () => f.page,
      readPublicEntry: async () => {
        throw loss;
      },
    },
    "conversation",
    cut,
    "latest",
    new AbortController().signal,
    () => {},
    (error) => {
      observed = error;
    },
  );
  await tick();
  assert.equal(observed, loss);
});

const delta = (
  offset: number,
  text: string,
  patch: Partial<TextDelta["row"]> = {},
): TextDelta => ({
  type: "text_delta",
  row: {
    id: "live",
    entry_id: null,
    request_id: "request",
    kind: "assistant",
    ...patch,
  },
  offset,
  delta: text,
});
test("live deltas require a complete exact UTF8 base and immutable row identity", () => {
  const first = applyTextDelta([], delta(0, "漢🙂"));
  const second = applyTextDelta(first, delta(7, "tail"));
  assert.equal(first[0].text, "漢🙂");
  assert.equal(second[0].text, "漢🙂tail");
  for (const event of [
    delta(3, "bad"),
    delta(6, "bad"),
    delta(8, "bad"),
    delta(0, "duplicate"),
    delta(7, ""),
    delta(7, "bad", { kind: "reasoning" }),
    delta(7, "bad", { request_id: "other" }),
    delta(7, "bad", { entry_id: "saved" as never }),
  ])
    assert.throws(() => applyTextDelta(first, event), /identity|offset/);
  assert.throws(
    () => applyTextDelta([], delta(4, "suffix")),
    /complete UTF8 base/,
  );
});

test("entry eviction removes whole saved groups, retains one full entry and never removes provisional rows", () => {
  const a: CodingRow = {
    id: "a",
    entry_id: "one",
    kind: "assistant",
    text: "large",
  };
  const b: CodingRow = {
    id: "b",
    entry_id: "one",
    kind: "reasoning",
    text: "large",
  };
  const c: CodingRow = {
    id: "c",
    entry_id: "two",
    kind: "assistant",
    text: "large",
  };
  const p: CodingRow = {
    id: "p",
    entry_id: null,
    kind: "assistant",
    text: "live",
  };
  assert.deepEqual(trimSavedEntries([a, b], 1, 1).rows, [a, b]);
  assert.deepEqual(trimSavedEntries([a, c, b, p], 1, 1).rows, [c, p]);
  assert.deepEqual(trimSavedEntries([a, c, b, p], 1, 1, "end").rows, [a, b, p]);
  assert.deepEqual(trimSavedEntries([p], 0, 0), { rows: [p], omitted: false });
});
