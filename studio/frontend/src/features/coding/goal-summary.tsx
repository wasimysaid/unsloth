// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState } from "react";
import {
  codingGoalLabel,
  goalActionDisabledReason,
  goalActionLabels,
} from "./goal";
import type { CodingRun, CodingRunState } from "./run-session";
import type { GoalAction } from "./run-types";

const actions: GoalAction[] = ["start", "edit", "pause", "resume", "clear"];

/** Compact native state above the transcript; opening it never executes work. */
export function GoalSummary({
  state,
  run,
  defaultOpen = false,
}: { state: CodingRunState; run: CodingRun; defaultOpen?: boolean }) {
  const goal = state.native?.goal;
  const controls = state.native?.goal_controls;
  // Reuse the captured public tool report, never decode private result JSON or
  // treat a conversation-level progress checklist as goal verification.
  const progressReport = state.rows
    .slice()
    .reverse()
    .find(
      (row) =>
        row.tool?.name === "update_status" &&
        row.tool.status === "completed" &&
        row.tool.output,
    );
  const [draft, setDraft] = useState<{
    action: "start" | "edit";
    revision: string;
    objective: string;
  } | null>(null);
  const summary = useRef<HTMLElement>(null);
  const objectiveInput = useRef<HTMLTextAreaElement>(null);
  const draftAction = draft?.action;
  useEffect(() => {
    if (draftAction) objectiveInput.current?.focus();
  }, [draftAction]);
  const prefix = useId();
  const stale = Boolean(draft && draft.revision !== controls?.revision);
  const closeDraft = () => {
    setDraft(null);
    summary.current?.focus();
  };
  return (
    <details
      className="shrink-0 min-w-0 rounded-2xl border border-border/60 bg-background text-xs dark:bg-card"
      data-testid="coding-goal"
      open={defaultOpen || undefined}
      data-goal-revision={controls?.revision}
    >
      <summary
        ref={summary}
        className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl px-3.5 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Autonomous goal details"
      >
        <span
          className="font-medium"
          data-testid="coding-goal-status"
          aria-live="polite"
        >
          {codingGoalLabel(state)}
        </span>
        {goal && (
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={goal.objective}
          >
            {goal.objective}
          </span>
        )}
        <span className="text-muted-foreground">Checklist & controls</span>
      </summary>
      <div
        className="max-h-[40vh] space-y-3 overflow-y-auto break-words border-t border-border/50 p-3"
        data-testid="coding-goal-details"
      >
        {goal ? (
          <>
            <p
              className="whitespace-pre-wrap font-medium"
              data-testid="coding-goal-objective"
            >
              {goal.objective}
            </p>
            <p>
              Native phase: {goal.phase} · Cause: {goal.cause} · Work turns:{" "}
              {goal.work_turns}
            </p>
            {goal.display_clipped && (
              <p role="note" data-testid="coding-goal-clipped">
                Goal display clipped to the native public bound. This is only
                part of the objective, review details or completion evidence;
                native records remain unchanged.{" "}
                {goal.completion?.omitted_checklist_entries
                  ? `${goal.completion.omitted_checklist_entries} checklist entries omitted.`
                  : ""}
              </p>
            )}
            {goal.reason && <p>Reason: {goal.reason}</p>}
            {goal.review_gap && (
              <p data-testid="coding-goal-review-gap">
                Independent review gap: {goal.review_gap}
              </p>
            )}
            {goal.completion && goal.phase === "complete" ? (
              <section
                aria-label="Independently verified goal checklist"
                className="space-y-2"
              >
                <h3 className="font-medium">
                  Independently verified checklist
                </h3>
                <ol className="list-inside list-decimal space-y-2">
                  {goal.completion.checklist.map((item) => (
                    <li key={`${item.requirement}:${item.evidence}`}>
                      <span className="font-medium">{item.requirement}</span>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        Evidence: {item.evidence}
                      </p>
                    </li>
                  ))}
                </ol>
                {goal.completion.limitations && (
                  <p>Verification limitations: {goal.completion.limitations}</p>
                )}
                <p className="text-muted-foreground">
                  Verified at {goal.completion.completed_at}
                </p>
              </section>
            ) : (
              <p className="text-muted-foreground">
                Not independently verified complete. Work-status checklists in
                native tool activity are progress reports, not completion
                evidence.
              </p>
            )}
            {goal.cause === "restart" && (
              <p>
                Reopened work does not auto-resume. Inspect the interrupted
                state and explicitly resume when admitted.
              </p>
            )}
          </>
        ) : (
          <p>
            Mimir owns autonomous execution and independent completion review.
            Starting a goal begins native work.
          </p>
        )}
        {progressReport?.tool && (
          <section
            aria-label="Latest visible native work-status checklist"
            className="space-y-1"
          >
            <h3 className="font-medium">
              Latest visible conversation work-status report · not verification
            </h3>
            <p className="text-muted-foreground">
              {progressReport.historical
                ? "Historical public report"
                : "Public progress report"}{" "}
              · not necessarily goal-specific; earlier reports may be outside
              this bounded view.
            </p>
            <pre
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded public output needs keyboard scrolling.
              tabIndex={0}
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2"
              data-testid="coding-goal-progress-report"
            >
              {progressReport.tool.output}
            </pre>
            {progressReport.tool.clipped && (
              <p>Report clipped; this is not the complete checklist.</p>
            )}
          </section>
        )}
        <div className="flex flex-wrap gap-2" aria-label="Native goal controls">
          {actions.map((action) => {
            const disabled = goalActionDisabledReason(state, action);
            return (
              <div key={action} className="min-w-0 max-w-full">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={Boolean(disabled)}
                  aria-describedby={
                    disabled ? `${prefix}-${action}` : undefined
                  }
                  onClick={() => {
                    if (!controls) return;
                    if (action === "start" || action === "edit")
                      setDraft({
                        action,
                        revision: controls.revision,
                        objective:
                          action === "edit" && !goal?.display_clipped
                            ? (goal?.objective ?? "")
                            : "",
                      });
                    else
                      void run.changeGoal({
                        action,
                        revision: controls.revision,
                      });
                  }}
                >
                  {state.goalChanging === action
                    ? "Awaiting native admission…"
                    : goalActionLabels[action]}
                </Button>
                {disabled && (
                  <p
                    id={`${prefix}-${action}`}
                    className="mt-1 max-w-56 text-[11px] text-muted-foreground"
                  >
                    {disabled}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {draft && (
          <form
            className="space-y-2"
            aria-label={
              draft.action === "start"
                ? "Start autonomous goal"
                : "Edit autonomous goal"
            }
            onSubmit={(event) => {
              event.preventDefault();
              void run
                .changeGoal({
                  action: draft.action,
                  revision: draft.revision,
                  objective: draft.objective,
                })
                .then((accepted) => {
                  if (accepted) closeDraft();
                });
            }}
          >
            <label className="block space-y-1">
              <span>Goal objective</span>
              <textarea
                ref={objectiveInput}
                aria-label="Goal objective"
                className="min-h-20 w-full rounded-lg border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={65536}
                value={draft.objective}
                onChange={(event) =>
                  setDraft({ ...draft, objective: event.target.value })
                }
              />
            </label>
            {draft.action === "edit" && goal?.display_clipped && (
              <p>
                Native objective display may be partial. Enter the full
                replacement objective; clipped text is never automatically
                reused.
              </p>
            )}
            {stale && (
              <p role="alert">
                Goal state changed. This draft is retained but its controls are
                stale. Cancel and choose the action again against the current
                native state.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={
                  stale ||
                  !draft.objective.trim() ||
                  Boolean(goalActionDisabledReason(state, draft.action))
                }
              >
                Confirm {draft.action === "start" ? "start" : "edit"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={closeDraft}
              >
                Cancel goal draft
              </Button>
            </div>
          </form>
        )}
        {state.goalNotice && (
          <output className="block" data-testid="coding-goal-notice">
            {state.goalNotice}
          </output>
        )}
        <p className="text-muted-foreground">
          Pause/clear interrupt only goal-owned work; acknowledgment is not
          terminal cleanup. Main-session Stop remains the separate exact-request
          cleanup control. An ordinary turn ending or accepted command is not
          verified goal completion.
        </p>
      </div>
    </details>
  );
}
