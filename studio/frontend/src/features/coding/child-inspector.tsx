// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import { Button } from "@/components/ui/button";
import { ArrowDown, Bot, LoaderCircle, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  childDescription,
  childKey,
  sameChild,
  terminalChild,
} from "./child-types";
import type { ChildView } from "./child-view";
import { HistoryEdge } from "./history-edge";
import { createHistoryScroll, type HistoryScroll } from "./history-scroll";
import {
  createTranscriptReader,
  type TranscriptReader,
} from "./transcript-reader";
import { DisclosureMemory } from "./tool-report";
import { TranscriptBlocks } from "./transcript";
import {
  type TranscriptBlock,
  createTranscriptProjection,
} from "./transcript-model";

/** The delegated brief is long and structured; show its objective, collapsed. */
function TaskBrief({ text, readingKey }: { text: string; readingKey: string }) {
  const objective =
    /## Objective\s*\n([^\n]+)/.exec(text)?.[1]?.trim() ||
    text.trim().split("\n")[0];
  return (
    <details
      data-reading-key={readingKey}
      className="group/task min-w-0 rounded-lg bg-muted/50 text-xs dark:bg-accent/60"
    >
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
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reader = useRef<TranscriptReader | null>(null);
  const historyScroll = useRef<HistoryScroll | null>(null);
  const replacingPage = useRef<{
    key: string;
    first: string | null;
  } | null>(null);
  const [pagingKey, setPagingKey] = useState<string | null>(null);
  const paging = Boolean(inspection?.earlier && pagingKey === key);
  const [reading, setReading] = useState({ away: false, newActivity: false });
  useLayoutEffect(() => {
    if (!key || !viewport.current || !content.current) return;
    const controller = createTranscriptReader(
      viewport.current,
      content.current,
      (next) => {
        setReading((prior) =>
          prior.away === next.away && prior.newActivity === next.newActivity
            ? prior
            : next,
        );
      },
    );
    reader.current = controller;
    return () => {
      controller.dispose();
      reader.current = null;
    };
  }, [key]);
  useLayoutEffect(() => {
    if (!key || !viewport.current) return;
    let active = true;
    const controller = createHistoryScroll(
      viewport.current,
      () => {
        const current = view.getSnapshot();
        return {
          before: Boolean(current.inspection?.older),
          after: false,
          ready: current.connected,
          busy: Boolean(
            current.inspection?.loading || current.inspection?.loadingEarlier,
          ),
          error: Boolean(current.inspection?.error),
        };
      },
      async () => {
        replacingPage.current = {
          key,
          first: view.getSnapshot().inspection?.first ?? null,
        };
        setPagingKey(key);
        reader.current?.pause();
        await view.loadEarlier();
        if (active && !view.getSnapshot().inspection?.error) setPagingKey(null);
      },
    );
    historyScroll.current = controller;
    return () => {
      active = false;
      replacingPage.current = null;
      controller.dispose();
      historyScroll.current = null;
    };
  }, [key, view]);
  useLayoutEffect(() => {
    if (!inspection) return;
    reader.current?.activity(0, inspection.earlier);
    const replacement = replacingPage.current;
    if (
      inspection.earlier &&
      !inspection.loadingEarlier &&
      !inspection.error &&
      replacement?.key === key &&
      replacement.first !== inspection.first
    )
      reader.current?.replaceAtEnd();
    else reader.current?.restore();
    if (!inspection.loadingEarlier) replacingPage.current = null;
  }, [
    key,
    inspection?.rows,
    inspection?.earlier,
    inspection?.first,
    inspection?.loadingEarlier,
    inspection?.error,
  ]);
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
  const attempts = state.attempts.filter(
    (item) => item.handle === child.handle,
  );
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
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewport}
          className="h-full overflow-y-auto px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{ overflowAnchor: "none" }}
          data-testid="coding-child-content"
          aria-label="Subagent transcript"
          aria-busy={inspection.loading || inspection.loadingEarlier}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Reading viewport supports keyboard scrolling and retained focus.
          tabIndex={0}
        >
          <div ref={content} className="min-h-full space-y-3">
            {inspection.error && (
              <div className="flex items-center gap-2 text-xs">
                <p
                  role="alert"
                  className="min-w-0 flex-1 break-words text-destructive"
                >
                  {inspection.error}
                </p>
                {!paging && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0"
                    disabled={!state.connected}
                    onClick={() => void view.open(child)}
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}
            {paging && (
              <HistoryEdge
                direction="before"
                loading={inspection.loadingEarlier}
                error={Boolean(inspection.error)}
                disabled={inspection.loadingEarlier || !state.connected}
                onRetry={() => void historyScroll.current?.retry("before")}
              />
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
                    <TaskBrief
                      key={part.key}
                      readingKey={part.key}
                      text={part.row.text ?? ""}
                    />
                  ),
                )}
              </div>
            </DisclosureMemory>
            {inspection.loading && (
              <output className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle
                  className="size-3 animate-spin"
                  aria-hidden="true"
                />
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
        </div>
        {(reading.away || inspection.earlier) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              variant="outline"
              size="icon-sm"
              className="pointer-events-auto rounded-full bg-background/95 text-muted-foreground shadow-sm dark:bg-card"
              aria-label="Jump to latest subagent activity"
              title="Jump to latest"
              onClick={() => {
                setPagingKey(null);
                void view.showLatest();
                reader.current?.jump();
              }}
            >
              <ArrowDown className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </dialog>
  );
}
