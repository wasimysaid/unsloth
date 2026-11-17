// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { Folder, LoaderCircle, Map as MapIcon, X } from "lucide-react";
import { projectName } from "./project-name";
import type { CodingRun, CodingRunState } from "./run-session";
import { codingModeControlReason } from "./run-session";

/** The row under an open conversation's composer. */
export function ComposerFooter({
  cwd,
  state,
  run,
}: {
  cwd: string | null;
  state: CodingRunState | null;
  run: CodingRun | null;
}) {
  const mode = state?.native?.configuration.mode;
  const leaving = state?.planControl?.kind === "mode";
  const compression = state?.native?.compression;
  return (
    <div className="flex h-7 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground/80">
      {cwd && (
        <span
          className="flex min-w-0 items-center gap-1.5 truncate"
          title={cwd}
          data-testid="coding-canonical-cwd"
        >
          <Folder className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{projectName(cwd)}</span>
        </span>
      )}
      {mode === "plan" && (
        <span
          className="flex h-7 shrink-0 items-center gap-1 pl-2 text-muted-foreground"
          data-testid="coding-plan-mode"
        >
          <MapIcon className="size-3.5" aria-hidden="true" />
          Plan mode
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            aria-label="Leave plan mode"
            title={codingModeControlReason(state) ?? "Leave plan mode"}
            disabled={Boolean(codingModeControlReason(state)) || leaving}
            onClick={() => void run?.setMode("build")}
          >
            {leaving ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <X className="size-3" aria-hidden="true" />
            )}
          </button>
        </span>
      )}
      {compression?.status === "running" && (
        <span
          className="shrink-0 coding-shimmer"
          data-testid="coding-compression-status"
        >
          Compacting context…
        </span>
      )}
    </div>
  );
}

/** Feedback for a slash command: its transient output, or why it failed. */
export function CommandFeedback({
  state,
  run,
}: {
  state: CodingRunState;
  run: CodingRun;
}) {
  const outcome = state.commandOutcome;
  const display = outcome?.outcome === "display" ? outcome : null;
  if (state.commandBusy)
    return (
      <output className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
        Running command…
      </output>
    );
  if (state.uncertainCommand)
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs"
        data-testid="coding-command-uncertainty"
      >
        <span className="min-w-0 flex-1">
          /{state.uncertainCommand.name} may or may not have run.
          {state.uncertainCommand.reconciled
            ? " It was not repeated."
            : " Checking…"}
        </span>
        {state.uncertainCommand.reconciled && (
          <button
            type="button"
            className="rounded-md px-2 py-1 font-medium hover:bg-accent disabled:opacity-50"
            disabled={
              state.connection !== "connected" || state.reconcilingCommand
            }
            onClick={() => void run.reconcileCommand()}
          >
            {state.reconcilingCommand ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
    );
  if (!display && !state.commandError) return null;
  return (
    <div
      className={`relative rounded-xl border px-3 py-2 pr-8 text-xs ${state.commandError ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-border/60 bg-muted/40"}`}
      data-testid={state.commandError ? "coding-command-error" : "coding-command-outcome"}
      role={state.commandError ? "alert" : undefined}
    >
      {state.commandError ? (
        <p className="break-words">{state.commandError}</p>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px]">
          {display?.text}
          {display?.clipped && "\n…"}
        </pre>
      )}
      <button
        type="button"
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss"
        onClick={() => run.dismissCommandOutcome()}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
