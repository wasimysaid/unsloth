// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import type { CodingRunState } from "../src/features/coding/run-session.ts";
import type { CodingRow } from "../src/features/coding/run-types.ts";
import {
  createTranscriptProjection,
  projectTranscript,
  summarizeActivity,
  latestWindow,
} from "../src/features/coding/transcript-model.ts";

function tool(
  id: string,
  options: {
    request?: string;
    kind?: string | null;
    status?: string;
    invocation?: string;
    entry?: string;
  } = {},
): CodingRow {
  const request = options.request ?? "request";
  return {
    id: options.entry ?? id,
    kind: "tool",
    request_id: request,
    tool: {
      invocation_id: options.invocation ?? id,
      call_id: `call-${id}`,
      request_id: request,
      name: "native_tool",
      title: `Tool ${id}`,
      status: options.status ?? "completed",
      output: "Public",
      clipped: false,
      quiet: false,
      row_group: null,
      display_kind: options.kind ?? null,
    },
  };
}
const text = (id: string, value: string, request = "request"): CodingRow => ({
  id,
  kind: "assistant",
  text: value,
  request_id: request,
});
const thought = (
  id: string,
  value: string,
  request = "request",
): CodingRow => ({
  id,
  kind: "reasoning",
  text: value,
  request_id: request,
});
const user = (id: string, request: string): CodingRow => ({
  id,
  kind: "user",
  text: "Prompt",
  request_id: request,
});

test("consecutive reasoning and tools form one chronological activity tree; text and requests split it", () => {
  const rows = [
    user("u", "request"),
    thought("r1", "Look first"),
    tool("one", { kind: "mcp" }),
    thought("r2", "Then run"),
    tool("two", { kind: "shell" }),
    text("t", "Reply"),
    tool("three", { kind: "shell" }),
    tool("four", { kind: "shell", request: "other" }),
  ];
  const before = structuredClone(rows);
  const blocks = projectTranscript(rows, latestWindow());
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["user", "activity", "prose", "activity", "activity"],
  );
  const first = blocks[1];
  assert.equal(first.kind, "activity");
  if (first.kind !== "activity") return;
  assert.deepEqual(
    first.items.map((item) => [item.kind, item.row.id]),
    [
      ["reasoning", "r1"],
      ["tool", "one"],
      ["reasoning", "r2"],
      ["tool", "two"],
    ],
  );
  assert.equal(
    first.summary.text,
    "Thought 2 times · ran 1 command · called 1 tool",
  );
  assert.deepEqual(rows, before, "presentation never mutates native rows");
  assert.equal(
    first.items[1].row,
    rows[2],
    "items carry the native row itself",
  );
});

test("summaries come from native display kinds and report failures; nothing is invented", () => {
  const edit = (id: string, path: string) => {
    const row = tool(id, { kind: "file_change" });
    if (row.tool)
      row.tool.output_profile = {
        kind: "file_change",
        truncated: false,
        files: [
          {
            path,
            status: "modified",
            additions: 1,
            deletions: 0,
            hunks: [],
            binary: false,
            partial: false,
            truncated: false,
          },
        ],
      };
    return row;
  };
  const items = [
    tool("a", { kind: "shell", status: "failed" }),
    tool("b", { kind: "file_read" }),
    tool("c", { kind: "file_content_search" }),
    tool("d", { kind: "file_path_search" }),
    edit("e", "src/a.ts"),
    edit("f", "src/a.ts"),
    edit("g", "src/b.ts"),
    tool("h", { kind: "status" }),
    tool("i", { kind: "a_future_kind" }),
  ].map((row) => ({ kind: "tool" as const, key: row.id, row, child: null }));
  const summary = summarizeActivity(items);
  assert.equal(
    summary.text,
    "Ran 1 command · edited 2 files · read 1 file · searched 2 times · updated status · called 1 tool · 1 failed",
  );
  assert.equal(summary.failed, 1);
  // Tool names never drive labels, and empty public reasoning is not a thought.
  const [block] = projectTranscript(
    [thought("empty", "   "), tool("named-shell")],
    latestWindow(),
  );
  assert.equal(block.kind, "activity");
  if (block.kind === "activity") {
    assert.equal(block.items.length, 1);
    assert.equal(block.summary.text, "Called 1 tool");
  }
});

