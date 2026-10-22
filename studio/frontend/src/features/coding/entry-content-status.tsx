// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { CodingRow } from "./run-types";

export function EntryContentStatus({ row }: { row: CodingRow }) {
  return (
    <div
      className="min-w-0 space-y-2 text-xs text-muted-foreground"
      data-content-entry={row.entry_id}
    >
      <p role="status" className="whitespace-pre-wrap break-words">
        {row.content?.status === "error"
          ? `Saved entry content is not loaded. ${row.content.error}`
          : "Loading the complete saved entry. Live work and conversation controls remain available."}
      </p>
      {row.content && (
        <button
          type="button"
          onClick={row.content.retry}
          className="rounded-md border px-2 py-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry loading entry
        </button>
      )}
    </div>
  );
}
