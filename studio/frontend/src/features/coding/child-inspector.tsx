// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import { Button } from "@/components/ui/button";
import { Bot, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  childDescription,
  childKey,
  sameChild,
  terminalChild,
} from "./child-types";
import type { ChildView } from "./child-view";
import { DisclosureMemory } from "./tool-report";
import { TranscriptBlocks } from "./transcript";
import {
  type TranscriptBlock,
  createTranscriptProjection,
} from "./transcript-model";

/** The delegated brief is long and structured; show its objective, collapsed. */
function TaskBrief({ text }: { text: string }) {
  const objective =
    /## Objective\s*\n([^\n]+)/.exec(text)?.[1]?.trim() ||
    text.trim().split("\n")[0];
  return (
    <details className="group/task min-w-0 rounded-lg bg-muted/50 text-xs dark:bg-accent/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="shrink-0 font-medium text-muted-foreground">Task</span>
        <span className="min-w-0 truncate">{objective}</span>
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-sans text-xs leading-5 text-muted-foreground">
        {text}
      </pre>
    </details>
  );
}

/** Consecutive transcript blocks between task inputs. */
type TaskBlock = Extract<TranscriptBlock, { kind: "user" }>;
function segments(blocks: readonly TranscriptBlock[]) {
  const parts: (TaskBlock | TranscriptBlock[])[] = [];
  for (const block of blocks) {
    if (block.kind === "user") parts.push(block);
    else if (Array.isArray(parts.at(-1)))
      (parts.at(-1) as TranscriptBlock[]).push(block);
    else parts.push([block]);
  }
  return parts;
}

const statusText: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  deadline: "Timed out",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

/** Non-modal right-hand panel; at narrow widths it covers only the transcript,
 * leaving the main-session composer/Stop and connection feedback available. */
export function ChildInspector({ view }: { view: ChildView }) {
  const state = useSyncExternalStore(
    view.subscribe,
    view.getSnapshot,
    view.getSnapshot,
  );
  const inspection = state.inspection;
  const child = state.attempts.find(
    (attempt) => inspection && sameChild(attempt, inspection),
  );
  const closeButton = useRef<HTMLButtonElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const [projection] = useState(createTranscriptProjection);
  const [disclosures] = useState(() => new Map<string, boolean>());
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
  const presentation = child.presentation;
  const live = !child.historical && !terminalChild(child);
  const status = outcome?.status ?? child.status;
  const attempts = state.attempts.filter((item) => item.handle === child.handle);
  const meta = [
    child.model,
    presentation?.turns ? `${presentation.turns} turns` : null,
    presentation?.tool_uses ? `${presentation.tool_uses} tool uses` : null,
  ].filter(Boolean);
  const blocks = projection.project(inspection.rows, { kind: "historical" });
  // The retained result usually is the child's last reply; show it once.
  const lastReply = [...inspection.rows]
    .reverse()
    .find((row) => row.kind === "assistant")
    ?.text?.trim();
  const result =
    outcome?.result && outcome.result.trim() !== lastReply
      ? outcome.result
      : null;
  return (
    <dialog
      open={true}
      aria-modal="false"
      aria-label="Subagent"
      data-testid="coding-child-inspector"
      data-child-handle={child.handle}
      data-child-attempt={child.attempt}
      className="absolute inset-0 z-20 m-0 flex h-full w-full min-h-0 min-w-0 max-w-none flex-col overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] lg:relative lg:inset-auto lg:my-3 lg:h-auto lg:w-112 lg:shrink-0 dark:bg-card"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          view.close();
        }
      }}
    >
      <header className="flex shrink-0 items-start gap-2.5 border-b border-border/60 px-3 py-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md coding-wash-strong">
          <Bot className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {childDescription(child)}
          </h2>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <output
              aria-live="polite"
              className={
                ["failed", "deadline", "interrupted"].includes(status)
                  ? "text-destructive"
                  : ""
              }
            >
              {!state.connected && live
                ? "Disconnected"
                : (statusText[status] ?? status)}
            </output>
            {live && (
              <LoaderCircle
                className="size-3 animate-spin"
                aria-hidden="true"
              />
            )}
            {meta.length > 0 && (
              <span className="min-w-0 truncate">· {meta.join(" · ")}</span>
            )}
          </p>
        </div>
        <Button
          ref={closeButton}
          size="icon-sm"
          variant="ghost"
          className="shrink-0"
          aria-label="Close subagent"
          onClick={() => view.close()}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      {attempts.length > 1 && (
        <nav
          aria-label="Subagent attempts"
          className="flex shrink-0 flex-wrap gap-1 border-b border-border/60 px-3 py-1.5"
        >
          {attempts.map((item) => (
            <Button
              key={childKey(item)}
              size="sm"
              variant={sameChild(item, child) ? "secondary" : "ghost"}
              className="h-6 rounded-md px-2 text-xs"
              aria-current={sameChild(item, child) ? "true" : undefined}
              onClick={() => void view.open(item)}
            >
              Attempt {item.attempt}
            </Button>
          ))}
        </nav>
      )}
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        data-testid="coding-child-content"
      >
        {inspection.error && (
          <div className="flex items-center gap-2 text-xs">
            <p role="alert" className="min-w-0 flex-1 break-words text-destructive">
              {inspection.error}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0"
              onClick={() => void view.open(child)}
            >
              Retry
            </Button>
          </div>
        )}
        {inspection.older && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full text-xs text-muted-foreground"
            disabled={inspection.loadingEarlier || !state.connected}
            onClick={() => void view.loadEarlier()}
          >
            {inspection.loadingEarlier ? "Loading…" : "Load earlier"}
          </Button>
        )}
        <DisclosureMemory value={disclosures}>
          <div className="flex min-w-0 flex-col gap-2">
            {segments(blocks).map((part) =>
              Array.isArray(part) ? (
                <TranscriptBlocks
                  key={part[0].key}
                  blocks={part}
                  childView={null}
                />
              ) : (
                <TaskBrief key={part.key} text={part.row.text ?? ""} />
              ),
            )}
          </div>
        </DisclosureMemory>
        {inspection.earlier && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full text-xs text-muted-foreground"
            onClick={() => void view.showLatest()}
          >
            Show latest
          </Button>
        )}
        {inspection.loading && (
          <output className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            Loading
          </output>
        )}
        {inspection.cut &&
          !inspection.loading &&
          !inspection.rows.length &&
          !outcome && (
            <p className="text-xs text-muted-foreground">No activity yet</p>
          )}
        {outcome && (result || outcome.error) && (
          <section
            aria-label="Subagent result"
            className="min-w-0 space-y-1 border-t border-border/60 pt-3"
          >
            <h3 className="text-xs font-medium text-muted-foreground">
              Result
            </h3>
            {result && (
              <MarkdownPreview
                markdown={result}
                className="max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-sm leading-6 text-foreground"
              />
            )}
            {outcome.error && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-destructive">
                {outcome.error}
              </pre>
            )}
            {(outcome.result_clipped || outcome.error_clipped) && (
              <p role="note" className="text-[11px] text-muted-foreground">
                Result clipped
              </p>
            )}
          </section>
        )}
      </div>
    </dialog>
  );
}
