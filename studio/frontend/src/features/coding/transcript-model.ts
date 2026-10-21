// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { ChildIdentity } from "./child-types.ts";
import type { CodingRunState } from "./run-session.ts";
import type { CodingRow } from "./run-types.ts";

/** The native window the rows belong to. Only the latest window has a live
 * tail; a frozen historical reading window never infers liveness. */
export type TranscriptWindow =
  | { kind: "latest"; activeRequest: string | null }
  | { kind: "historical" };
export const latestWindow = (
  activeRequest: string | null = null,
): TranscriptWindow => ({ kind: "latest", activeRequest });
export const transcriptWindow = (
  state: CodingRunState | null,
): TranscriptWindow =>
  state?.viewingEarlier
    ? { kind: "historical" }
    : latestWindow(state?.native?.active_request ?? null);

/** Chronological presentation of immutable native rows. It never edits a row,
 * invents a count, or reads tool names: grouping follows row order and request
 * identity, labels follow native `display_kind`. */
export type ActivityItem =
  | { kind: "reasoning"; key: string; row: CodingRow; live: boolean }
  | {
      kind: "tool";
      key: string;
      row: CodingRow;
      /** The exact attempt this invocation acted on, for the inspector link. */
      child: ChildIdentity | null;
    };
export interface ActivitySummary {
  text: string;
  failed: number;
  running: number;
}
export type TranscriptBlock =
  | { kind: "user"; key: string; row: CodingRow }
  | { kind: "prose"; key: string; row: CodingRow; turnEnd: boolean }
  | { kind: "answer"; key: string; row: CodingRow }
  | { kind: "plan"; key: string; row: CodingRow }
  | { kind: "notice"; key: string; row: CodingRow }
  | { kind: "semantic"; key: string; row: CodingRow }
  | { kind: "child"; key: string; row: CodingRow; child: ChildIdentity }
  | {
      kind: "activity";
      key: string;
      items: ActivityItem[];
      summary: ActivitySummary;
      live: boolean;
      /** Subagent invocations only: kept out of ordinary tool folds. */
      agents: boolean;
    };

/** Native row identity. Invocation and answer identities also correlate a live
 * row with its later saved row. Live text, reasoning and user rows
 * (`{kind}:{run}:{turn}:{attempt}:{index}`, `live:{position}`) have no saved
 * correlate, so those blocks remount once at the checkpoint that saves them. */
export function readingRowKey(row: CodingRow): string {
  if (row.answer)
    return `answer:${row.answer.request_id}:${row.answer.user_request_id}`;
  if (row.tool?.invocation_id) return `invocation:${row.tool.invocation_id}`;
  return `row:${row.id}`;
}

/** The exact attempt a tool invocation acted on, or null. Agent-looking tools
 * without that identity get no inspector link. */
export function toolChild(row: CodingRow): ChildIdentity | null {
  const run = row.tool?.subagent;
  return run?.attempt && run.agent_id
    ? { handle: run.agent_id, attempt: run.attempt }
    : null;
}

const semantic = (row: CodingRow) =>
  row.tool?.semantic_content === "answer_markdown" ||
  row.tool?.semantic_content === "report_markdown";

type Count = { one: string; many: string };
const verbs: [string, string, Count][] = [
  ["shell", "ran", { one: "command", many: "commands" }],
  ["file_change", "edited", { one: "file", many: "files" }],
  ["file_read", "read", { one: "file", many: "files" }],
  ["image_view", "viewed", { one: "image", many: "images" }],
  ["search", "searched", { one: "time", many: "times" }],
  ["web", "used the web", { one: "time", many: "times" }],
  ["status", "updated status", { one: "time", many: "times" }],
  ["other", "called", { one: "tool", many: "tools" }],
];
/** Native display kind -> summary bucket. Unknown kinds are just tools. */
export function activityBucket(kind: string | null | undefined): string {
  switch (kind) {
    case "shell":
    case "file_change":
    case "file_read":
    case "image_view":
    case "web":
    case "status":
      return kind;
    case "file_content_search":
    case "file_path_search":
      return "search";
    default:
      return "other";
  }
}
const plural = (n: number, count: Count) =>
  `${n} ${n === 1 ? count.one : count.many}`;

