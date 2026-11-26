// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ChevronDownStandardIcon } from "@/lib/chevron-icons";
import { TrashIcon } from "@/lib/hugeicons-derived";
import { MenuTickIcon } from "@/lib/tick-icon";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { FollowUpDelivery } from "./input";
import { FOLLOW_UP_DELIVERIES } from "./use-follow-up-delivery";
import type { CodingRun, CodingRunState } from "./run-session";

/** Composer pill choosing how a message typed during a run is delivered. */
export function FollowUpMenu({
  delivery,
  onChoose,
  shortcut,
}: {
  delivery: FollowUpDelivery;
  onChoose: (delivery: FollowUpDelivery) => void;
  shortcut: string;
}) {
  const active = FOLLOW_UP_DELIVERIES[delivery];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild={true}>
        <button
          type="button"
          className="composer-pill-btn"
          data-pill-label={active.label}
          data-testid="coding-follow-up-menu"
          aria-label={`Messages while working: ${active.label}`}
          title={`${active.label}: ${active.description}`}
        >
          <span className="composer-pill-glyph">
            <active.icon
              className="size-[calc(15px*var(--ui-space-scale,1))]"
              aria-hidden="true"
            />
          </span>
          <span>{active.label}</span>
          <HugeiconsIcon
            icon={ChevronDownStandardIcon}
            strokeWidth={1.5}
            className="composer-pill-caret size-[calc(15px*var(--ui-space-scale,1))]"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={0}
        avoidCollisions={true}
        className="unsloth-plus-menu w-[calc(300px*var(--ui-space-scale,1))]"
      >
        <DropdownMenuLabel>Messages while working</DropdownMenuLabel>
        {(Object.keys(FOLLOW_UP_DELIVERIES) as FollowUpDelivery[]).map(
          (value) => {
            const option = FOLLOW_UP_DELIVERIES[value];
            return (
              <DropdownMenuItem
                key={value}
                onSelect={() => onChoose(value)}
                className={cn(
                  "items-start gap-2 py-2",
                  value === delivery && "font-medium",
                )}
              >
                <option.icon
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-ui-13 leading-tight">
                    {option.label}
                  </span>
                  <span className="text-xs font-normal leading-snug text-muted-foreground">
                    {option.description}
                    {value !== delivery && (
                      <span className="pointer-coarse:hidden">
                        {` · ${shortcut} for one message`}
                      </span>
                    )}
                  </span>
                </span>
                {value === delivery && (
                  <HugeiconsIcon
                    icon={MenuTickIcon}
                    strokeWidth={2}
                    className="ml-auto size-4 shrink-0 self-center"
                  />
                )}
              </DropdownMenuItem>
            );
          },
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Follow-ups Mimir holds for the running conversation, oldest first. */
export function PendingFollowUps({
  state,
  run,
}: {
  state: CodingRunState;
  run: CodingRun;
}) {
  const [withdrawing, setWithdrawing] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [announcement, setAnnouncement] = useState("");
  const pending = (state.native?.requests ?? []).flatMap((request) =>
    request.pending_follow_up
      ? [{ id: request.id, ...request.pending_follow_up }]
      : [],
  );
  if (!pending.length) return null;
  const connected = state.connection === "connected";
  const withdraw = (id: string) => {
    setWithdrawing((ids) => new Set(ids).add(id));
    void run
      .withdrawFollowUp(id)
      .then((withdrawn) =>
        setAnnouncement(
          withdrawn
            ? "Message withdrawn."
            : "It was already delivered, so it could not be withdrawn.",
        ),
      )
      .catch((reason: unknown) =>
        setAnnouncement(
          reason instanceof Error ? reason.message : "Withdraw failed.",
        ),
      )
      .finally(() =>
        setWithdrawing((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        }),
      );
  };
  return (
    <div
      data-queue-frame=""
      data-testid="coding-pending-follow-ups"
      className="relative z-0 mx-3 -mb-2 overflow-hidden rounded-t-xl border border-border/60 bg-background sm:mx-5 dark:bg-[color-mix(in_srgb,var(--card)_50%,var(--background))]"
    >
      <div className="max-h-[28dvh] overflow-y-auto px-1.5 pt-1 pb-3 text-muted-foreground sm:px-2">
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
        <ul aria-label="Messages waiting for the running work">
          {pending.map((item, index) => {
            const option = FOLLOW_UP_DELIVERIES[item.delivery];
            const busy = withdrawing.has(item.id);
            return (
              <li
                key={item.id}
                data-follow-up={item.delivery}
                className="flex min-h-8 items-center gap-1 rounded-lg pointer-coarse:min-h-11"
              >
                <option.icon
                  className="ml-1 size-4 shrink-0 text-muted-foreground/60"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate px-1.5 text-sm text-foreground/80">
                  {item.preview}
                </span>
                <span className="shrink-0 px-1 text-xs text-muted-foreground">
                  {option.pending}
                </span>
                <TooltipIconButton
                  type="button"
                  tooltip="Withdraw"
                  tooltipClassName="prompt-queue-option-tooltip pointer-events-none"
                  aria-label={`Withdraw ${option.pending.toLowerCase()} message ${index + 1}`}
                  disabled={!connected || busy}
                  className="size-7 shrink-0 border-0 text-muted-foreground shadow-none hover:text-destructive pointer-coarse:size-11"
                  onClick={() => withdraw(item.id)}
                >
                  {busy ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <HugeiconsIcon icon={TrashIcon} strokeWidth={1.8} />
                  )}
                </TooltipIconButton>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