test("semantic public answers and delegated attempts stay visible in their chronological slot", () => {
  const answer = tool("answer");
  if (answer.tool) answer.tool.semantic_content = "answer_markdown";
  const spawn = tool("spawn", { kind: "agent" });
  if (spawn.tool)
    spawn.tool.subagent = {
      agent_id: "child-handle",
      attempt: 1,
      agent: "explorer",
      description: "Scan repo",
      status: "running",
    };
  const unnamed = tool("agent-like", { kind: "agent" });
  if (unnamed.tool)
    unnamed.tool.subagent = {
      agent_id: "x",
      attempt: null,
      agent: "explorer",
      description: "No attempt identity",
      status: "running",
    };
  const saved: CodingRow = {
    id: "child-row",
    kind: "child",
    child: {
      handle: "child-handle",
      attempt: 1,
      status: "completed",
      completion_pending: false,
      cut: null,
    },
  };
  const blocks = projectTranscript(
    [tool("one"), answer, tool("two"), spawn, unnamed, saved],
    latestWindow(),
  );
  // Subagent invocations never share a fold with ordinary tools.
  assert.deepEqual(
    blocks.map((block) => [
      block.kind,
      block.kind === "activity" && block.agents,
    ]),
    [
      ["activity", false],
      ["semantic", false],
      ["activity", false],
      ["activity", true],
      ["activity", false],
      ["child", false],
    ],
  );
  const launched = blocks[3];
  assert.deepEqual(
    launched.kind === "activity" && launched.items[0].kind === "tool"
      ? launched.items[0].child
      : null,
    { handle: "child-handle", attempt: 1 },
  );
  const anonymous = blocks[4];
  assert.equal(
    anonymous.kind === "activity" && anonymous.items[0].kind === "tool"
      ? anonymous.items[0].child
      : undefined,
    null,
    "no exact attempt identity, no inspector link",
  );
  assert.equal(
    blocks[5].kind === "child" && blocks[5].key,
    "child:child-handle:1",
  );
});

test("invocation and answer identities survive provisional -> saved; other rows keep their native identity", () => {
  // Shapes from the studio.frontend projection: live text/reasoning rows are
  // `{kind}:{run}:{turn}:{attempt}:{index}`, saved ones `{entry}:{index}`.
  const answer = (id: string): CodingRow => ({
    id,
    kind: "user",
    answer: { request_id: "request", user_request_id: "q", answers: [] },
  });
  const live = [
    { ...user("live:1", "request") },
    thought("reasoning:run:1:0:0", "Thinking"),
    tool("tool:inv", { invocation: "inv" }),
    answer("answer:live:3"),
    text("assistant:run:1:0:2", "Answer"),
  ];
  const saved = [
    { ...user("entry-u", "request") },
    thought("entry-a:0", "Thinking"),
    tool("entry-a:1", { invocation: "inv" }),
    answer("answer:entry-q"),
    text("entry-a:2", "Answer"),
  ];
  const keys = (rows: CodingRow[]) =>
    projectTranscript(rows, latestWindow()).flatMap((block) =>
      block.kind === "activity"
        ? block.items.map((item) => item.key)
        : [block.key],
    );
  const [liveKeys, savedKeys] = [keys(live), keys(saved)];
  assert.equal(liveKeys[2], savedKeys[2], "the invocation correlates");
  assert.equal(liveKeys[3], savedKeys[3], "the accepted answer correlates");
  assert.deepEqual(
    [liveKeys[0], liveKeys[1], liveKeys[4]],
    ["row:live:1", "row:reasoning:run:1:0:0", "row:assistant:run:1:0:2"],
  );
  assert.deepEqual(
    [savedKeys[0], savedKeys[1], savedKeys[4]],
    ["row:entry-u", "row:entry-a:0", "row:entry-a:2"],
  );
});

test("unchanged native rows reuse block identity; one changed row changes one block", () => {
  const projection = createTranscriptProjection();
  const rows = [
    user("u", "request"),
    tool("one"),
    tool("two"),
    text("t", "Reply"),
  ];
  const first = projection.project(rows, latestWindow());
  assert.equal(
    projection.project(rows, latestWindow()),
    first,
    "same input, same result",
  );
  const changed = [...rows];
  changed[3] = text("t", "Reply, revised");
  const second = projection.project(changed, latestWindow());
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1], "activity group reused by row identity");
  assert.notEqual(second[2], first[2]);
});

