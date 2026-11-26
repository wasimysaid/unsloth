// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import { useState } from "react";
import type { NativePlan } from "./plan-types";

const planLabels: Record<NativePlan["status"], string> = {
  review_pending: "Ready for review",
  saved_stopped: "Saved",
  accepted: "Accepted",
  implementing: "Implementing",
  completed: "Implemented",
  abandoned: "Abandoned",
};

export function PlanCard({
  plan,
  current = false,
}: { plan: NativePlan; current?: boolean }) {
  const [open, setOpen] = useState(current);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 rounded-xl inset-ring inset-ring-border/60 bg-background text-sm dark:bg-card"
      data-testid={current ? "coding-current-plan" : "coding-historical-plan"}
      data-plan-id={plan.id}
    >
      <summary
        className="cursor-pointer break-words rounded-xl px-5.5 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={plan.path || undefined}
      >
        <span className="font-medium">
          {current && open && plan.markdown ? "Plan" : plan.name}
        </span>
        <span className="ml-2 text-xs text-muted-foreground">
          {planLabels[plan.status]}
        </span>
      </summary>
      {open && (
        <div className="min-w-0 px-5.5 pb-3" data-testid="coding-plan-content">
          {plan.markdown ? (
            <MarkdownPreview
              markdown={plan.markdown}
              className="max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-sm leading-relaxed"
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              This entry didn't record the plan text.
            </p>
          )}
          {plan.clipped && (
            <p className="text-xs text-muted-foreground">Plan clipped</p>
          )}
        </div>
      )}
    </details>
  );
}
