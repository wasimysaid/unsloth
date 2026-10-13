// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  type FileChangeFile,
  MAX_DIFF_CHARACTERS,
  MAX_DIFF_LINES,
  codingRowSize,
  reportedCounts,
  reportedUnifiedDiff,
} from "../src/features/coding/file-changes.ts";
import { groupCodingRows } from "../src/features/coding/presentation.ts";
import type { CodingRow } from "../src/features/coding/run-types.ts";

const changed = (overrides: Partial<FileChangeFile> = {}): FileChangeFile => ({
  path: "src/example.ts",
  status: "updated",
  additions: 1,
  deletions: 1,
  binary: false,
  partial: false,
  truncated: false,
  hunks: [
    {
      lines: [
        { old_line: 7, new_line: 7, kind: "context", content: "unchanged\n" },
        { old_line: 8, new_line: null, kind: "removed", content: "before\n" },
        { old_line: null, new_line: 8, kind: "added", content: "after\n" },
      ],
    },
  ],
  ...overrides,
});

test("unified diff uses supplied paths, hunk positions and chronological lines only", () => {
  assert.deepEqual(reportedUnifiedDiff(changed()), {
    text: "--- src/example.ts\n+++ src/example.ts\n@@ -7,2 +7,2 @@\n unchanged\n-before\n+after\n",
    clipped: false,
  });
});
test("opposite EOF-newline changes remain distinguishable without inventing truncated EOF facts", () => {
  const newlineChange = (before: string, after: string, truncated = false) =>
    reportedUnifiedDiff(
      changed({
        truncated,
        hunks: [
          {
            lines: [
              { old_line: 1, new_line: null, kind: "removed", content: before },
              { old_line: null, new_line: 1, kind: "added", content: after },
            ],
          },
        ],
      }),
    ).text;
  const added = newlineChange("value", "value\n");
  const removed = newlineChange("value\n", "value");
  assert.ok(added.includes("-value\n\\ No newline at end of file\n+value\n"));
  assert.ok(removed.includes("-value\n+value\n\\ No newline at end of file\n"));
  assert.notEqual(added, removed);
  assert.doesNotMatch(newlineChange("clipped", "value\n", true), /No newline/);
});

test("unavailable counts stay unavailable; a supplied zero is not missing", () => {
  assert.equal(
    reportedCounts(changed({ additions: null, deletions: 0 })),
    "Added count unavailable · −0 removed",
  );
  assert.equal(
    reportedCounts(changed({ additions: 0, deletions: null })),
    "+0 added · Removed count unavailable",
  );
});
test("binary and metadata-only changes never fabricate textual content", () => {
  assert.deepEqual(reportedUnifiedDiff(changed({ binary: true })), {
    text: "",
    clipped: false,
  });
  assert.deepEqual(
    reportedUnifiedDiff(
      changed({ hunks: [], additions: null, deletions: null }),
    ),
    { text: "", clipped: false },
  );
});
test("partial hunks with unavailable positions do not invent complete ranges", () => {
  const file = changed({
    partial: true,
    hunks: [
      {
        lines: [
          {
            old_line: null,
            new_line: null,
            kind: "added",
            content: "supplied excerpt",
          },
        ],
      },
    ],
  });
  assert.match(reportedUnifiedDiff(file).text, /@@ -\?,\? \+\?,\? @@/);
  assert.match(reportedUnifiedDiff(file).text, /\+supplied excerpt/);
});
test("created/deleted empty sides use their reported operation, not workspace data", () => {
  const created = changed({
    status: "created",
    hunks: [
      {
        lines: [{ old_line: null, new_line: 1, kind: "added", content: "new" }],
      },
    ],
  });
  assert.match(
    reportedUnifiedDiff(created).text,
    /^--- \/dev\/null\n\+\+\+ src\/example.ts\n@@ -0,0 \+1,1 @@/,
  );
  const deleted = changed({
    status: "deleted",
    hunks: [
      {
        lines: [
          { old_line: 1, new_line: null, kind: "removed", content: "old" },
        ],
      },
    ],
  });
  assert.match(
    reportedUnifiedDiff(deleted).text,
    /^--- src\/example.ts\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@/,
  );
});
test("large and oversized-line diffs are bounded with an explicit clipping result", () => {
  const file = changed({
    hunks: [
      {
        lines: Array.from({ length: 5000 }, (_, index) => ({
          old_line: null,
          new_line: index + 1,
          kind: "added" as const,
          content: `line ${index}`,
        })),
      },
    ],
  });
  const result = reportedUnifiedDiff(file);
  assert.equal(result.clipped, true);
  assert.ok(result.text.length <= MAX_DIFF_CHARACTERS);
  assert.ok(result.text.split("\n").length <= MAX_DIFF_LINES + 1);
  const long = reportedUnifiedDiff(
    changed({
      hunks: [
        {
          lines: [
            {
              old_line: null,
              new_line: 1,
              kind: "added",
              content: "x".repeat(40000),
            },
          ],
        },
      ],
    }),
  );
  assert.equal(long.clipped, true);
  assert.ok(long.text.length <= MAX_DIFF_CHARACTERS);
  const multiline = reportedUnifiedDiff(
    changed({
      hunks: [
        {
          lines: [
            {
              old_line: null,
              new_line: 1,
              kind: "added",
              content: "x\n".repeat(500),
            },
          ],
        },
      ],
    }),
  );
  assert.equal(multiline.clipped, true);
  assert.ok(multiline.text.split("\n").length <= MAX_DIFF_LINES + 1);
});
function row(id: string, file: FileChangeFile, historical = false): CodingRow {
  return {
    id,
    kind: "tool",
    historical,
    tool: {
      invocation_id: `inv-${id}`,
      call_id: `call-${id}`,
      request_id: "request",
      name: "edit_file",
      title: "Edit file",
      status: "completed",
      output: "Actual output",
      clipped: false,
      quiet: false,
      row_group: { key: "native-group", label: "Edits", item: file.path },
      output_profile: { kind: "file_change", files: [file], truncated: false },
    },
  };
}
test("repeated edits remain separate even with the same native group and path", () => {
  const first = row("one", changed());
  const second = row(
    "two",
    changed({
      hunks: [
        {
          lines: [
            { old_line: 8, new_line: null, kind: "removed", content: "after" },
            { old_line: null, new_line: 8, kind: "added", content: "third" },
          ],
        },
      ],
    }),
    true,
  );
  const projected = groupCodingRows([first, second]);
  assert.equal(projected.length, 2);
  assert.deepEqual(
    projected.map((item) => item.tool?.invocation_id),
    ["inv-one", "inv-two"],
  );
  assert.deepEqual(
    projected.map((item) => item.tool?.call_id),
    ["call-one", "call-two"],
  );
  assert.equal(projected[1].historical, true);
  assert.equal(projected[0].grouped, undefined);
  assert.deepEqual(
    projected[0].tool?.output_profile,
    first.tool?.output_profile,
  );
});
test("structured effects count toward the ephemeral transcript budget and no-profile output remains real", () => {
  const withProfile = row("one", changed());
  assert.ok(withProfile.tool);
  assert.ok(codingRowSize(withProfile) > withProfile.tool.output.length);
  const noProfile = {
    ...withProfile,
    tool: { ...withProfile.tool, output_profile: null },
  };
  assert.equal(codingRowSize(noProfile), "Actual output".length);
  assert.equal(groupCodingRows([noProfile])[0].tool?.output, "Actual output");
});
