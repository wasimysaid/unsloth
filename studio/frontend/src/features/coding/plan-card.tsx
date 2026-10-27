// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import type { NativePlan, PlanDecision } from "./plan-types";
import {
  type CodingRun,
  type CodingRunState,
  codingPlanDecisionReason,
} from "./run-session";

const planLabels: Record<NativePlan["status"], string> = {
  review_pending: "Ready for review",
  saved_stopped: "Saved",
  accepted: "Accepted",
  implementing: "Implementing",
  completed: "Implemented",
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
    description: "Build it in this conversation.",
  },
  {
    decision: "implement_fresh",
    label: "Implement with fresh context",
    description: "Build it from the plan alone, with a cleared context.",
  },
  {
    decision: "save_and_stop",
    label: "Save and stop",
    description: "Keep the plan without building it yet.",
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
  const reason = historical ? null : codingPlanDecisionReason(state ?? null, plan);
  const explanation = historical ? undefined : "coding-plan-action-explanation";
  return (
    <details
      className="min-w-0 shrink-0 rounded-xl border border-border/60 bg-background text-sm dark:bg-card"
      data-testid={
        historical ? "coding-historical-plan" : "coding-current-plan"
      }
      data-plan-id={plan.id}
    >
      <summary className="cursor-pointer break-words rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">Plan: {plan.name}</span>
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
        <pre
          className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed"
          data-testid="coding-plan-content"
        >
          {plan.markdown}
        </pre>
        {historical && !plan.markdown && (
          <p className="text-xs text-muted-foreground">
            This older entry didn't record the plan text.
          </p>
        )}
        {plan.clipped && (
          <p className="text-xs text-muted-foreground">Plan clipped</p>
        )}
        {!historical && (
          <>
            {reason && (
              <output
                id={explanation}
                className="block text-xs text-muted-foreground"
              >
                {reason}
              </output>
            )}
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
                    aria-describedby={reason ? explanation : undefined}
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
