// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { ChevronDown, ListChecks, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { ComposerDecision } from "./composer-decision";
import { ModelTargetPicker } from "./model-target-picker";
import {
  type CodingTarget,
  exactTargetName,
  friendlyModelName,
  useCodingTargets,
} from "./model-targets";
import type { NativePlan, PlanDecision } from "./plan-types";
import {
  codingPlanDecisionReason,
  type CodingRun,
  type CodingRunState,
} from "./run-session";
import { codingSession } from "./shared-session";

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
  const plan = state.native?.plan;
  if (
    !plan ||
    (plan.status !== "review_pending" && plan.status !== "saved_stopped")
  )
    return null;
  // A new revision starts over on the current model.
  return (
    <PlanDecisionChoices
      key={`${plan.id}:${plan.revision}`}
      state={state}
      run={run}
      plan={plan}
    />
  );
}

function PlanDecisionChoices({
  state,
  run,
  plan,
}: { state: CodingRunState; run: CodingRun; plan: NativePlan }) {
  const descriptionId = useId();
  const origin = state.native?.configuration ?? null;
  // `null` implements here on the current model; a target starts a new Build conversation.
  const [target, setTarget] = useState<CodingTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const targets = useCodingTargets(
    state.native?.info.id ?? null,
    origin,
    picking || target !== null,
  );
  const saved = plan.status === "saved_stopped";
  const reason = codingPlanDecisionReason(state, plan);
  const decide = (decision: PlanDecision) => {
    if (decision !== "implement_fresh" || !target) {
      void run.decidePlan(plan, decision);
      return;
    }
    setStarting(true);
    void codingSession
      .implementPlanWithModel(state, plan, {
        provider: target.provider,
        model: target.model,
      })
      // Success replaces this conversation's view; failure shows on the page.
      .finally(() => setStarting(false));
  };
  const prompt = (
    <ComposerDecision
      icon={ListChecks}
      question="What would you like to do with this plan?"
      testId="coding-plan-decision"
    >
      <div className="-mx-2 grid gap-0.5" aria-label={plan.name} role="group">
        {choices
          .filter(({ decision }) => !saved || decision !== "save_and_stop")
          .map(({ decision, label, description }, index) => {
            const fresh = decision === "implement_fresh";
            const elsewhere = fresh && target;
            const shownLabel = elsewhere
              ? `Implement with ${friendlyModelName(target.name)}`
              : label;
            const button = (
              <Button
                key={decision}
                type="button"
                variant="ghost"
                aria-label={shownLabel}
                aria-describedby={
                  reason ? descriptionId : `${descriptionId}-${decision}`
                }
                disabled={
                  starting ||
                  Boolean(codingPlanDecisionReason(state, plan, decision))
                }
                data-decision={decision}
                title={elsewhere ? exactTargetName(target) : undefined}
                onClick={() => decide(decision)}
                className="h-auto min-h-8 w-full min-w-0 flex-1 justify-start gap-2 rounded-md border-0 px-2 py-1 text-left whitespace-normal focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs leading-none font-semibold text-muted-foreground tabular-nums"
                >
                  {starting && elsewhere ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 break-words">{shownLabel}</span>
                  <span
                    id={`${descriptionId}-${decision}`}
                    className="text-xs font-normal text-muted-foreground"
                  >
                    {elsewhere
                      ? "Starts a new Build conversation from this plan."
                      : description}
                  </span>
                </span>
              </Button>
            );
            if (!fresh) return button;
            return (
              <div key={decision} className="flex min-w-0 items-center gap-1">
                {button}
                <ModelTargetPicker
                  targets={targets}
                  origin={origin}
                  value={target}
                  onChange={setTarget}
                  open={picking}
                  onOpenChange={setPicking}
                  includeOrigin={true}
                  label="Search models to implement with"
                  align="end"
                >
                  <button
                    type="button"
                    disabled={starting}
                    aria-label={`Change the model for fresh context. Now: ${target ? exactTargetName(target) : `current model, ${targets.originName}`}`}
                    title={
                      target
                        ? exactTargetName(target)
                        : `Current model: ${targets.originName}`
                    }
                    data-testid="coding-plan-fresh-model"
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground pointer-coarse:h-11"
                  >
                    Change
                    <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                  </button>
                </ModelTargetPicker>
              </div>
            );
          })}
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
