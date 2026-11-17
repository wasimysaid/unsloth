// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { FenceLine } from "@/components/assistant-ui/code-fence-defer";
import { requestFullHighlight } from "@/components/assistant-ui/use-reasoning-highlight";
import type { HighlightResult } from "@streamdown/code";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
const MAX_LINE_LENGTH = 8192;
export function ProjectSource({
  text,
  language,
  firstLine,
}: { text: string; language: string | null; firstLine: number }) {
  const source = useMemo(() => {
    const lines = text.split("\n");
    const shortened = lines.some((line) => line.length > MAX_LINE_LENGTH);
    const visible = lines.map((line) =>
      line.length > MAX_LINE_LENGTH
        ? `${line.slice(0, MAX_LINE_LENGTH)}…`
        : line,
    );
    return { lines: visible, text: visible.join("\n"), shortened };
  }, [text]);
  const [highlight, setHighlight] = useState<{
    source: string;
    language: string | null;
    tokens: HighlightResult;
  } | null>(null);
  useEffect(
    () =>
      requestFullHighlight(source.text, language, (tokens) => {
        if (tokens) setHighlight({ source: source.text, language, tokens });
      }) ?? undefined,
    [source.text, language],
  );
  const tokens =
    highlight?.source === source.text && highlight.language === language
      ? highlight.tokens.tokens
      : null;
  const viewport = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: source.lines.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 22,
    overscan: 12,
  });
  const width = useMemo(
    () =>
      source.lines.reduce((width, line) => Math.max(width, line.length), 40),
    [source.lines],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="project-source">
      {source.shortened && (
        <p className="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground">
          Long lines are shortened in this preview.
        </p>
      )}
      <div
        ref={viewport}
        className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[22px]"
        tabIndex={0}
        aria-label="File source"
      >
        <div
          className="relative min-w-full"
          style={{ height: virtual.getTotalSize(), width: `${width + 10}ch` }}
        >
          {virtual.getVirtualItems().map((row) => (
            <div
              key={row.index}
              className="absolute left-0 flex h-[22px] w-full whitespace-pre"
              style={{ transform: `translateY(${row.start}px)` }}
              data-source-line={firstLine + row.index}
            >
              <span
                aria-hidden="true"
                className="sticky left-0 z-10 w-[7ch] shrink-0 select-none bg-[var(--panel-document-background)] pr-3 text-right text-muted-foreground/60"
              >
                {firstLine + row.index}
              </span>
              <span className="pr-5">
                {tokens?.[row.index] ? (
                  <FenceLine line={tokens[row.index]} windowed inline />
                ) : (
                  source.lines[row.index]
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
