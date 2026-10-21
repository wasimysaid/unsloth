// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import type { CodingRow } from "../src/features/coding/run-types.ts";
import {
  projectTranscript,
  readingRowKey,
  latestWindow,
} from "../src/features/coding/transcript-model.ts";
import { atTranscriptBottom } from "../src/features/coding/transcript-reader.ts";

test("bottom-follow uses geometry, not streaming or projection status", () => {
  assert.equal(
    atTranscriptBottom({
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400,
    }),
    true,
  );
  assert.equal(
    atTranscriptBottom({
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1352,
    }),
    true,
  );
  assert.equal(
    atTranscriptBottom({
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1300,
    }),
    false,
  );
  assert.equal(
    atTranscriptBottom({ scrollHeight: 400, clientHeight: 600, scrollTop: 0 }),
    true,
  );
});

test("saved/provisional keys preserve exact invocation while repeated edits stay separate", () => {
  const tool = (id: string, invocation: string): CodingRow => ({
    id,
    kind: "tool",
    tool: {
      invocation_id: invocation,
      call_id: "same-provider-call",
      request_id: "request",
      name: "edit_file",
      title: "Edit file",
      status: "completed",
      output: "public",
      clipped: false,
      quiet: false,
      row_group: null,
    },
  });
  const provisional = tool("live-entry", "invocation-one");
  const saved = {
    ...tool("saved-entry", "invocation-one"),
    entry_id: "native-saved-entry",
    historical: true,
  };
  const repeated = tool("another-entry", "invocation-two");
  assert.equal(readingRowKey(provisional), readingRowKey(saved));
  assert.notEqual(readingRowKey(saved), readingRowKey(repeated));
  const [block] = projectTranscript([saved, repeated], latestWindow());
  assert.equal(block.kind, "activity");
  if (block.kind !== "activity") return;
  assert.deepEqual(
    block.items.map((item) => item.key),
    [readingRowKey(provisional), readingRowKey(repeated)],
    "repeated edits stay separate under exact invocation keys",
  );
  assert.equal(
    block.items[0].row,
    saved,
    "native identities stay unmodified in the projection",
  );
  const adapter = codingRunAdapter(null, null);
  assert.ok(adapter.convertMessage);
  assert.equal(adapter.convertMessage(block, 0).id, block.key);
});

test("accepted answer replacement retains exact request/question identity, not answer text", () => {
  const row: CodingRow = {
    id: "answer:live",
    kind: "user",
    answer: { request_id: "request", user_request_id: "question", answers: [] },
  };
  assert.equal(
    readingRowKey(row),
    readingRowKey({ ...row, id: "answer:saved" }),
  );
  assert.ok(row.answer);
  assert.notEqual(
    readingRowKey(row),
    readingRowKey({
      ...row,
      answer: { ...row.answer, user_request_id: "next-question" },
    }),
  );
});
