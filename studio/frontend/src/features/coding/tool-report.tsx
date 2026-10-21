// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import {
  Bot,
  ChevronRight,
  ClipboardList,
  FilePen,
  FileSearch,
  FileText,
  FolderSearch,
  Globe,
  Image,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  MessageCircleMore,
  MessageCircleQuestion,
  MessageSquareText,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { createContext, useCallback, useContext, useId, useState } from "react";
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
  mcp: LayoutGrid,
};
export const toolIcon = (kind: string | null | undefined) =>
  (kind && kindIcons[kind]) || Wrench;

const statusText: Record<string, string> = {
  running: "Running",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  saved: "No result recorded",
};

function ActivityLine({
  icon: Icon,
  label,
  status,
  tone,
  open,
  onToggle,
  control,
  controls,
}: {
  icon: LucideIcon;
  label: string;
  status: string | null;
  tone: "default" | "running" | "failed";
  open: boolean;
  onToggle: () => void;
  control: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      data-reading-control={control}
      onClick={onToggle}
      className={`group/line flex w-full min-w-0 items-center gap-2.5 rounded-lg py-1 pr-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tone === "failed" ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      {status && (
        <span
          className={`shrink-0 text-xs ${tone === "failed" ? "font-medium" : ""}`}
        >
          {status}
        </span>
      )}
      {tone === "running" && (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      )}
      <ChevronRight
        className={`ml-auto size-3.5 shrink-0 opacity-0 transition-transform group-hover/line:opacity-100 group-focus-visible/line:opacity-100 ${open ? "rotate-90 opacity-100" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}

function ToolDetail({ row }: { row: CodingRow }) {
  const tool = row.tool;
  if (!tool) return null;
  const historical = Boolean(row.historical || tool.historical);
  return (
    <div className="min-w-0 space-y-2 pb-2">
      <pre
        className="max-h-80 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl bg-muted/60 p-3 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output needs keyboard scrolling.
        tabIndex={0}
        onKeyDown={boundedContentKeyDown}
        aria-label="Actual public tool output"
      >
        {tool.output || "No public output reported yet."}
      </pre>
      {tool.clipped && (
        <p role="note" className="text-xs font-medium">
          Output clipped to the presentation bound; this is not the complete
          output.
        </p>
      )}
      {tool.output_profile?.kind === "file_change" && (
        <FileChangeReport
          profile={tool.output_profile}
          historical={historical}
        />
      )}
      {!tool.output_profile &&
        ["completed", "failed"].includes(tool.status) && (
          <p className="text-xs text-muted-foreground">
            No structured file-change profile; filesystem effects are not
            inferred from this output.
          </p>
        )}
      <p className="break-all font-mono text-[11px] text-muted-foreground">
        {tool.name} · {tool.status || "reported"}
        {historical && " · historical report"}
      </p>
    </div>
  );
}

/** One native tool invocation: icon-led line, real result on expansion. */
export function ToolReport({
  row,
  itemKey,
  trailing,
}: {
  row: CodingRow;
  itemKey?: string;
  /** A sibling control beside the line, e.g. the subagent inspector link. */
  trailing?: React.ReactNode;
}) {
  const tool = row.tool;
  const key = itemKey ?? `invocation:${tool?.invocation_id ?? row.id}`;
  const [open, toggle] = useDisclosure(key, false);
  const detail = useId();
  if (!tool) return null;
  const failed = tool.status === "failed";
  const running = tool.status === "running";
  return (
    <div
      className="min-w-0"
      data-testid="coding-tool-row"
      data-call-id={tool.call_id}
      data-invocation-id={tool.invocation_id ?? undefined}
      data-tool-status={tool.status}
      data-reading-owner={tool.invocation_id ?? tool.call_id}
    >
      <div className="flex min-w-0 items-center gap-1">
        <ActivityLine
          icon={toolIcon(tool.display_kind)}
          label={tool.title || tool.name || "Tool"}
          status={statusText[tool.status] ?? null}
          tone={failed ? "failed" : running ? "running" : "default"}
          open={open}
          onToggle={toggle}
          control={`tool:${key}`}
          controls={detail}
        />
        {trailing}
      </div>
      {open && (
        <div id={detail} className="pl-6.5">
          <ToolDetail row={row} />
        </div>
      )}
    </div>
  );
}

/** Native public reasoning text only. Live thinking starts open, settled closed. */
export function ReasoningReport({
  row,
  itemKey,
  live,
}: {
  row: CodingRow;
  itemKey: string;
  live: boolean;
}) {
  const [open, toggle] = useDisclosure(itemKey, live);
  const detail = useId();
  return (
    <div
      className="min-w-0"
      data-testid="coding-reasoning"
      data-native-entry={row.id}
    >
      <ActivityLine
        icon={MessageCircleMore}
        label="Thought process"
        status={null}
        tone={live ? "running" : "default"}
        open={open}
        onToggle={toggle}
        control={`reasoning:${itemKey}`}
        controls={detail}
      />
      {open && (
        <div
          id={detail}
          className="max-h-80 overflow-auto overscroll-contain pb-2 pl-6.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Long public reasoning needs keyboard scrolling.
          tabIndex={0}
          onKeyDown={boundedContentKeyDown}
          aria-label="Public reasoning"
        >
          <MarkdownPreview
            markdown={row.text ?? ""}
            className="max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-sm leading-6 text-muted-foreground"
          />
          {row.clipped && (
            <p role="note" className="text-xs font-medium">
              Reasoning clipped to the presentation bound.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
