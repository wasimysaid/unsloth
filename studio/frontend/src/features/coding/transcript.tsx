// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Image as ImageIcon,
  Info,
  LoaderCircle,
} from "lucide-react";
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
import { ChildActivityRow, ChildInspectLink } from "./child-inspector";
import type { ChildView } from "./child-view";
import { PlanCard } from "./plan-card";
import { EntryContentStatus } from "./entry-content-status";
import { isLiteralParagraph, literalParagraphRuns } from "./markdown-paragraph";
import type { CodingRow } from "./run-types";
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

function Bounded({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  if (!isLong(text)) return <>{children}</>;
  return (
    <>
      <div
        className="max-h-[32rem] overflow-auto overscroll-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Long native messages need keyboard scrolling.
        tabIndex={0}
        onKeyDown={boundedContentKeyDown}
        data-reading-control="message-content"
        aria-label="Bounded native message content"
      >
        {children}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Long message · scroll within it to read all supplied text.
      </p>
    </>
  );
}
const Clipped = ({ row }: { row: CodingRow }) =>
  row.clipped ? (
    <p className="mt-1 text-xs font-medium">
      Content clipped to the presentation bound.
    </p>
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
      <div className="min-w-0 max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-6 dark:bg-accent">
        <Bounded text={text}>
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </Bounded>
        {(row.image_count ?? 0) > 0 && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden="true" />
            {row.image_count} {row.image_count === 1 ? "image" : "images"} sent
            with this prompt
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
    >
      {text.trim() && (
        <Bounded text={text}>
          {isLiteralParagraph(text) ? (
            <p
              className={`${prose} [overflow-wrap:anywhere]`}
              data-native-paragraph=""
            >
              {literalParagraphRuns(text).map((run, index) => (
                <span key={index}>{run}</span>
              ))}
            </p>
          ) : (
            <MarkdownPreview markdown={text} className={prose} />
          )}
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
      <div className="min-w-0 max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 dark:bg-accent">
        <p className="text-xs font-medium text-muted-foreground">
          Your accepted answer
        </p>
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
              ? "Public tool answer"
              : "Public tool report"
          }
        >
          <MarkdownPreview markdown={tool.output} className={prose} />
        </div>
      )}
      <ToolReport row={block.row} itemKey={block.key} />
    </div>
  );
}

function Item({
  item,
  childView,
}: {
  item: ActivityItem;
  childView: ChildView | null;
}) {
  if (item.kind === "reasoning")
    return (
      <ReasoningReport row={item.row} itemKey={item.key} live={item.live} />
    );
  return (
    <ToolReport
      row={item.row}
      itemKey={item.key}
      trailing={
        item.child && childView ? (
          <ChildInspectLink view={childView} identity={item.child} />
        ) : null
      }
    />
  );
}

function ActivityBlock({
  block,
  childView,
}: {
  block: Extract<TranscriptBlock, { kind: "activity" }>;
  childView: ChildView | null;
}) {
  // Subagent invocations stay visible, like running work.
  const [open, toggle] = useDisclosure(block.key, block.live || block.agents);
  if (block.items.length === 1)
    return (
      <div className="min-w-0" data-reading-key={block.key}>
        <Item item={block.items[0]} childView={childView} />
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
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{summary.text}</span>
        {summary.failed > 0 && (
          <CircleAlert
            className="size-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        )}
        {block.live && (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin"
            aria-label="In progress"
          />
        )}
      </button>
      {open && (
        <div className="ml-[7px] mt-0.5 space-y-0.5 border-l border-border/70 pl-3.5">
          {block.items.map((item) => (
            <div key={item.key} data-reading-key={item.key}>
              <Item item={item} childView={childView} />
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
          {childView ? (
            <ChildActivityRow
              view={childView}
              row={block.row}
              identity={block.child}
            />
          ) : null}
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
