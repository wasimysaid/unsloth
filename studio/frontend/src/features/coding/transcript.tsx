// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import { Check, ChevronDown, Copy, Image as ImageIcon, Info } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { restoreAnswerFocus } from "./answer-focus";
import { boundedContentKeyDown } from "./bounded-content";
import type { ChildView } from "./child-view";
import { EntryContentStatus } from "./entry-content-status";
import { PlanCard } from "./plan-card";
import type { CodingRow } from "./run-types";
import { SubagentRow } from "./subagent-card";
import { ReasoningReport, ToolReport, useDisclosure } from "./tool-report";
import type { ActivityItem, TranscriptBlock } from "./transcript-model";

// Focus intent only, not another answer/history store. A native answer row can
// mount one render after its question controls have disappeared.
export const AnswerFocus = createContext<{ current: string | null } | null>(
  null,
);

const prose =
  "max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-[15px] leading-7 text-foreground";
const isLong = (text: string) =>
  text.length > 4000 || text.split("\n").length > 80;
// Replies flow with the page; only pathological sizes get their own scroller.
const isHuge = (text: string) => text.length > 200_000;

/** Long user/notice text scrolls inside itself instead of flooding the page. */
function Bounded({
  text,
  long = isLong,
  children,
}: {
  text: string;
  long?: (text: string) => boolean;
  children: React.ReactNode;
}) {
  if (!long(text)) return <>{children}</>;
  return (
    <div
      className="max-h-128 overflow-auto overscroll-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Long native messages need keyboard scrolling.
      tabIndex={0}
      onKeyDown={boundedContentKeyDown}
      data-reading-control="message-content"
      aria-label="Long message"
    >
      {children}
    </div>
  );
}
const Clipped = ({ row }: { row: CodingRow }) =>
  row.clipped ? (
    <p className="mt-1 text-xs text-muted-foreground">Content clipped</p>
  ) : null;

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied reply" : "Copy reply"}
      className="mt-1 inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

function UserBlock({
  block,
}: { block: Extract<TranscriptBlock, { kind: "user" }> }) {
  const { row } = block;
  const text = row.text ?? "";
  return (
    <div
      className="flex justify-end pt-4 first:pt-0"
      data-reading-key={block.key}
      data-native-entry={row.id}
    >
      <div className="min-w-0 max-w-[85%] rounded-[18px] bg-muted px-4 py-2.5 text-[15px] leading-6 dark:bg-accent">
        <Bounded text={text}>
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </Bounded>
        {(row.image_count ?? 0) > 0 && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden="true" />
            {row.image_count} {row.image_count === 1 ? "image" : "images"}
          </p>
        )}
        <Clipped row={row} />
      </div>
    </div>
  );
}

function ProseBlock({
  block,
}: {
  block: Extract<TranscriptBlock, { kind: "prose" }>;
}) {
  const text = block.row.text ?? "";
  return (
    <div
      className="min-w-0"
      data-reading-key={block.key}
      data-native-entry={block.row.id}
      data-live={block.live || undefined}
    >
      {text.trim() && (
        <Bounded text={text} long={isHuge}>
          <MarkdownPreview
            markdown={text}
            streaming={block.live}
            className={prose}
          />
        </Bounded>
      )}
      <Clipped row={block.row} />
      {block.turnEnd && text.trim() && <CopyText text={text} />}
    </div>
  );
}

function AnswerBlock({
  block,
}: {
  block: Extract<TranscriptBlock, { kind: "answer" }>;
}) {
  const { row } = block;
  const root = useRef<HTMLDivElement>(null);
  const questionId = row.answer?.user_request_id;
  const answerFocus = useContext(AnswerFocus);
  useLayoutEffect(() => {
    const element = root.current;
    if (questionId && answerFocus)
      restoreAnswerFocus(
        answerFocus,
        questionId,
        element,
        document.activeElement,
        document.body,
      );
    return () => {
      // A checkpoint replaces a provisional answer with its saved identity.
      // Carry only focus owned by that row across the native replacement.
      if (
        questionId &&
        answerFocus &&
        element?.contains(document.activeElement)
      )
        answerFocus.current = questionId;
    };
  }, [questionId, answerFocus]);
  return (
    <div
      ref={root}
      className="flex justify-end focus-visible:outline-none"
      data-reading-key={block.key}
      data-native-entry={row.id}
      data-native-answer={questionId}
      tabIndex={-1}
    >
      <div className="min-w-0 max-w-[85%] rounded-[18px] bg-muted px-4 py-2.5 dark:bg-accent">
        <p className="text-xs text-muted-foreground">Your answer</p>
        <p className="whitespace-pre-wrap break-words text-[15px] leading-6">
          {row.text}
        </p>
        <Clipped row={row} />
      </div>
    </div>
  );
}

