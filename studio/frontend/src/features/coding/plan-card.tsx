// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { LoaderCircle } from "lucide-react";
import type { NativePlan, PlanDecision } from "./plan-types";
import {
  type CodingRun,
  type CodingRunState,
  codingModeControlReason,
  codingPlanDecisionReason,
} from "./run-session";

const planLabels: Record<NativePlan["status"], string> = {
  review_pending: "Awaiting your decision",
  saved_stopped: "Saved · implementation not started",
  accepted: "Accepted · implementation admitted",
  implementing: "Implementing",
  completed: "Implementation completed",
  abandoned: "Abandoned",
};
const choices: {
  decision: PlanDecision;
  label: string;
  description: string;
}[] = [
  {
    decision: "implement",
    label: "Implement",
    description: "Continue in this conversation and switch to Build.",
  },
  {
    decision: "implement_fresh",
    label: "Implement with fresh context",
    description:
      "Keep saved history, clear model context, and build from the plan alone.",
  },
  {
    decision: "save_and_stop",
    label: "Save and stop",
    description:
      "Save the plan and return to Build without starting implementation.",
  },
];

/** Native plan content is a record, not a workspace editor or implied acceptance. */
export function PlanCard({
  plan,
  historical = false,
  state,
  run,
}: {
  plan: NativePlan;
  historical?: boolean;
  state?: CodingRunState;
  run?: CodingRun | null;
}) {
  const reason = historical
    ? "Historical record · actions target only the current native plan."
    : codingPlanDecisionReason(state ?? null, plan);
  const explanation = historical ? undefined : "coding-plan-action-explanation";
  return (
    <details
      className="min-w-0 shrink-0 rounded-2xl border border-border/60 bg-background text-sm dark:bg-card"
      data-testid={
        historical ? "coding-historical-plan" : "coding-current-plan"
      }
      data-plan-id={plan.id}
    >
      <summary className="cursor-pointer break-words rounded-2xl px-3.5 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">
          {historical ? "Plan" : "Current plan"}: {plan.name}
        </span>
        <span className="ml-2 text-xs text-muted-foreground">
          {planLabels[plan.status] ?? plan.status}
        </span>
      </summary>
      <div
        className="max-h-[min(45dvh,30rem)] space-y-3 overflow-y-auto p-3 pt-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region"
        aria-label={
          historical ? "Historical plan content" : "Current native plan content"
        }
        tabIndex={0}
      >
        {plan.path && (
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {plan.path}
          </p>
        )}
        {historical && (
          <p className="text-xs text-muted-foreground">
            Saved native lifecycle record · not current workspace contents.
          </p>
        )}
        <pre
          className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed"
          data-testid="coding-plan-content"
        >
          {plan.markdown}
        </pre>
        {historical && !plan.markdown && (
          <p className="text-xs font-medium">
            The plan body was not recorded in this older historical entry. It
            has not been reconstructed from today's file.
          </p>
        )}
        {plan.clipped && (
          <p className="text-xs font-medium">
            Plan content is clipped to the presentation bound; the saved native
            artifact retains the complete content.
          </p>
        )}
        {!historical && (
          <>
            <output
              id={explanation}
              className="block text-xs text-muted-foreground"
            >
              {reason ??
                "Choose explicitly. Changing mode does not accept or implement this plan."}
            </output>
            <div className="flex flex-wrap items-start gap-2">
              {choices.map(({ decision, label, description }) => (
                <div
                  key={decision}
                  className="min-w-0 max-w-full flex-1 basis-40 space-y-1"
                >
                  <Button
                    type="button"
                    variant={decision === "implement" ? "default" : "outline"}
                    className="h-auto max-w-full whitespace-normal text-left"
                    disabled={Boolean(
                      reason ||
                        codingPlanDecisionReason(state ?? null, plan, decision),
                    )}
                    title={
                      codingPlanDecisionReason(state ?? null, plan, decision) ??
                      description
                    }
                    aria-describedby={explanation}
                    onClick={() => void run?.decidePlan(plan, decision)}
                  >
                    {label}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {!reason
                      ? (codingPlanDecisionReason(
                          state ?? null,
                          plan,
                          decision,
                        ) ?? description)
                      : description}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

/** Native mode only: never flips before ordered native state reports it. A
 * pending request is marked on its segment; nothing else is dimmed or disabled,
 * so keyboard focus stays put while native state settles. */
export function CodingModeControl({
  state,
  run,
}: { state: CodingRunState | null; run: CodingRun | null }) {
  const reason = codingModeControlReason(state);
  const mode = state?.native?.configuration.mode;
  const requested =
    state?.planControl?.kind === "mode" ? state.planControl.mode : null;
  const stale = Boolean(
    mode &&
      (state?.connection !== "connected" ||
        state.recovering ||
        state.disconnected),
  );
  return (
    <fieldset
      aria-describedby="coding-mode-explanation"
      data-requested-mode={requested ?? undefined}
      className="flex h-8 min-w-0 shrink-0 items-center rounded-full bg-muted p-0.5 text-xs dark:bg-accent"
    >
      <legend className="sr-only">Coding mode</legend>
      {(["build", "plan"] as const).map((value) => {
        const checked = mode === value;
        const pending = requested === value && !checked;
        return (
          <label
            key={value}
            title={
              reason ??
              (value === "plan"
                ? "Plan: native read-only planning"
                : "Build: native execution")
            }
            className={`relative inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${checked ? "bg-background text-foreground shadow-sm dark:bg-card" : "text-muted-foreground hover:text-foreground"} ${reason ? "cursor-not-allowed" : "cursor-pointer"}`}
          >
            <input
              type="radio"
              name="coding-mode"
              value={value}
              checked={checked}
              aria-disabled={Boolean(reason) || undefined}
              aria-busy={pending || undefined}
              onChange={() => {
                if (!reason) void run?.setMode(value);
              }}
              // Covers its segment (not sr-only): a 1px radio left the label
              // intercepting pointer clicks meant for the radio.
              className="absolute inset-0 m-0 cursor-[inherit] appearance-none rounded-full opacity-0"
            />
            {pending && (
              <LoaderCircle
                className="size-3 animate-spin"
                aria-hidden="true"
              />
            )}
            {value === "build" ? "Build" : "Plan"}
          </label>
        );
      })}
      <output
        className="sr-only"
        data-testid="coding-plan-mode"
        aria-live="polite"
      >
        Native mode: {mode ?? "not connected"}
        {stale ? " · last observed, reconnecting" : ""}
        {requested && requested !== mode
          ? ` · ${requested} requested, awaiting native state`
          : ""}
      </output>
      <span id="coding-mode-explanation" className="sr-only">
        {reason ??
          "Plan is native read-only planning. Mode selection never accepts a plan or rewrites running work."}
      </span>
    </fieldset>
  );
}
