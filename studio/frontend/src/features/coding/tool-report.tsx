// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import {
  Blocks,
  Bot,
  ChevronRight,
  ClipboardList,
  FilePen,
  FileSearch,
  FileText,
  FolderSearch,
  Globe,
  Image,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  MessageCircleQuestion,
  MessageSquareText,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { boundedContentKeyDown } from "./bounded-content";
import { FileChangeReport } from "./file-change-report";
import type { CodingRow } from "./run-types";

/** Expanded/collapsed choices outlive remounts (history paging, reconnect). */
const Disclosures = createContext<Map<string, boolean> | null>(null);
export const DisclosureMemory = Disclosures.Provider;
export function useDisclosure(key: string, fallback: boolean) {
  const memory = useContext(Disclosures);
  const [chosen, setChosen] = useState<boolean | null>(
    () => memory?.get(key) ?? null,
  );
  const toggle = useCallback(() => {
    setChosen((prior) => {
      const next = !(prior ?? fallback);
      memory?.set(key, next);
      return next;
    });
  }, [fallback, key, memory]);
  return [chosen ?? fallback, toggle] as const;
}

/** Native `ToolDisplayKind` -> icon. Unknown kinds are a generic tool. */
const kindIcons: Record<string, LucideIcon> = {
  shell: SquareTerminal,
  file_read: FileText,
  image_view: Image,
  file_change: FilePen,
  file_content_search: FileSearch,
  file_path_search: FolderSearch,
  status: ListChecks,
  plan: ClipboardList,
  answer: MessageSquareText,
  user_request: MessageCircleQuestion,
  web: Globe,
  agent: Bot,
  mcp: Blocks,
};
export const toolIcon = (kind: string | null | undefined) =>
  (kind && kindIcons[kind]) || Wrench;

type Tool = NonNullable<CodingRow["tool"]>;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** "Read: src/lib.rs" -> Read + src/lib.rs. A shell call's subject is its command. */
export function toolLabel(tool: Tool): { verb: string; subject: string } {
  const title = tool.title || tool.name || "Tool";
  const colon = title.indexOf(": ");
  let verb = colon > 0 && colon <= 40 ? title.slice(0, colon) : title;
  let subject = colon > 0 && colon <= 40 ? title.slice(colon + 2) : "";
  if (tool.argument) {
    if (tool.display_kind === "shell")
      verb = tool.status === "running" ? "Running" : "Run";
    subject = tool.argument;
  }
  return { verb, subject: oneLine(subject) };
}

const fileKinds = new Set(["file_read", "file_change", "image_view"]);
const looksLikePath = (subject: string) =>
  Boolean(subject) && !/\s/.test(subject) && !/^\d+ files$/.test(subject);
const basename = (path: string) =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

function diffStats(tool: Tool) {
  const files = tool.output_profile?.files ?? [];
  let added = 0;
  let removed = 0;
  let known = false;
  for (const file of files) {
    if (file.additions != null) {
      added += file.additions;
      known = true;
    }
    if (file.deletions != null) {
      removed += file.deletions;
      known = true;
    }
  }
  return known ? { added, removed } : null;
}

const statusText: Record<string, string> = {
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

/** Tree connector of one row: the trunk continues past every row but the last. */
function Rail({ last }: { last: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`absolute left-2.75 top-0 w-px bg-border ${last ? "h-2" : "bottom-0"}`}
      />
      <span
        aria-hidden="true"
        className="absolute left-2.75 top-2 h-1.75 w-3.75 rounded-bl-[7px] border-b border-l border-border"
      />
    </>
  );
}

/** One rail row: icon on the connector, verb and argument on one line. */
function RailRow({
  icon: Icon,
  verb,
  subject,
  file,
  trailing,
  tone,
  open,
  onToggle,
  control,
  controls,
  last,
  rail,
  children,
}: {
  icon: LucideIcon;
  verb: string;
  subject: string;
  file: boolean;
  trailing?: React.ReactNode;
  tone: "default" | "running" | "failed";
  open: boolean;
  onToggle: () => void;
  control: string;
  controls: string;
  last: boolean;
  rail: boolean;
  children: React.ReactNode;
}) {
  const failed = tone === "failed";
  return (
    <div className={`relative min-w-0 ${rail ? "pl-12" : "pl-6"}`}>
      {rail && <Rail last={last} />}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        data-reading-control={control}
        onClick={onToggle}
        className={`group/row relative flex h-7.5 w-full min-w-0 items-center gap-2 rounded-md text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${failed ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
      >
        <Icon
          aria-hidden="true"
          className={`absolute top-1.75 size-4 ${rail ? "-left-5" : "-left-6"}`}
        />
        <span
          className={`relative shrink-0 ${tone === "running" ? "coding-shimmer" : ""}`}
        >
          {verb}
        </span>
        {subject &&
          (file && looksLikePath(subject) ? (
            <span
              className="min-w-0 truncate rounded-[5px] coding-wash px-1.5 py-px text-[12px] text-foreground/80"
              title={subject}
            >
              {basename(subject)}
            </span>
          ) : (
            <span
              className={`min-w-0 truncate ${failed ? "" : "text-muted-foreground/80 group-hover/row:text-muted-foreground"}`}
              title={subject}
            >
              {subject}
            </span>
          ))}
        {trailing}
        <ChevronRight
          aria-hidden="true"
          className={`ml-auto size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-transform group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div id={controls} className="min-w-0 pb-2">
          {children}
        </div>
      )}
    </div>
  );
}

