// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import type { RuntimeMaintenance } from "./runtime-maintenance";

export function CodingRuntimeControls({
  maintenance,
  state,
}: {
  maintenance: RuntimeMaintenance;
  state: ReturnType<RuntimeMaintenance["getSnapshot"]>;
}) {
  const cleanup = state.status?.cleanup;
  const incomplete =
    state.status?.state === "cleanup_failed" || (cleanup && !cleanup.confirmed);
  return (
    <section
      className="min-w-0 space-y-2 break-words text-xs"
      aria-label="Mimir runtime maintenance"
      data-testid="coding-runtime-maintenance"
    >
      <h3 className="text-sm font-medium">
        Mimir runtime ·{" "}
        {state.restarting
          ? "restarting"
          : (state.status?.state ?? "status unavailable")}
        {incomplete ? " · cleanup unconfirmed" : ""}
        {state.error || state.statusError ? " · inspect runtime error" : ""}
      </h3>
      <div className="space-y-2">
        <output
          aria-live="polite"
          data-testid="coding-runtime-status"
          className="block"
        >
          Runtime: {state.status?.state ?? "unavailable"} · generation{" "}
          {state.status?.generation ?? "unknown"}
        </output>
        {state.status?.state === "stopping" && (
          <p role="status">
            Stopping · waiting for native drain and process/session cleanup.
            Shutdown is not yet confirmed.
          </p>
        )}
        {state.status?.state === "maintenance_unconfirmed" && (
          <p role="status">
            Native maintenance admission is unconfirmed. The original process
            remains live; Stop and views remain available. New
            prompt/create/open admissions are blocked. Refresh runtime status to
            inspect before another Restart action.
          </p>
        )}
        {state.status?.state === "restart_prepared" && (
          <p role="status">
            Native restart preparation is confirmed, but process replacement is
            not complete. Explicitly select Restart whole Mimir runtime to
            finish cleanup and replacement; no maintenance command is replayed
            automatically.
          </p>
        )}
        <p id="coding-runtime-restart-scope" className="text-muted-foreground">
          Restart whole Mimir runtime affects all hosted conversations, not just
          this view. Native safety checks refuse restart while any conversation
          has busy work. Explicitly Stop affected work and wait for confirmed
          cleanup first.
        </p>
        <p className="text-muted-foreground">
          Frontend-plugin replacement requires this process restart, not hot
          reload. Saved history remains; owners are not reopened and accepted
          work, answers and commands are not replayed automatically.
        </p>
        {cleanup && (
          <p
            role={incomplete ? "alert" : "status"}
            data-testid="coding-runtime-cleanup"
          >
            Cleanup {cleanup.confirmed ? "confirmed" : "not confirmed"} · exit
            code {cleanup.exit_code ?? "unknown"} ·{" "}
            {cleanup.forced ? "forced termination" : "not forced"}.{" "}
            {cleanup.message}
          </p>
        )}
        {state.error && (
          <p
            role="alert"
            data-testid="coding-runtime-error"
            className="text-destructive"
          >
            {state.error}
          </p>
        )}
        {state.statusError && (
          <p role="alert" className="text-destructive">
            Runtime status inspection failed: {state.statusError}. Refresh
            runtime status to inspect again.
          </p>
        )}
        {state.notice && (
          <p role="status" data-testid="coding-runtime-notice">
            {state.notice}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-auto whitespace-normal text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-describedby="coding-runtime-restart-scope"
            data-testid="coding-runtime-restart"
            aria-disabled={
              state.restarting ||
              state.restartUncertainty ||
              state.status?.state === "restarting" ||
              state.status?.state === "maintenance_unconfirmed" ||
              state.status?.state === "stopping"
            }
            onClick={() => void maintenance.restart()}
          >
            Restart whole Mimir runtime
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={state.reading || state.restarting}
            onClick={() => void maintenance.refresh()}
          >
            Refresh runtime status
          </Button>
        </div>
      </div>
    </section>
  );
}