test("live state: the running tail opens, settled work does not; turn ends only when complete", () => {
  const rows = [
    user("u1", "one"),
    text("t1", "Done", "one"),
    user("u2", "two"),
    thought("r", "Working", "two"),
  ];
  const running = projectTranscript(rows, latestWindow("two"));
  const tail = running.at(-1);
  assert.equal(tail?.kind, "activity");
  if (tail?.kind === "activity") {
    assert.equal(tail.live, true);
    assert.equal(
      tail.items[0].kind === "reasoning" && tail.items[0].live,
      true,
    );
  }
  const prose = running.find((block) => block.kind === "prose");
  assert.equal(prose?.kind === "prose" && prose.turnEnd, true);
  const settled = projectTranscript(rows, latestWindow()).at(-1);
  assert.equal(settled?.kind === "activity" && settled.live, false);
  const finished = projectTranscript(
    [...rows, text("t2", "Answer", "two")],
    latestWindow("two"),
  ).at(-1);
  assert.equal(
    finished?.kind === "prose" && finished.turnEnd,
    false,
    "a still-running reply is not a finished turn",
  );
  const runningTool = projectTranscript(
    [tool("x", { status: "running" })],
    latestWindow(),
  )[0];
  assert.equal(
    runningTool.kind === "activity" && runningTool.live,
    true,
    "a natively running invocation is live even without an active request flag",
  );
});

test("malformed duplicate identities never share a presentation key", () => {
  const blocks = projectTranscript(
    [
      { id: "same", kind: "notice", text: "One" },
      { id: "same", kind: "notice", text: "Two" },
    ],
    latestWindow(),
  );
  assert.equal(new Set(blocks.map((block) => block.key)).size, 2);
});

const savedRow = (
  entry: string,
  index: number | null,
  kind: CodingRow["kind"],
  text: string,
  request = "request",
): CodingRow => ({
  id: index === null ? entry : `${entry}:${index}`,
  entry_id: entry,
  kind,
  text,
  request_id: request,
  historical: true,
});
const savedTool = (entry: string, invocation: string): CodingRow => ({
  ...tool(`${entry}:0`, { invocation }),
  entry_id: entry,
  historical: true,
});
/** Presentation key -> the native row it renders (an activity group's anchor). */
function identities(rows: CodingRow[]) {
  const keys = new Map<string, string>();
  for (const block of projectTranscript(rows, latestWindow())) {
    if (block.kind === "activity") {
      keys.set(block.key, block.items[0].row.id);
      for (const item of block.items) keys.set(item.key, item.row.id);
    } else keys.set(block.key, block.row.id);
  }
  return keys;
}
function assertNoTransfer(
  before: Map<string, string>,
  after: Map<string, string>,
  label: string,
) {
  for (const [key, row] of after)
    if (before.has(key))
      assert.equal(
        row,
        before.get(key),
        `${label}: ${key} moved to other content`,
      );
  const rowKeys = (map: Map<string, string>) =>
    new Map(
      [...map]
        .filter(([key]) => !key.startsWith("activity:"))
        .map(([k, r]) => [r, k]),
    );
  const kept = rowKeys(after);
  for (const [row, key] of rowKeys(before))
    if (kept.has(row))
      assert.equal(kept.get(row), key, `${label}: ${row} changed key`);
}

test("prepending or evicting saved rows never moves a key to other native content", () => {
  const earlier = [
    savedRow("e1", null, "user", "Prompt"),
    savedRow("e2", 0, "reasoning", "First thought"),
    savedRow("e2", 1, "assistant", "First reply"),
    savedTool("e3", "inv-3"),
  ];
  const later = [
    savedRow("e5", 0, "reasoning", "Later thought"),
    savedRow("e5", 1, "assistant", "Later reply"),
    savedTool("e6", "inv-6"),
    savedRow("e7", 0, "assistant", "Final answer"),
  ];
  const window = identities(later);
  const prepended = identities([...earlier, ...later]);
  assertNoTransfer(window, prepended, "prepend");
  const evicted = identities([...earlier, ...later].slice(3));
  assertNoTransfer(prepended, evicted, "evict");
});

