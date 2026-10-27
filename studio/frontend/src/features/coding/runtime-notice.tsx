// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { RuntimeMaintenance } from "./runtime-maintenance";

const healthy = (status: string | undefined) =>
  !status || ["running", "not_started"].includes(status);

/** Shown only when the Mimir process itself needs attention. Restart affects
 * every hosted conversation; native admission refuses it while work is busy. */
export function RuntimeNotice({
  maintenance,
  runtime,
}: {
  maintenance: RuntimeMaintenance;
  runtime: ReturnType<RuntimeMaintenance["getSnapshot"]>;
}) {
  const status = runtime.status?.state;
  const cleanup = runtime.status?.cleanup;
  if (healthy(status) && !runtime.error && !runtime.restarting) return null;
  const busy =
    runtime.restarting ||
    runtime.restartUncertainty ||
    ["restarting", "maintenance_unconfirmed", "stopping"].includes(
      status ?? "",
    );
  const unclean =
    cleanup && !cleanup.confirmed
      ? `Mimir didn't shut down cleanly: ${cleanup.message}`
      : null;
  const message =
    [runtime.error, unclean].filter(Boolean).join(" ") ||
    (runtime.restarting || status === "restarting"
      ? "Restarting Mimir…"
      : status === "stopping"
        ? "Mimir is stopping…"
        : `Mimir runtime ${status?.replaceAll("_", " ") ?? "unavailable"}`);
  return (
    <div
      className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 px-3 pt-1 text-xs sm:px-6"
      data-testid="coding-runtime-maintenance"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2">
        {busy ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : (
          <TriangleAlert
            className="size-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        )}
        <output
          className="min-w-0 flex-1 break-words"
          data-testid="coding-runtime-status"
          role={runtime.error ? "alert" : undefined}
        >
          {message}
        </output>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-full"
          data-testid="coding-runtime-restart"
          title="Restarts Mimir for every conversation. Busy conversations refuse it."
          disabled={busy}
          onClick={() => void maintenance.restart()}
        >
          Restart Mimir
        </Button>
      </div>
    </div>
  );
}
