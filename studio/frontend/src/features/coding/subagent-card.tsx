// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { ArrowUpRight, Bot, LoaderCircle } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  type ChildAttempt,
  type ChildIdentity,
  type ChildStatus,
  childKey,
  sameChild,
} from "./child-types";
import type { ChildView } from "./child-view";
import type { CodingRow } from "./run-types";

const statusLabel: Partial<Record<ChildStatus, string>> = {
  failed: "Failed",
  deadline: "Timed out",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

/** A delegated agent: its own bordered card, never a row in a tool tree. */
export function SubagentCard({
  description,
  model,
  status,
  identity,
  view,
  open,
}: {
  description: string;
  model?: string | null;
  status: ChildStatus;
  identity: ChildIdentity | null;
  view: ChildView | null;
  open: boolean;
}) {
  const running = status === "queued" || status === "running";
  const problem = statusLabel[status];
  const inspectable = Boolean(identity && view);
  return (
    <button
      type="button"
      data-testid="coding-child-row"
      data-child-handle={identity?.handle}
      data-child-attempt={identity?.attempt}
      data-child-status={status}
      data-reading-control={
        identity ? `child:${identity.handle}:${identity.attempt}` : undefined
      }
      aria-haspopup={inspectable ? "dialog" : undefined}
      aria-expanded={inspectable ? open : undefined}
      aria-label={`Agent ${description}${problem ? ` · ${problem}` : running ? " · running" : ""}`}
      disabled={!inspectable}
      onClick={() => {
        if (identity) void view?.open(identity);
      }}
      className={`group/agent flex h-8.5 w-full min-w-0 items-center gap-2 rounded-[9px] border px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${problem ? "border-destructive/20 bg-destructive/[0.04]" : "border-border coding-wash-faint enabled:hover:coding-wash"} ${open ? "coding-wash" : ""}`}
    >
      <span className="flex size-4.5 shrink-0 items-center justify-center rounded-[5px] coding-wash-strong">
        <Bot
          className={`size-3 ${problem ? "text-destructive" : "text-foreground/80"}`}
          aria-hidden="true"
        />
      </span>
      <span className="shrink-0 font-medium text-muted-foreground">Agent</span>
      <span className="min-w-0 flex-1 truncate text-foreground/85">
        {description}
      </span>
      {model && (
        <span className="hidden min-w-0 max-w-[30%] shrink truncate text-[11px] text-muted-foreground/70 sm:block">
          {model}
        </span>
      )}
      {problem && (
        <span className="shrink-0 text-[11px] text-destructive">{problem}</span>
      )}
      {running && (
        <LoaderCircle
          className="size-3 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      )}
      {inspectable && (
        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-[5px] coding-wash text-muted-foreground group-hover/agent:text-foreground">
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

const describe = (child: ChildAttempt) =>
  child.description ||
  child.presentation?.description ||
  child.profile ||
  "Delegated work";

function useChildView(view: ChildView | null) {
  return useSyncExternalStore(
    view?.subscribe ?? (() => () => {}),
    view?.getSnapshot ?? (() => null),
    view?.getSnapshot ?? (() => null),
  );
}

/** A subagent spawn call or delegated attempt in its chronological slot. The
 * native attempt observation, when present, is newer than the saved row. */
export function SubagentRow({
  row,
  identity,
  view,
}: {
  row: CodingRow;
  identity: ChildIdentity | null;
  view: ChildView | null;
}) {
  const state = useChildView(view);
  const observed =
    identity && state?.attempts.find((attempt) => sameChild(attempt, identity));
  const run = row.tool?.subagent ?? row.child?.presentation;
  const child = observed || row.child;
  // Before an attempt exists, the launch call's own status is the agent's.
  const launch = row.tool?.status;
  const status: ChildStatus =
    child?.status ??
    run?.status ??
    (launch === "failed"
      ? "failed"
      : launch === "cancelled"
        ? "stopped"
        : launch === "running"
          ? "running"
          : launch === "interrupted"
            ? "interrupted"
            : "completed");
  return (
    <SubagentCard
      description={
        child
          ? describe(child)
          : run?.description ||
            run?.agent ||
            row.tool?.title.replace(/^[^:]{1,40}: /, "") ||
            "Agent"
      }
      model={child?.model ?? run?.model}
      status={status}
      identity={identity}
      view={view}
      open={Boolean(
        identity && state?.inspection && sameChild(identity, state.inspection),
      )}
    />
  );
}

/** Live attempts the native view reported before any transcript row names them. */
export function ChildActivityRows({
  view,
  placed,
}: {
  view: ChildView;
  placed: ReadonlySet<string>;
}) {
  const state = useSyncExternalStore(
    view.subscribe,
    view.getSnapshot,
    view.getSnapshot,
  );
  const unplaced = state.attempts.filter(
    (child) =>
      !child.historical &&
      !placed.has(`child:${child.handle}:${child.attempt}`),
  );
  if (!unplaced.length) return null;
  return (
    <section aria-label="Delegated work" className="space-y-1.5">
      {unplaced.map((child) => (
        <SubagentCard
          key={childKey(child)}
          description={describe(child)}
          model={child.model}
          status={child.status}
          identity={child}
          view={view}
          open={Boolean(state.inspection && sameChild(child, state.inspection))}
        />
      ))}
    </section>
  );
}
