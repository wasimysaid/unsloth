// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { withLiteralUnknownTags } from "@/lib/markdown-data-images";
import { rehypeParagraphBreaks } from "@/lib/markdown-paragraph-breaks";
import { markdownPluginNeeds } from "@/lib/markdown-plugins";
import { openLink } from "@/lib/open-link";
import { safeMarkdownUrl } from "@/lib/safe-markdown-url";
import { scheduleIdleTask } from "@/lib/schedule-idle-task";
import { cn } from "@/lib/utils";
import {
  MARKDOWN_TABLE_ICONS,
  MarkdownTable,
  StaticMarkdownTable,
} from "@/components/assistant-ui/markdown-table";
import { codePlugin } from "@/components/assistant-ui/shared-code-plugin";
import { stabilizeStreamingMarkdown } from "@/components/assistant-ui/streaming-markdown";
import {
  IncrementalMarkdownCache,
  LITERAL_LINK_REMEND,
  hasIncompleteLinkRepair,
  markdownRenderKey,
} from "@/components/assistant-ui/streaming-render-schedule";
import { math } from "@streamdown/math";
import { mermaid } from "@/components/assistant-ui/mermaid-plugin";
import {
  type ComponentProps,
  type ReactElement,
  memo,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { INERT_MARKDOWN_COMPONENTS } from "./inert-components";
import "katex/dist/katex.min.css";

type MarkdownPlugins = NonNullable<
  ComponentProps<typeof Streamdown>["plugins"]
>;
const REHYPE_PLUGINS = [...withLiteralUnknownTags(), rehypeParagraphBreaks];
const MARKDOWN_COMPONENTS = {
  a: ({ href, children, ...props }: ComponentProps<"a">) => (
    <a
      href={href}
      rel="noopener noreferrer"
      className="cursor-pointer text-foreground underline decoration-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground"
      onClick={(event) => {
        if (href && openLink(href)) {
          event.preventDefault();
        }
      }}
      {...props}
    >
      {children}
    </a>
  ),
  table: MarkdownTable,
};
const INERT_COMPONENTS = {
  ...INERT_MARKDOWN_COMPONENTS,
  table: StaticMarkdownTable,
};
// New words fade in; settled blocks are memoised and never redrawn.
const STREAMING_FADE = { animation: "fadeIn", duration: 160, sep: "word" } as const;

type MarkdownPreviewProps = {
  markdown: string;
  className?: string;
  plain?: boolean;
  inert?: boolean;
  /** Parse on the next idle callback so the UI stays interactive for large documents. */
  defer?: boolean;
  /** Live text: re-parse only the growing tail and repair unfinished syntax. */
  streaming?: boolean;
};

function MarkdownPreviewImpl({
  markdown,
  className,
  plain = false,
  inert = false,
  defer = false,
  streaming = false,
}: MarkdownPreviewProps): ReactElement {
  // One incremental parse per stream; settled text uses the static renderer.
  const cache = useMemo(
    () => (streaming ? new IncrementalMarkdownCache() : null),
    [streaming],
  );
  const live = cache ? stabilizeStreamingMarkdown(markdown, true) : null;
  const incremental = live === null ? null : cache?.update(live);
  // Skip plugins with nothing to do or too costly on very long documents.
  const plugins = useMemo<MarkdownPlugins>(() => {
    const needs = markdownPluginNeeds(markdown);
    const next: MarkdownPlugins = {};
    if (needs.code) next.code = codePlugin;
    if (needs.math) next.math = math;
    if (needs.mermaid) next.mermaid = mermaid;
    return next;
  }, [markdown]);
  // Derived during render: resetting from an effect is one commit late and parses twice.
  const [readyMarkdown, setReadyMarkdown] = useState<string | null>(null);
  const ready = !defer || readyMarkdown === markdown;
  useEffect(() => {
    if (!defer) {
      return;
    }
    return scheduleIdleTask(() => setReadyMarkdown(markdown), 200);
  }, [defer, markdown]);
  const markdownClassName =
    "w-full max-w-none min-w-0 space-y-2 [overflow-wrap:anywhere] [&_*]:max-w-none [&_p]:w-full [&_ul]:w-full [&_ol]:w-full [&_li]:w-full [&_h1]:w-full [&_h2]:w-full [&_h3]:w-full [&_h4]:w-full [&_h5]:w-full [&_h6]:w-full [&_pre]:w-full [&_table]:w-full [&_p]:break-words [&_li]:break-words [&_code]:break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words";

  return (
    <div
      className={cn(
        plain
          ? "h-full w-full min-w-0 overflow-auto p-2 text-xs leading-relaxed pointer-events-none select-none"
          : "nodrag max-h-56 w-full min-w-0 overflow-auto scroll-rounded rounded-lg border border-border/60 bg-muted/20 p-2 text-xs leading-relaxed",
        className,
      )}
    >
      {ready ? (
        <Streamdown
          key={
            live === null
              ? "settled"
              : `${cache?.renderGeneration}:${markdownRenderKey(live)}`
          }
          {...(live === null
            ? { mode: "static" as const }
            : {
                mode: "streaming" as const,
                parseIncompleteMarkdown: !incremental,
                remend: hasIncompleteLinkRepair(live)
                  ? LITERAL_LINK_REMEND
                  : undefined,
                parseMarkdownIntoBlocksFn: incremental?.parseMarkdownIntoBlocks,
                isAnimating: true,
                animated: STREAMING_FADE,
              })}
          plugins={plugins}
          rehypePlugins={REHYPE_PLUGINS}
          components={inert || plain ? INERT_COMPONENTS : MARKDOWN_COMPONENTS}
          icons={MARKDOWN_TABLE_ICONS}
          urlTransform={safeMarkdownUrl}
          controls={false}
          className={markdownClassName}
        >
          {incremental?.markdown ??
            live ??
            (markdown.trim() ? markdown : "_Empty note_")}
        </Streamdown>
      ) : (
        <div className={markdownClassName} aria-busy="true" />
      )}
    </div>
  );
}

export const MarkdownPreview = memo(MarkdownPreviewImpl);