function SemanticBlock({
  block,
}: {
  block: Extract<TranscriptBlock, { kind: "semantic" }>;
}) {
  const tool = block.row.tool;
  return (
    <div className="min-w-0 space-y-1" data-reading-key={block.key}>
      {tool?.output && (
        <div
          className="max-h-80 min-w-0 overflow-auto overscroll-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Public semantic output is height-bounded and keyboard scrollable.
          tabIndex={0}
          onKeyDown={boundedContentKeyDown}
          data-reading-control="semantic-output"
          aria-label={
            tool.semantic_content === "answer_markdown"
              ? "Tool answer"
              : "Tool report"
          }
        >
          <MarkdownPreview markdown={tool.output} className={prose} />
        </div>
      )}
      <ToolReport row={block.row} itemKey={block.key} rail={false} />
    </div>
  );
}

function Item({ item, last }: { item: ActivityItem; last: boolean }) {
  if (item.kind === "reasoning")
    return (
      <ReasoningReport
        row={item.row}
        itemKey={item.key}
        live={item.live}
        last={last}
      />
    );
  return <ToolReport row={item.row} itemKey={item.key} last={last} />;
}

/** Consecutive thinking and tool calls: one titled tree, open while it streams. */
function ActivityBlock({
  block,
  childView,
}: {
  block: Extract<TranscriptBlock, { kind: "activity" }>;
  childView: ChildView | null;
}) {
  const [open, toggle] = useDisclosure(block.key, block.live);
  if (block.agents)
    return (
      <div className="min-w-0 space-y-1.5 py-0.5" data-reading-key={block.key}>
        {block.items.map((item) => (
          <div key={item.key} data-reading-key={item.key}>
            <SubagentRow
              row={item.row}
              identity={item.kind === "tool" ? item.child : null}
              view={childView}
            />
          </div>
        ))}
      </div>
    );
  const { summary } = block;
  return (
    <div
      className="min-w-0"
      data-reading-key={block.key}
      data-testid="coding-activity-group"
      data-live={block.live || undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        data-reading-control={`activity:${block.key}`}
        onClick={toggle}
        className="flex h-6.5 min-w-0 max-w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex w-5.75 shrink-0 justify-center">
          <ChevronDown
            className={`size-3.5 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
        </span>
        <span
          className={`min-w-0 truncate ${block.live ? "coding-shimmer" : ""}`}
        >
          {summary.text}
        </span>
      </button>
      {open && (
        <div className="min-w-0 pt-0.5">
          {block.items.map((item, index) => (
            <div
              key={item.key}
              data-reading-key={item.key}
              className="coding-row-enter"
            >
              <Item item={item} last={index === block.items.length - 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  childView,
}: {
  block: TranscriptBlock;
  childView: ChildView | null;
}) {
  switch (block.kind) {
    case "user":
      return <UserBlock block={block} />;
    case "prose":
      return <ProseBlock block={block} />;
    case "answer":
      return <AnswerBlock block={block} />;
    case "semantic":
      return <SemanticBlock block={block} />;
    case "activity":
      return <ActivityBlock block={block} childView={childView} />;
    case "child":
      return (
        <div className="min-w-0" data-reading-key={block.key}>
          <SubagentRow row={block.row} identity={block.child} view={childView} />
        </div>
      );
    case "plan":
      return block.row.plan ? (
        <div className="min-w-0" data-reading-key={block.key}>
          <PlanCard plan={block.row.plan} historical={true} />
        </div>
      ) : null;
    case "content_ref":
      return (
        <div data-reading-key={block.key}>
          <EntryContentStatus row={block.row} />
        </div>
      );
    case "notice":
      return (
        <div
          className="flex min-w-0 gap-2 text-xs text-muted-foreground"
          data-reading-key={block.key}
          data-native-entry={block.row.id}
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <Bounded text={block.row.text ?? ""}>
              <p className="whitespace-pre-wrap break-words">
                {block.row.text || "Native activity"}
              </p>
            </Bounded>
            <Clipped row={block.row} />
          </div>
        </div>
      );
  }
});

/** Blocks keyed by native presentation identity, never by list index. */
export function TranscriptBlocks({
  blocks,
  childView,
}: {
  blocks: readonly TranscriptBlock[];
  childView: ChildView | null;
}) {
  return (
    <>
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} childView={childView} />
      ))}
    </>
  );
}

const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The request is running; shown while nothing streams at the tail. */
export function WorkingLine({ hidden }: { hidden: boolean }) {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      className="flex h-6 items-center gap-2 text-[12px] text-muted-foreground"
      data-testid="coding-working"
      hidden={hidden}
    >
      <span className="flex gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1 animate-pulse rounded-full bg-muted-foreground"
            style={{ animationDelay: `${dot * 150}ms` }}
          />
        ))}
      </span>
      <span className="coding-shimmer">Working…</span>
      <span className="text-[11px] text-muted-foreground/70">
        {elapsed(Math.max(0, now - since))}
      </span>
    </div>
  );
}
