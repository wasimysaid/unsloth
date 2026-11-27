// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ReactElement, ReactNode } from "react";
import type { CodingReach, CodingReachSummary } from "./coding-reach";

const DOT: Record<CodingReach["state"], string> = {
  available: "bg-emerald-500 dark:bg-emerald-400",
  off: "bg-muted-foreground/35",
  limited: "bg-amber-500 dark:bg-amber-400",
};

function ReachDot({ state, className }: { state: CodingReach["state"]; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT[state], className)}
    />
  );
}

/** The tab's title, as every Settings page shows it; also the search's scroll target. */
export function SettingsPageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}): ReactElement {
  return (
    <header data-settings-label={title} className="flex flex-col gap-1">
      <h1 className="font-heading text-xl font-semibold">{title}</h1>
      <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}

/** How many reach Coding, in one quiet line; nothing until the list has loaded. */
export function CodingReachLine({
  summary,
  ready,
}: {
  summary: CodingReachSummary;
  ready: boolean;
}): ReactElement | null {
  const t = useT();
  if (!ready || summary.total === 0) return null;
  return (
    <p
      data-coding-reach-line=""
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <ReachDot state={summary.available > 0 ? "available" : "off"} />
      <span className="tabular-nums">
        {t("settings.codingAgent.reachLine", {
          available: String(summary.available),
          total: String(summary.total),
        })}
      </span>
    </p>
  );
}

/** Marks a row Coding cannot use though its switch may be on. */
export function CodingLimitBadge({ label }: { label: string }): ReactElement {
  return (
    <span
      data-coding-reach="limited"
      className="inline-flex max-w-full items-center gap-1.5 text-ui-11 leading-ui-16 font-medium whitespace-nowrap text-amber-700 dark:text-amber-300"
    >
      <ReachDot state="limited" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** What an unsaved server would be limited to, beside the form's actions. */
export function CodingLimitNotice({ children }: { children: ReactNode }): ReactElement {
  return (
    <p
      role="status"
      data-coding-reach="limited"
      className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground"
    >
      <ReachDot state="limited" className="mt-[0.45em] size-2" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
