// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { groupCodingRows } from "../src/features/coding/presentation.ts";
import type { CodingRow } from "../src/features/coding/run-types.ts";

function tool(
  id: string,
  key = "native-group",
  request = "request",
): CodingRow {
  return {
    id,
    kind: "tool",
    request_id: request,
    tool: {
      invocation_id: id,
      call_id: `call-${id}`,
      request_id: request,
      name: "read",
      title: "Read file",
      status: "completed",
      output: "Public",
      clipped: false,
      quiet: false,
      row_group: { key, label: "Read", item: id },
    },
  };
}
test("adjacent public tool groups preserve native IDs and never infer grouping from names", () => {
  const rows = [
    tool("one"),
    tool("two"),
    { id: "text", kind: "assistant" as const, text: "Reply" },
    tool("three"),
    tool("four", "other-key"),
    tool("five", "other-key", "other-request"),
  ];
  const rendered = groupCodingRows(rows);
  assert.equal(rendered.length, 5);
  assert.deepEqual(
    rendered[0].grouped?.map((row) => row.tool?.invocation_id),
    ["one", "two"],
  );
  assert.equal(rendered[2].id, "three");
  assert.equal(rendered[3].id, "four");
  assert.equal(rendered[4].id, "five");
  assert.equal(rows[0].tool?.output, "Public");
  assert.equal(
    "grouped" in rows[0],
    false,
    "presentation must not mutate native projection rows",
  );
});
test("semantic public answers/reports are not hidden inside activity groups", () => {
  const answer = tool("answer");
  if (answer.tool) answer.tool.semantic_content = "answer_markdown";
  const rendered = groupCodingRows([tool("one"), answer, tool("two")]);
  assert.equal(rendered.length, 3);
  assert.equal(rendered[1].tool?.semantic_content, "answer_markdown");
});
