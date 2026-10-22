// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { codingRowSize } from "./file-changes.ts";
import type { CodingRow, EntryPage } from "./run-types.ts";

/** Eviction never removes provisional rows or the last complete saved entry. */
export function trimSavedEntries(
  source: CodingRow[],
  maxRows: number,
  maxText: number,
  edge: "start" | "end" = "start",
) {
  const key = (row: CodingRow) => row.entry_id ?? row.id;
  const groups = new Map<string, { count: number; size: number }>();
  let count = source.length;
  let size = 0;
  for (const row of source) {
    const bytes = codingRowSize(row);
    size += bytes;
    if (row.entry_id === null) continue;
    const prior = groups.get(key(row)) ?? { count: 0, size: 0 };
    groups.set(key(row), { count: prior.count + 1, size: prior.size + bytes });
  }
  const order = [...groups.keys()];
  if (edge === "end") order.reverse();
  const removed = new Set<string>();
  for (const entry of order) {
    if (
      groups.size - removed.size <= 1 ||
      (count <= maxRows && size <= maxText)
    )
      break;
    const group = groups.get(entry)!;
    removed.add(entry);
    count -= group.count;
    size -= group.size;
  }
  return {
    rows: removed.size
      ? source.filter((row) => !removed.has(key(row)))
      : source,
    omitted: removed.size > 0,
  };
}

export function trimEntryPage(
  page: EntryPage,
  maxRows: number,
  maxText: number,
  edge: "start" | "end",
) {
  const { rows, omitted } = trimSavedEntries(page.rows, maxRows, maxText, edge);
  return omitted
    ? {
        ...page,
        rows,
        older: page.older || edge === "start",
        newer: page.newer || edge === "end",
        first_id: rows.find((row) => row.entry_id)?.entry_id ?? page.first_id,
        last_id:
          [...rows].reverse().find((row) => row.entry_id)?.entry_id ??
          page.last_id,
      }
    : page;
}
