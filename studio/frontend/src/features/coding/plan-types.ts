// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export type CodingMode = "build" | "plan";
export type PlanDecision = "implement" | "implement_fresh" | "save_and_stop";
export interface NativePlan {
  id: string;
  name: string;
  path: string;
  markdown: string;
  status:
    | "review_pending"
    | "saved_stopped"
    | "accepted"
    | "implementing"
    | "completed"
    | "abandoned";
  revision: string;
  clipped?: boolean;
  action_disabled_reason?: string | null;
}

export function planDisabledExplanation(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return (
    (
      {
        busy: "Native work is busy. Wait for running, queued, tool and child work to settle.",
        plan_finished:
          "This plan has finished. Start a new planning request to propose another plan.",
        plan_already_accepted:
          "Implementation was already admitted for this plan; it will not be replayed.",
        plan_file_unavailable:
          "The native plan file is unavailable. The saved plan record remains readable.",
        plan_content_clipped:
          "The current plan exceeds the action presentation bound. Inspect the complete native artifact before choosing through a native frontend.",
      } as Record<string, string>
    )[reason] ?? reason
  );
}
export interface PlanActionResult {
  conversation_id: string;
  plan_id: string;
  decision: PlanDecision;
  request_id: string | null;
}
export type PendingPlanControl =
  | { kind: "mode"; mode: CodingMode }
  | { kind: "plan"; plan_id: string; revision: string; decision: PlanDecision };