export function summarizeActivity(
  items: readonly ActivityItem[],
): ActivitySummary {
  let thoughts = 0;
  let failed = 0;
  let running = 0;
  const buckets = new Map<string, number>();
  const edited = new Set<string>();
  for (const item of items) {
    if (item.kind === "reasoning") {
      thoughts++;
      if (item.live) running++;
      continue;
    }
    const tool = item.row.tool;
    if (!tool) continue;
    if (tool.status === "failed") failed++;
    if (tool.status === "running") running++;
    const bucket = activityBucket(tool.display_kind);
    if (bucket === "file_change") {
      // Distinct reported paths; a call without a typed profile counts once.
      const files = tool.output_profile?.files ?? [];
      if (files.length)
        for (const file of files) edited.add(`path:${file.path}`);
      else edited.add(`call:${item.key}`);
      continue;
    }
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  if (edited.size) buckets.set("file_change", edited.size);
  const segments: string[] = [];
  if (thoughts === 1) segments.push("thought process");
  else if (thoughts > 1) segments.push(`thought ${thoughts} times`);
  for (const [bucket, verb, count] of verbs) {
    const n = buckets.get(bucket);
    if (!n) continue;
    segments.push(
      bucket === "status" && n === 1 ? verb : `${verb} ${plural(n, count)}`,
    );
  }
  if (failed) segments.push(`${failed} failed`);
  const text = segments.join(" · ");
  return {
    text: text ? text[0].toUpperCase() + text.slice(1) : "Activity",
    failed,
    running,
  };
}

const sameItems = (a: readonly ActivityItem[], b: readonly ActivityItem[]) =>
  a.length === b.length &&
  a.every(
    (item, index) =>
      item.key === b[index].key &&
      item.row === b[index].row &&
      (item.kind !== "reasoning" ||
        item.live === (b[index] as typeof item).live),
  );
function reusable(prior: TranscriptBlock | undefined, next: TranscriptBlock) {
  if (!prior || prior.kind !== next.kind || prior.key !== next.key)
    return false;
  if (next.kind === "activity")
    return (
      prior.kind === "activity" &&
      prior.live === next.live &&
      sameItems(prior.items, next.items)
    );
  if (prior.kind === "activity") return false;
  return (
    prior.row === next.row &&
    (next.kind !== "prose" ||
      (prior.kind === "prose" && prior.turnEnd === next.turnEnd))
  );
}

/** Project rows into blocks. Only the tail of `activeRequest` is live. */
export function projectTranscript(
  rows: readonly CodingRow[],
  window: TranscriptWindow,
  prior: ReadonlyMap<string, TranscriptBlock> = new Map(),
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const seenChildren = new Set<string>();
  const lastRow = rows.at(-1);
  const latest = window.kind === "latest";
  const tailLive =
    latest &&
    window.activeRequest !== null &&
    lastRow?.request_id === window.activeRequest;
  let group: ActivityItem[] = [];
  let groupRequest: string | null = null;
  let groupAgents = false;
  const flush = () => {
    if (!group.length) return;
    const items = group;
    group = [];
    const summary = summarizeActivity(items);
    blocks.push({
      kind: "activity",
      key: `activity:${items[0].key}`,
      items,
      summary,
      live:
        latest &&
        (summary.running > 0 || (tailLive && items.at(-1)?.row === lastRow)),
      agents: groupAgents,
    });
  };
  const add = (item: ActivityItem, agents: boolean) => {
    const request = item.row.request_id ?? null;
    if (group.length && (groupRequest !== request || groupAgents !== agents))
      flush();
    groupRequest = request;
    groupAgents = agents;
    group.push(item);
  };
  for (const row of rows) {
    if (row.kind === "reasoning") {
      if (!row.text?.trim()) continue;
      const live = tailLive && row === lastRow;
      add({ kind: "reasoning", key: readingRowKey(row), row, live }, false);
      continue;
    }
    if (row.tool && !semantic(row)) {
      // Every invocation stays its own item with its public result, including
      // several calls on one delegated attempt.
      const child = toolChild(row);
      add(
        { kind: "tool", key: readingRowKey(row), row, child },
        Boolean(child),
      );
      continue;
    }
    flush();
    if (row.child) {
      // Lifecycle records of one exact attempt are one slot.
      const key = `child:${row.child.handle}:${row.child.attempt}`;
      if (seenChildren.has(key)) continue;
      seenChildren.add(key);
      blocks.push({
        kind: "child",
        key,
        row,
        child: { handle: row.child.handle, attempt: row.child.attempt },
      });
    } else if (row.tool) {
      blocks.push({ kind: "semantic", key: readingRowKey(row), row });
    } else if (row.answer) {
      blocks.push({ kind: "answer", key: readingRowKey(row), row });
    } else if (row.plan) {
      blocks.push({ kind: "plan", key: readingRowKey(row), row });
    } else if (row.kind === "user") {
      blocks.push({ kind: "user", key: readingRowKey(row), row });
    } else if (row.kind === "assistant") {
      if (!row.text?.trim() && !row.clipped) continue;
      blocks.push({
        kind: "prose",
        key: readingRowKey(row),
        row,
        turnEnd: false,
      });
    } else {
      blocks.push({ kind: "notice", key: readingRowKey(row), row });
    }
  }
  flush();
  // The last reply text before the next prompt ends a turn (copy affordance).
  let turnOpen = !tailLive;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.kind === "user") turnOpen = true;
    else if (block.kind === "prose" && turnOpen) {
      blocks[index] = { ...block, turnEnd: true };
      turnOpen = false;
    }
  }
  // Malformed duplicate identities must not collapse two rows into one key.
  const used = new Map<string, number>();
  return blocks.map((original) => {
    const count = used.get(original.key) ?? 0;
    used.set(original.key, count + 1);
    const block = count
      ? { ...original, key: `${original.key}#${count}` }
      : original;
    const previous = prior.get(block.key);
    return previous && reusable(previous, block) ? previous : block;
  });
}

/** Holds the previous projection so unchanged blocks keep their identity. */
export function createTranscriptProjection() {
  let rows: readonly CodingRow[] | null = null;
  let shown: TranscriptWindow | null = null;
  let blocks: TranscriptBlock[] = [];
  let byKey = new Map<string, TranscriptBlock>();
  const same = (a: TranscriptWindow | null, b: TranscriptWindow) =>
    a?.kind === b.kind &&
    (a.kind === "historical" ||
      (b.kind === "latest" && a.activeRequest === b.activeRequest));
  return {
    project(next: readonly CodingRow[], window: TranscriptWindow) {
      if (next === rows && same(shown, window)) return blocks;
      rows = next;
      shown = window;
      blocks = projectTranscript(next, window, byKey);
      byKey = new Map(blocks.map((block) => [block.key, block]));
      return blocks;
    },
  };
}
export type TranscriptProjection = ReturnType<
  typeof createTranscriptProjection
>;
