// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { Button } from "@/components/ui/button";
import { Bot, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  childDescription,
  childKey,
  childStatusLabel,
  sameChild,
} from "./child-types";
import type { ChildView } from "./child-view";
import { ToolReport } from "./tool-report";

export function ChildActivityRows({ view }: { view: ChildView }) {
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  if (!state.attempts.length) return null;
  return (
    <section aria-label="Delegated work" className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground">
        Delegated work · inspection only
      </h2>
      {state.attempts.map((child) => (
        <button
          type="button"
          key={childKey(child)}
          data-testid="coding-child-row"
          data-child-handle={child.handle}
          data-child-attempt={child.attempt}
          aria-haspopup="dialog"
          aria-expanded={Boolean(
            state.inspection && sameChild(child, state.inspection),
          )}
          className="flex w-full min-w-0 items-start gap-2 rounded-xl border border-border/60 px-3 py-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void view.open(child)}
        >
          <Bot aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            <span className="block font-medium">
              {childDescription(child)} · attempt {child.attempt}
            </span>
            <span className="block text-muted-foreground">
              {childStatusLabel(child, state.connected)}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground">Inspect</span>
        </button>
      ))}
      {state.omitted && (
        <p className="text-xs">
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
      className="absolute inset-0 z-20 m-0 flex h-full w-full min-h-0 min-w-0 max-w-none flex-col rounded-xl border border-border bg-background p-0 text-foreground shadow-sm lg:relative lg:inset-auto lg:w-104 lg:shrink-0"
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
          {child.handle} · Attempt {child.attempt}
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
                {outcome.handle} · Attempt {outcome.attempt} · {outcome.status}
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
              className="min-w-0 space-y-1 break-words rounded-lg border border-border/50 p-2"
            >
              {row.tool ? (
                <ToolReport row={row} />
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
