// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  patchRows,
  selectReviewLines,
} from "../src/features/coding/git-review-lines.ts";

const rows = patchRows(
  [
    "diff --git a/a b/a",
    "--- a/a",
    "+++ b/a",
    "@@ -7,2 +18,3 @@",
    " keep",
    "-old",
    "+new",
    "+++counter",
    "@@ -30 +41 @@",
    "-other",
    "+changed",
    "",
  ].join("\n"),
);

test("reverse gutter selection keeps the complete raw excerpt and inclusive patch coordinates", () => {
  const selected = selectReviewLines(rows, 5, 7)?.selection;
  assert.deepEqual(selected, {
    start_line: 6,
    end_line: 8,
    excerpt: "-old\n+new\n+++counter",
    location: "19–20",
  });
  assert.deepEqual(rows.map((row) => [row.before, row.after]).slice(4, 8), [
    [7, 18],
    [8, undefined],
    [undefined, 19],
    [undefined, 20],
  ]);
});

test("file headers are not selectable and shift selection stays within one hunk", () => {
  assert.equal(selectReviewLines(rows, 2), null);
  assert.deepEqual(selectReviewLines(rows, 9, 5)?.selection, {
    start_line: 10,
    end_line: 10,
    excerpt: "-other",
    location: "30",
  });
});
