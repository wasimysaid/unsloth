// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { ListChecks } from "lucide-react";
import { useId } from "react";
import { ComposerDecision } from "./composer-decision";
import type { PlanDecision } from "./plan-types";
import {
  codingPlanDecisionReason,
  type CodingRun,
  type CodingRunState,
} from "./run-session";

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

export function PlanDecisionPrompt({
  state,
  run,
}: { state: CodingRunState; run: CodingRun }) {
  const descriptionId = useId();
  const plan = state.native?.plan;
  if (
    !plan ||
    (plan.status !== "review_pending" && plan.status !== "saved_stopped")
  )
    return null;
  const saved = plan.status === "saved_stopped";
  const reason = codingPlanDecisionReason(state, plan);
  const prompt = (
    <ComposerDecision
      icon={ListChecks}
      question="What would you like to do with this plan?"
      testId="coding-plan-decision"
    >
      <div className="-mx-2 grid gap-0.5" aria-label={plan.name} role="group">
        {choices
          .filter(({ decision }) => !saved || decision !== "save_and_stop")
          .map(({ decision, label, description }) => (
            <Button
              key={decision}
              type="button"
              variant="ghost"
              aria-label={label}
              aria-describedby={
                reason ? descriptionId : `${descriptionId}-${decision}`
              }
              disabled={Boolean(
                codingPlanDecisionReason(state, plan, decision),
              )}
              onClick={() => void run.decidePlan(plan, decision)}
              className="h-auto min-h-8 w-full flex-wrap justify-start gap-x-2 gap-y-0 rounded-md border-0 px-2 py-1 text-left whitespace-normal focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span>{label}</span>
              <span
                id={`${descriptionId}-${decision}`}
                className="text-xs font-normal text-muted-foreground"
              >
                {description}
              </span>
            </Button>
          ))}
      </div>
      {reason && (
        <output
          id={descriptionId}
          className="block text-xs text-muted-foreground"
        >
          {reason}
        </output>
      )}
    </ComposerDecision>
  );
  return saved ? (
    <details className="mx-1 mb-1">
      <summary className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Resume saved plan · {plan.name}
      </summary>
      {prompt}
    </details>
  ) : (
    prompt
  );
}
