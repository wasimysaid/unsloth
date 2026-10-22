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
  PublicEntryChunk,
  RunApi,
} from "../src/features/coding/run-types.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();
const cut: JournalCut = { journal: "root", leaf: "entry" };
function fixture(rows: CodingRow[], width = 1024) {
  const bytes = encoder.encode(JSON.stringify(rows));
  const ref: ContentReference = {
    cut,
    entry_id: "entry",
    total_bytes: bytes.length,
  };
  const calls: number[] = [];
  const readPublicEntry: RunApi["readPublicEntry"] = async (
    id,
    requested,
    offset,
  ) => {
    assert.deepEqual(requested, ref);
    calls.push(offset);
    let end = Math.min(bytes.length, offset + width);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return {
      conversation_id: id,
      ...ref,
      offset,
      data: new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset, end),
      ),
      next_offset: end === bytes.length ? null : end,
    };
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

test("saved multirow entry assembles all 2.52MiB of Unicode at exact UTF8 chunk offsets", async () => {
  const rows = saved("漢🙂".repeat(360000));
  const f = fixture(rows, 32768);
  assert.deepEqual(
    await assemblePublicEntry(
      f,
      "conversation",
      f.ref,
      new AbortController().signal,
    ),
    rows,
  );
  assert.equal(f.calls[0], 0);
  assert.ok(f.calls.length > 70);
  assert.ok(f.calls.every((offset, n) => n === 0 || offset > f.calls[n - 1]));
});

test("chunk identity, cut, totals, byte progress and exact EOF are checked before accepting rows", async () => {
  const f = fixture(saved());
  for (const patch of [
    { conversation_id: "other" },
    { entry_id: "other" },
    { cut: { journal: "root", leaf: "other" } },
    { cut: { journal: { child: "other" }, leaf: "entry" } },
    { offset: 1 },
    { total_bytes: f.ref.total_bytes + 1 },
    { data: "" },
    { data: "x".repeat(f.ref.total_bytes + 1) },
    { next_offset: 0 },
    { next_offset: f.ref.total_bytes },
  ]) {
    const api = {
      readPublicEntry: async (...args: Parameters<RunApi["readPublicEntry"]>) =>
        ({
          ...(await f.readPublicEntry(...args)),
          ...patch,
        }) as PublicEntryChunk,
    };
    await assert.rejects(
      assemblePublicEntry(
        api,
        "conversation",
        f.ref,
        new AbortController().signal,
      ),
      /immutable cut.*byte offsets/,
    );
  }
  const early = fixture(saved("a".repeat(4000)));
  await assert.rejects(
    assemblePublicEntry(
      {
        readPublicEntry: async (...args) => ({
          ...(await early.readPublicEntry(...args)),
          next_offset: null,
        }),
      },
      "conversation",
      early.ref,
      new AbortController().signal,
    ),
    /byte offsets/,
  );
});

test("complete entry rejects recursive references, duplicate rows, unrelated entries and non-row JSON", async () => {
  for (const rows of [
    [{ id: "entry", entry_id: "entry", kind: "content_ref" }],
    [
      {
        ...saved()[0],
        content_ref: { cut, entry_id: "entry", total_bytes: 1 },
      },
    ],
    [saved()[0], saved()[0]],
    [{ ...saved()[0], entry_id: "other" }],
    [],
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
  for (const data of ["{}", "null", "[invalid]"]) {
    const ref = {
      cut,
      entry_id: "entry",
      total_bytes: encoder.encode(data).length,
    };
    await assert.rejects(
      assemblePublicEntry(
        {
          readPublicEntry: async () => ({
            conversation_id: "conversation",
            ...ref,
            offset: 0,
            data,
            next_offset: null,
          }),
        },
        "conversation",
        ref,
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
    { content_ref: { ...f.ref, total_bytes: 0 } },
    { content_ref: { ...f.ref, total_bytes: 1.5 } },
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
  let release!: (chunk: PublicEntryChunk) => void;
  let firstSignal: AbortSignal | undefined;
  let reads = 0;
  let page!: EntryPage;
  page = await readCompleteEntryPage(
    {
      readEntries: async () => f.page,
      readPublicEntry: async (...args) => {
        if (++reads === 1) {
          firstSignal = args[3];
          return await new Promise<PublicEntryChunk>((done) => {
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
  release({
    conversation_id: "wrong",
    ...f.ref,
    offset: 0,
    data: "bad",
    next_offset: null,
  });
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
