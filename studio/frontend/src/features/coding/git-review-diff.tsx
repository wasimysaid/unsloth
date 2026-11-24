// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  patchRows,
  selectReviewLines,
  type LineSelection,
} from "./git-review-lines";

import { Button } from "@/components/ui/button";
import { FenceLine } from "@/components/assistant-ui/code-fence-defer";
import { requestFullHighlight } from "@/components/assistant-ui/use-reasoning-highlight";
import { attachmentTextLanguage } from "@/features/chat/attachment-content";
import type { GitComment } from "./git-workspace-api";
import type { HighlightResult } from "@streamdown/code";

function usePatchTokens(source: string, language: string | null) {
  const [highlight, setHighlight] = useState<{
    source: string;
    language: string;
    tokens: HighlightResult["tokens"];
  } | null>(null);
  useEffect(() => {
    if (!language || !source.trim()) return;
    return (
      requestFullHighlight(source, language, (result) => {
        if (result) setHighlight({ source, language, tokens: result.tokens });
      }) ?? undefined
    );
  }, [source, language]);
  return highlight?.source === source && highlight.language === language
    ? highlight.tokens
    : null;
}

const LINES_PER_PAGE = 200;

export function GitReviewDiff({
  text,
  path,
  selection,
  editor,
  onSelect,
  comments,
}: {
  text: string;
  path: string;
  selection?: LineSelection;
  editor: ReactNode;
  onSelect: (selection: LineSelection) => void;
  comments: GitComment[];
}) {
  const rows = useMemo(() => patchRows(text), [text]);
  const language = attachmentTextLanguage(path, null);
  const before = useMemo(
    () =>
      rows
        .map((r) => (r.before === undefined ? "" : r.raw.slice(1)))
        .join("\n"),
    [rows],
  );
  const after = useMemo(
    () =>
      rows.map((r) => (r.after === undefined ? "" : r.raw.slice(1))).join("\n"),
    [rows],
  );
  const oldTokens = usePatchTokens(before, language);
  const newTokens = usePatchTokens(after, language);
  const displayed = useMemo(
    () => (rows.some((r) => r.hunk) ? rows.filter((r) => r.inHunk) : rows),
    [rows],
  );
  const [requestedLimit, setLineLimit] = useState(LINES_PER_PAGE);
  const lineLimit = Math.max(
    requestedLimit,
    selection
      ? displayed.findIndex((row) => row.index + 1 === selection.end_line) + 1
      : 0,
  );
  const lastVisible =
    displayed[Math.min(displayed.length, lineLimit) - 1]?.index;
  const firstLine = rows.find(
    (r) => r.after !== undefined || r.before !== undefined,
  )?.index;
  const [focusLine, setFocusLine] = useState(firstLine);
  const [collapsedNote, setCollapsedNote] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  function select(index: number, extend: boolean) {
    const result = selectReviewLines(
      rows,
      index,
      extend && selection && anchor !== null ? anchor : index,
    );
    if (!result) return;
    setAnchor(result.first);
    onSelect(result.selection);
  }
  return (
    <div
      className="@container overflow-x-auto overscroll-x-contain font-mono text-[11.5px] leading-[1.65]"
      data-git-patch
      aria-label="Unified diff"
    >
      <div className="min-w-max">
        {displayed
          .slice(0, lineLimit)
          .map(({ raw, index, before, after, hunk }) => {
            if (before === undefined && after === undefined) {
              return (
                <div
                  key={index}
                  className={cn(
                    "px-3 py-1 whitespace-pre text-muted-foreground",
                    hunk && "coding-wash-faint text-[10px]",
                  )}
                >
                  {raw}
                </div>
              );
            }
            const thread = comments.filter((c) => c.start_line === index + 1);
            const note = thread[0];
            const tokens = (after === undefined ? oldTokens : newTokens)?.[
              index
            ];
            const marked =
              selection &&
              index + 1 >= selection.start_line &&
              index + 1 <= selection.end_line;
            return (
              <Fragment key={index}>
                <div
                  className={cn(
                    "group/line flex items-center whitespace-pre",
                    before === undefined && "bg-emerald-500/10",
                    after === undefined && "bg-red-500/10",
                    marked &&
                      "bg-primary/15 shadow-[inset_2px_0_0_var(--primary)]",
                  )}
                >
                  <button
                    type="button"
                    className="inline-flex min-h-7 min-w-20 shrink-0 cursor-pointer select-none items-center gap-1 px-1.5 text-right text-[10px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [@media(pointer:coarse)]:min-h-10"
                    title={
                      note?.comment ??
                      "Comment on line (Shift-click to select a range)"
                    }
                    aria-expanded={note ? collapsedNote !== index : undefined}
                    aria-label={`${note ? "Toggle comment" : "Comment"} on ${after === undefined ? "removed " : ""}line ${after ?? before}`}
                    tabIndex={index === focusLine ? 0 : -1}
                    onFocus={() => setFocusLine(index)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                        return;
                      event.preventDefault();
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      for (
                        let next = index + direction;
                        rows[next] && next <= lastVisible;
                        next += direction
                      ) {
                        if (
                          rows[next].before === undefined &&
                          rows[next].after === undefined
                        )
                          continue;
                        event.currentTarget
                          .closest("[data-git-patch]")
                          ?.querySelector<HTMLButtonElement>(
                            `[data-patch-line="${next}"]`,
                          )
                          ?.focus();
                        if (event.shiftKey) select(next, true);
                        break;
                      }
                    }}
                    data-patch-line={index}
                    onClick={(e) => {
                      if (note && !e.shiftKey)
                        setCollapsedNote((old) =>
                          old === index ? null : index,
                        );
                      else {
                        select(index, e.shiftKey);
                        if (!e.shiftKey) {
                          const diff =
                            e.currentTarget.closest("[data-git-patch]");
                          requestAnimationFrame(() =>
                            diff?.querySelector("textarea")?.focus(),
                          );
                        }
                      }
                    }}
                  >
                    {note ? (
                      <MessageSquare
                        aria-hidden
                        className="size-4 shrink-0 text-primary"
                      />
                    ) : (
                      <MessageSquarePlus
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground group-hover/line:text-foreground group-focus-within/line:text-foreground"
                      />
                    )}
                    <span className="w-[3ch]">{before}</span>
                    <span className="w-[3ch]">{after}</span>
                  </button>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-5 shrink-0 select-none text-center",
                      before === undefined
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400",
                    )}
                  >
                    {raw[0]}
                  </span>
                  <code className="pr-4 font-mono text-foreground/90">
                    {tokens?.length ? (
                      <FenceLine line={tokens} windowed inline />
                    ) : (
                      raw.slice(1) || " "
                    )}
                  </code>
                </div>
                {note && collapsedNote !== index && (
                  <div className="sticky left-0 w-[100cqi] space-y-1 bg-muted/30 px-3 py-2 font-sans text-sm">
                    {thread.map((item, position) => (
                      <p key={position} className="flex items-start gap-2">
                        <MessageSquare
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 whitespace-pre-wrap break-words">
                          {item.comment}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
                {index + 1 === selection?.end_line && editor && (
                  <div className="sticky left-0 w-[100cqi] bg-muted/30">
                    {editor}
                  </div>
                )}
              </Fragment>
            );
          })}
      </div>
      {lineLimit < displayed.length && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="sticky left-2 my-1 font-sans text-muted-foreground"
          onClick={() => setLineLimit((n) => n + LINES_PER_PAGE)}
        >
          Show next {Math.min(LINES_PER_PAGE, displayed.length - lineLimit)}{" "}
          lines
        </Button>
      )}
    </div>
  );
}