test("a completed group of another request is not live while a new request runs", () => {
  const rows = [
    savedRow("e1", null, "user", "Old prompt", "old"),
    savedRow("e2", 0, "reasoning", "Old thought", "old"),
    { ...tool("e3", { request: "old" }), historical: true },
  ];
  const tail = projectTranscript(rows, latestWindow("new")).at(-1);
  assert.equal(tail?.kind, "activity");
  if (tail?.kind === "activity") {
    assert.equal(tail.live, false);
    assert.equal(
      tail.items[0].kind === "reasoning" && tail.items[0].live,
      false,
    );
  }
  const own = projectTranscript(rows, latestWindow("old")).at(-1);
  assert.equal(
    own?.kind === "activity" && own.live,
    true,
    "its own active request is live",
  );
  const frozen = projectTranscript(rows, { kind: "historical" }).at(-1);
  assert.equal(
    frozen?.kind === "activity" && frozen.live,
    false,
    "the same rows frozen in a historical window are not live",
  );
});

test("every subagent tool invocation keeps its public result; lifecycle rows dedupe", () => {
  const subagent = {
    agent_id: "child-h",
    attempt: 1,
    agent: "explorer",
    description: "Survey the repo",
    status: "running" as const,
  };
  const launch = tool("launch", { kind: "agent", invocation: "inv-1" });
  const refused = tool("message", {
    kind: "agent",
    invocation: "inv-2",
    status: "failed",
  });
  if (launch.tool && refused.tool) {
    launch.tool.subagent = subagent;
    refused.tool.subagent = subagent;
    refused.tool.output = "Refused: the subagent is not accepting messages";
  }
  const lifecycle: CodingRow = {
    id: "entry-c:0",
    kind: "child",
    child: {
      handle: "child-h",
      attempt: 1,
      status: "running",
      completion_pending: false,
      cut: null,
    },
  };
  const blocks = projectTranscript(
    [
      user("u", "request"),
      launch,
      refused,
      lifecycle,
      { ...lifecycle, id: "entry-d:0" },
    ],
    latestWindow(),
  );
  const items = blocks.flatMap((block) =>
    block.kind === "activity" ? block.items : [],
  );
  assert.deepEqual(
    items.map((item) => item.key),
    ["invocation:inv-1", "invocation:inv-2"],
  );
  assert.equal(items[1].row.tool?.status, "failed");
  assert.match(items[1].row.tool?.output ?? "", /Refused/);
  for (const item of items)
    assert.deepEqual(item.kind === "tool" && item.child, {
      handle: "child-h",
      attempt: 1,
    });
  assert.equal(blocks.filter((block) => block.kind === "child").length, 1);
});

test("a frozen historical window of the still-active request infers nothing live", () => {
  // Saved rows of request R are its genuine tail in the latest window, but the
  // same rows in a frozen reading window must not spin or open themselves.
  const rows = [
    savedRow("e1", null, "user", "Prompt", "R"),
    savedRow("e2", 0, "reasoning", "Thinking", "R"),
    { ...tool("e3", { request: "R" }), historical: true },
  ];
  const state = (viewingEarlier: boolean) =>
    ({
      connection: "connected",
      recovering: false,
      stopping: null,
      storageError: null,
      viewingEarlier,
      rows,
      native: { active_request: "R" },
    }) as unknown as CodingRunState;
  const tail = (viewingEarlier: boolean) =>
    codingRunAdapter(state(viewingEarlier), null).messages?.at(-1);
  const frozen = tail(true);
  assert.equal(frozen?.kind, "activity");
  if (frozen?.kind === "activity") {
    assert.equal(frozen.live, false, "no inferred spinner or auto-open");
    assert.equal(
      frozen.items[0].kind === "reasoning" && frozen.items[0].live,
      false,
    );
    assert.equal(
      frozen.items[1].row.tool?.status,
      "completed",
      "supplied tool status is shown as supplied",
    );
  }
  const latest = tail(false);
  assert.equal(
    latest?.kind === "activity" && latest.live,
    true,
    "the latest window keeps its genuine live tail",
  );
});
