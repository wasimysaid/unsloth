// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { ChildIdentity } from "./child-types.ts";
import type { CodingRow } from "./run-types.ts";

export interface TextDelta {
  type: "text_delta";
  row: {
    id: string;
    entry_id: null;
    request_id: string | null;
    kind: "assistant" | "reasoning";
  };
  offset: number;
  delta: string;
  child?: ChildIdentity;
}

const encoder = new TextEncoder();
const lengths = new WeakMap<CodingRow, number>();

export function applyTextDelta(
  rows: CodingRow[],
  event: TextDelta,
): CodingRow[] {
  const { row, offset, delta } = event;
  if (
    !row ||
    typeof row.id !== "string" ||
    !row.id ||
    row.entry_id !== null ||
    (row.request_id !== null && typeof row.request_id !== "string") ||
    !["assistant", "reasoning"].includes(row.kind) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof delta !== "string" ||
    !delta
  )
    throw new Error("Invalid native text delta identity or offset.");
  const index = rows.findIndex((item) => item.id === row.id);
  const prior = index < 0 ? undefined : rows[index];
  if (
    prior &&
    (prior.kind !== row.kind ||
      prior.entry_id !== row.entry_id ||
      prior.request_id !== row.request_id)
  )
    throw new Error("Native text delta changed immutable row identity.");
  const length = prior
    ? (lengths.get(prior) ?? encoder.encode(prior.text ?? "").length)
    : 0;
  if (offset !== length)
    throw new Error(
      "Native text delta offset did not match its complete UTF8 base. Reconnect for a fresh view.",
    );
  const next: CodingRow = { ...row, text: (prior?.text ?? "") + delta };
  lengths.set(next, length + encoder.encode(delta).length);
  if (index < 0) return [...rows, next];
  return rows.map((item, at) => (at === index ? next : item));
}
