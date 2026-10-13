// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { CodingRow } from "./run-types.ts";

export type PresentationRow = CodingRow & { grouped?: CodingRow[] };

/** assistant-ui creates a transient empty assistant while a native request runs.
 * It has no native identity/output and is not a transcript entry. */
export function nativeMessageRow(message: {
  metadata: { custom?: Record<string, unknown> };
}): PresentationRow | null {
  return (
    (message.metadata.custom?.nativeRow as PresentationRow | undefined) ?? null
  );
}

/** Presentation only: adjacent native group keys, never tool-name heuristics. */
export function groupCodingRows(rows: readonly CodingRow[]): PresentationRow[] {
  const result: PresentationRow[] = [];
  for (const row of rows) {
    const prior = result.at(-1);
    const group = row.tool?.row_group;
    if (
      group &&
      !row.tool?.semantic_content &&
      !prior?.tool?.semantic_content &&
      !row.tool?.subagent &&
      !prior?.tool?.subagent &&
      prior?.tool?.row_group?.key === group.key &&
      prior.request_id === row.request_id
    ) {
      result[result.length - 1] = {
        ...prior,
        grouped: [...(prior.grouped ?? [prior]), row],
      };
    } else {
      result.push(row);
    }
  }
  return result;
}
