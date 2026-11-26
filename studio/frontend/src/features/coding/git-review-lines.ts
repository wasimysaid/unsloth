// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
export interface LineSelection {
  start_line: number;
  end_line: number;
  excerpt: string;
  location: string;
}

export function patchRows(text: string) {
  const lines = text.replace(/\n$/, "").split("\n");
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  return lines.map((raw, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    let before: number | undefined;
    let after: number | undefined;
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk) {
      if (raw[0] === "-" || raw[0] === " ") before = oldNumber++;
      if (raw[0] === "+" || raw[0] === " ") after = newNumber++;
    }
    return { raw, index, before, after, hunk: Boolean(hunk), inHunk };
  });
}

export function selectReviewLines(
  rows: ReturnType<typeof patchRows>,
  index: number,
  anchor = index,
) {
  const range = rows.slice(
    Math.min(anchor, index),
    Math.max(anchor, index) + 1,
  );
  const first = range.every(
    (r) => r.before !== undefined || r.after !== undefined,
  )
    ? anchor
    : index;
  const selected = rows.slice(
    Math.min(index, first),
    Math.max(index, first) + 1,
  );
  const after = selected.flatMap((row) =>
    row.after === undefined ? [] : [row.after],
  );
  const source = after.length
    ? after
    : selected.flatMap((row) => (row.before === undefined ? [] : [row.before]));
  const from = source[0];
  const to = source.at(-1);
  if (from === undefined || to === undefined) return null;
  return {
    first,
    selection: {
      start_line: selected[0].index + 1,
      end_line: selected[selected.length - 1].index + 1,
      excerpt: selected.map((row) => row.raw).join("\n"),
      location: from === to ? String(from) : `${from}–${to}`,
    },
  };
}
