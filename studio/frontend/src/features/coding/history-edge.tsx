// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { LoaderCircle } from "lucide-react";
import type { HistoryDirection } from "./history-scroll";

export function HistoryEdge({
  direction,
  loading,
  error,
  disabled,
  onRetry,
}: {
  direction: HistoryDirection;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (!loading && !error) return null;
  const label = direction === "before" ? "earlier" : "newer";
  return (
    <div className="flex justify-center text-xs text-muted-foreground">
      {loading ? (
        <output className="flex h-7 items-center">
          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
          <span className="sr-only">Loading {label} messages</span>
        </output>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-full text-xs text-muted-foreground aria-disabled:opacity-50"
          data-reading-control={`retry-${direction}`}
          aria-disabled={disabled}
          onClick={() => {
            if (!disabled) onRetry();
          }}
        >
          Retry {label} messages
        </Button>
      )}
    </div>
  );
}