const outputClass =
  "max-h-108 max-w-full overflow-auto overscroll-contain whitespace-pre py-1 font-mono text-[12px] leading-[18px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** One native tool invocation: verb and argument, actual result on expansion. */
export function ToolReport({
  row,
  itemKey,
  last = true,
  rail = true,
}: {
  row: CodingRow;
  itemKey?: string;
  /** Last row of its group: the connector ends here. */
  last?: boolean;
  /** Inside an activity group's tree. */
  rail?: boolean;
}) {
  const tool = row.tool;
  const key = itemKey ?? `invocation:${tool?.invocation_id ?? row.id}`;
  const [open, toggle] = useDisclosure(key, false);
  const detail = useId();
  if (!tool) return null;
  const failed = tool.status === "failed";
  const running = tool.status === "running";
  const { verb, subject } = toolLabel(tool);
  const stats = diffStats(tool);
  const status = statusText[tool.status];
  const output = tool.output.replace(/\s+$/, "");
  return (
    <div
      className="min-w-0"
      data-testid="coding-tool-row"
      data-call-id={tool.call_id}
      data-invocation-id={tool.invocation_id ?? undefined}
      data-tool-status={tool.status}
      data-reading-owner={tool.invocation_id ?? tool.call_id}
    >
      <RailRow
        icon={toolIcon(tool.display_kind)}
        verb={verb}
        subject={subject}
        file={fileKinds.has(tool.display_kind ?? "")}
        tone={failed ? "failed" : running ? "running" : "default"}
        open={open}
        onToggle={toggle}
        control={`tool:${key}`}
        controls={detail}
        last={last}
        rail={rail}
        trailing={
          <>
            {stats && (
              <span className="shrink-0 font-mono text-[11px]">
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{stats.added}
                </span>{" "}
                <span className="text-red-600 dark:text-red-400">
                  −{stats.removed}
                </span>
              </span>
            )}
            {status && !failed && (
              <span className="shrink-0 text-[11px]">{status}</span>
            )}
          </>
        }
      >
        {tool.argument && (
          <pre className="whitespace-pre-wrap break-all py-1 font-mono text-[12px] leading-[18px] text-muted-foreground/70">
            {tool.argument}
          </pre>
        )}
        {tool.output_profile?.kind === "file_change" ? (
          <FileChangeReport profile={tool.output_profile} />
        ) : output ? (
          <pre
            className={outputClass}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output needs keyboard scrolling.
            tabIndex={0}
            onKeyDown={boundedContentKeyDown}
            aria-label="Tool output"
          >
            {output}
          </pre>
        ) : (
          <p className="py-1 text-[12px] text-muted-foreground/70">
            {running ? "Running…" : "No output"}
          </p>
        )}
        {tool.clipped && (
          <p role="note" className="text-[11px] text-muted-foreground">
            Output clipped
          </p>
        )}
      </RailRow>
    </div>
  );
}

/** Public reasoning text. Live thinking stays open and follows its tail. */
export function ReasoningReport({
  row,
  itemKey,
  live,
  last = true,
  rail = true,
}: {
  row: CodingRow;
  itemKey: string;
  live: boolean;
  last?: boolean;
  rail?: boolean;
}) {
  const [open, toggle] = useDisclosure(itemKey, live);
  const detail = useId();
  const body = useRef<HTMLDivElement>(null);
  const text = row.text ?? "";
  useLayoutEffect(() => {
    if (live && open && body.current)
      body.current.scrollTop = body.current.scrollHeight;
  }, [live, open, text]);
  return (
    <div
      className="min-w-0"
      data-testid="coding-reasoning"
      data-native-entry={row.id}
    >
      <RailRow
        icon={MessageCircle}
        verb="Thought process"
        subject=""
        file={false}
        tone={live ? "running" : "default"}
        open={open}
        onToggle={toggle}
        control={`reasoning:${itemKey}`}
        controls={detail}
        last={last}
        rail={rail}
      >
        <div
          ref={body}
          className="max-h-108 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Long public reasoning needs keyboard scrolling.
          tabIndex={0}
          onKeyDown={boundedContentKeyDown}
          aria-label="Public reasoning"
        >
          <MarkdownPreview
            markdown={text}
            streaming={live}
            className="max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-[13px] leading-6 text-muted-foreground"
          />
          {row.clipped && (
            <p role="note" className="text-[11px] text-muted-foreground">
              Reasoning clipped
            </p>
          )}
        </div>
      </RailRow>
    </div>
  );
}
