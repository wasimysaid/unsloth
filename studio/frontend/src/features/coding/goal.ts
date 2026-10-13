// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { CodingRunState } from "./run-session.ts";
import type { GoalAction } from "./run-types.ts";

export const goalActionLabels: Record<GoalAction, string> = {
  start: "Start goal",
  edit: "Edit goal",
  pause: "Pause goal",
  resume: "Resume goal",
  clear: "Clear goal",
};

/** A completed ordinary request or a model claim never verifies a goal. */
export function codingGoalLabel(state: CodingRunState): string {
  const goal = state.native?.goal;
  if (state.connection !== "connected" || state.recovering)
    return "Goal state unconfirmed";
  if (!goal) return "No autonomous goal";
  if (goal.phase === "complete")
    return goal.completion
      ? "Independently verified completion"
      : "Completion verification unavailable";
  if (goal.phase === "cleared") return "Goal cleared";
  if (goal.cause === "restart") return "Interrupted · explicit resume required";
  if (goal.phase === "paused") return "Goal paused";
  if (goal.phase === "blocked") return "Goal blocked";
  return state.native?.active_request
    ? "Goal running"
    : "Goal active · not verified complete";
}

export function goalActionDisabledReason(
  state: CodingRunState,
  action: GoalAction,
): string | null {
  if (state.connection !== "connected" || state.recovering)
    return "Wait for a connected, reconstructed native goal state.";
  if (state.goalChanging)
    return "A goal action is awaiting native admission. Stop remains available.";
  if (state.reconcilingGoal)
    return "Inspecting a fresh native goal state; no action is replayed.";
  if (state.stopping || state.reconcilingAction)
    return "Wait for main-session Stop and terminal cleanup to be confirmed.";
  if (state.submitting || state.uncertainSubmission)
    return "Reconcile the pending prompt before changing the goal.";
  if (state.configuring || state.configurationUncertain)
    return "Reconcile the pending model configuration before changing the goal.";
  if (state.commandBusy || state.uncertainCommand || state.storageError)
    return "Resolve pending native command delivery before changing the goal.";
  if (state.overlapWarning)
    return "Resolve the project overlap warning before changing the goal.";
  const admission = state.native?.goal_controls?.actions.find(
    (item) => item.action === action,
  );
  return admission?.admitted
    ? null
    : (admission?.reason ??
        "Native goal management is unavailable. Reopen with a compatible runtime.");
}
