// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { Button } from "@/components/ui/button";
import { Bot, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  type ChildAttempt,
  type ChildIdentity,
  childDescription,
  childKey,
  childStatusLabel,
  sameChild,
  terminalChild,
} from "./child-types";
import type { ChildView } from "./child-view";
import type { CodingRow } from "./run-types";
import { ToolReport } from "./tool-report";

function ChildButton({
  view,
  child,
  open,
  connected,
}: {
  view: ChildView;
  child: ChildAttempt;
  open: boolean;
  connected: boolean;
}) {
  const live = !child.historical && !terminalChild(child);
  return (
    <button
      type="button"
      data-testid="coding-child-row"
      data-child-handle={child.handle}
      data-child-attempt={child.attempt}
      data-reading-control={`child:${child.handle}:${child.attempt}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      className="group/child flex w-full min-w-0 items-center gap-2.5 rounded-lg py-1 pr-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground"
      onClick={() => void view.open(child)}
    >
      <Bot aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">Subagent</span>{" "}
        {childDescription(child)}
      </span>
      <span className="min-w-0 shrink-[3] truncate text-xs">
        {childStatusLabel(child, connected)}
      </span>
      {live && (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      )}
      <span className="ml-auto shrink-0 text-xs opacity-0 transition-opacity group-hover/child:opacity-100 group-focus-visible/child:opacity-100">
        Inspect
      </span>
    </button>
  );
}

/** A delegated attempt in its chronological transcript slot. The native
 * attempt observation, when present, is newer than the saved row. */
export function ChildActivityRow({
  view,
  row,
  identity,
}: {
  view: ChildView;
  row: CodingRow;
  identity: ChildIdentity;
}) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const observed = state.attempts.find((attempt) =>
    sameChild(attempt, identity),
  );
  const run = row.tool?.subagent;
  const child: ChildAttempt = observed ??
    row.child ?? {
      handle: identity.handle,
      attempt: identity.attempt,
      status: run?.status ?? "queued",
      completion_pending: false,
      cut: null,
      description: run?.description,
      profile: run?.agent,
      model: run?.model,
      presentation: run ?? null,
      historical: true,
    };
  return (
    <ChildButton
      view={view}
      child={child}
      connected={state.connected}
      open={Boolean(state.inspection && sameChild(child, state.inspection))}
    />
  );
}

/** Opens the inspector on the exact attempt a tool invocation acted on. */
export function ChildInspectLink({
  view,
  identity,
}: {
  view: ChildView;
  identity: ChildIdentity;
}) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  return (
    <button
      type="button"
      data-testid="coding-child-row"
      data-child-handle={identity.handle}
      data-child-attempt={identity.attempt}
      data-reading-control={`child-link:${identity.handle}:${identity.attempt}`}
      aria-haspopup="dialog"
      aria-expanded={Boolean(
        state.inspection && sameChild(identity, state.inspection),
      )}
      aria-label={`Inspect subagent attempt ${identity.attempt}`}
      className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground"
      onClick={() => void view.open(identity)}
    >
      Inspect
    </button>
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
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const unplaced = state.attempts.filter(
    (child) =>
      !child.historical &&
      !placed.has(`child:${child.handle}:${child.attempt}`),
  );
  if (!unplaced.length && !state.omitted) return null;
  return (
    <section aria-label="Delegated work" className="space-y-0.5">
      {unplaced.map((child) => (
        <ChildButton
          key={childKey(child)}
          view={view}
          child={child}
          connected={state.connected}
          open={Boolean(state.inspection && sameChild(child, state.inspection))}
        />
      ))}
      {state.omitted && (
        <p className="text-xs text-muted-foreground">
          Older agent rows omitted from this bounded projection. Load earlier
          native history to inspect older work.
        </p>
      )}
    </section>
  );
}

/** Non-modal right-hand panel; at narrow widths it covers only the transcript,
 * leaving the main-session composer/Stop and connection feedback available. */
export function ChildInspector({ view }: { view: ChildView }) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const inspection = state.inspection;
  const child = state.attempts.find(
    (attempt) => inspection && sameChild(attempt, inspection),
  );
  const closeButton = useRef<HTMLButtonElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const open = Boolean(inspection);
  const key = inspection ? childKey(inspection) : null;
  useEffect(() => {
    if (!open) return;
    invoker.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const transcript = document.querySelector<HTMLElement>(
      '[data-testid="coding-transcript"]',
    );
    const media = window.matchMedia("(max-width: 1023px)");
    const apply = () => {
      if (transcript) transcript.inert = media.matches;
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      if (transcript) transcript.inert = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    return () => {
      if (invoker.current?.isConnected) invoker.current.focus();
      else {
        const identity = invoker.current?.dataset;
        const rows = document.querySelectorAll<HTMLElement>(
          '[data-testid="coding-child-row"]',
        );
        const replacement = Array.from(rows).find(
          (row) =>
            row.dataset.childHandle === identity?.childHandle &&
            row.dataset.childAttempt === identity?.childAttempt,
        );
        const fallback = document.querySelector<HTMLElement>(
          '[aria-label="Coding prompt"]',
        );
        (replacement ?? fallback)?.focus();
      }
    };
  }, [open]);
  useEffect(() => {
    if (key) closeButton.current?.focus();
  }, [key]);
  if (!inspection || !child) return null;
  const outcome = inspection.outcome;
  const presentations = child.presentation;
  const status = outcome
    ? `${outcome.status} · retained native outcome`
    : childStatusLabel(child, state.connected);
  return (
    <dialog
      open={true}
      aria-modal="false"
      aria-label="Subagent inspector"
      aria-describedby="coding-child-inspection-description"
      data-testid="coding-child-inspector"
      data-child-handle={child.handle}
      data-child-attempt={child.attempt}
      className="absolute inset-0 z-20 m-0 flex h-full w-full min-h-0 min-w-0 max-w-none flex-col rounded-2xl border border-border/70 bg-background p-0 text-foreground shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] lg:relative lg:inset-auto lg:w-104 lg:shrink-0 dark:bg-card"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          view.close();
        }
      }}
    >
      <header className="shrink-0 space-y-2 border-b border-border/60 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h2 className="min-w-0 break-words text-sm font-semibold">
            {childDescription(child)}
          </h2>
          <Button
            ref={closeButton}
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            aria-label="Close subagent inspector"
            onClick={() => view.close()}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <p className="break-all font-mono text-[11px]">
          Attempt {child.attempt}
        </p>
        <output className="block text-xs font-medium" aria-live="polite">
          {status}
        </output>
        <p
          id="coding-child-inspection-description"
          className="text-xs text-muted-foreground"
        >
          Inspection only. Mimir controls delegation; Stop below cancels the
          main coding request.
        </p>
        {!state.connected && (
          <output className="block text-xs font-medium">
            Disconnected or reconstructing · saved output is not proof that work
            stopped.
          </output>
        )}
        <nav aria-label="Subagent attempts" className="flex flex-wrap gap-1">
          {state.attempts
            .filter((item) => item.handle === child.handle)
            .map((item) => (
              <Button
                key={childKey(item)}
                size="sm"
                variant={sameChild(item, child) ? "secondary" : "ghost"}
                aria-current={sameChild(item, child) ? "true" : undefined}
                onClick={() => void view.open(item)}
              >
                Attempt {item.attempt}
              </Button>
            ))}
        </nav>
      </header>
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
        data-testid="coding-child-content"
      >
        {inspection.loading && (
          <output className="block text-xs">
            Loading bounded native child history and retained outcome…
          </output>
        )}
        {inspection.error && (
          <div className="space-y-2">
            <p role="alert" className="break-words text-xs">
              {inspection.error}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void view.open(child)}
            >
              Retry inspection
            </Button>
          </div>
        )}
        <section aria-label="Subagent activity" className="space-y-1 text-xs">
          <h3 className="font-medium">Activity</h3>
          <p className="break-words">
            {presentations?.phase || "No current activity detail reported."}
          </p>
          {presentations && (
            <p className="text-muted-foreground">
              {presentations.turns ?? 0} turns · {presentations.tool_uses ?? 0}{" "}
              tool uses · {presentations.tokens ?? 0} tokens
            </p>
          )}
          {child.model && (
            <p className="break-all text-muted-foreground">
              Model: {child.model}
            </p>
          )}
          {(child.clipped || child.oversized) && (
            <p>
              Agent details exceed the view bound; supported native details are
              loaded separately and may be clipped.
            </p>
          )}
        </section>
        <section
          aria-label="Subagent retained result"
          className="space-y-2 text-xs"
        >
          <h3 className="font-medium">Retained result</h3>
          {outcome ? (
            <>
              <p className="break-all font-mono">
                Attempt {outcome.attempt} · {outcome.status}
              </p>
              {outcome.result !== null && (
                <pre
                  className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 font-mono"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded native output must support keyboard scrolling.
                  tabIndex={0}
                  aria-label="Retained child result"
                >
                  {outcome.result || "Empty native result."}
                </pre>
              )}
              {outcome.error !== null && (
                <pre
                  className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 font-mono"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded native output must support keyboard scrolling.
                  tabIndex={0}
                  aria-label="Retained child error"
                >
                  {outcome.error}
                </pre>
              )}
              {(outcome.result_clipped || outcome.error_clipped) && (
                <p role="note" className="font-medium">
                  Result/error clipped to the inspection bound; this is not the
                  complete content.
                </p>
              )}
            </>
          ) : (
            <p>
              {child.historical
                ? "No retained outcome available yet for this exact historical attempt."
                : "No terminal outcome observed for this exact attempt. Launch acceptance is not completion."}
            </p>
          )}
        </section>
        <section aria-label="Subagent transcript" className="space-y-2 text-xs">
          <h3 className="font-medium">Transcript</h3>
          <p className="text-muted-foreground">
            Child journal through this captured cut; continued attempts may
            include earlier context. Historical text is not live activity.
          </p>
          {!inspection.cut && (
            <p>
              Transcript cut is unavailable for this historical attempt. A later
              attempt’s journal is not substituted.
            </p>
          )}
          {inspection.earlier && (
            <p className="font-medium">
              Historical page · newer child activity is not shown.
            </p>
          )}
          {inspection.older && (
            <Button
              variant="outline"
              size="sm"
              disabled={inspection.loadingEarlier || !state.connected}
              onClick={() => void view.loadEarlier()}
            >
              {inspection.loadingEarlier
                ? "Loading earlier child history…"
                : "Load earlier child history"}
            </Button>
          )}
          {inspection.earlier && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void view.showLatest()}
            >
              Latest child history
            </Button>
          )}
          {inspection.bounded && (
            <p role="note">
              Older content omitted to keep this inspector bounded.
            </p>
          )}
          {inspection.rows.map((row) => (
            <div
              key={row.id}
              className="min-w-0 space-y-1 break-words rounded-xl border border-border/40 px-2 py-1"
            >
              {row.tool ? (
                <ToolReport row={row} itemKey={`child-row:${row.id}`} />
              ) : (
                <>
                  <p className="font-medium text-muted-foreground">
                    {row.kind === "user"
                      ? "Task input"
                      : row.kind === "assistant"
                        ? "Subagent"
                        : "Native activity"}
                    {row.historical ? " · historical" : ""}
                  </p>
                  <p className="whitespace-pre-wrap">{row.text}</p>
                </>
              )}
              {row.clipped && (
                <p className="font-medium">
                  Content clipped to the presentation bound.
                </p>
              )}
            </div>
          ))}
          {inspection.cut && !inspection.loading && !inspection.rows.length && (
            <p>No public transcript entries available at this cut.</p>
          )}
        </section>
      </div>
    </dialog>
  );
}
