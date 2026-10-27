// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { childStatusLabel } from "../src/features/coding/child-types.ts";
import type {
  ChildAttempt,
  ChildDetail,
  ChildOutcome,
} from "../src/features/coding/child-types.ts";
import { createChildView } from "../src/features/coding/child-view.ts";
import type {
  CodingRow,
  EntryPage,
  JournalCut,
} from "../src/features/coding/run-types.ts";

const child = (
  attempt = 1,
  status: ChildAttempt["status"] = "running",
): ChildAttempt => ({
  handle: "agent-exact",
  attempt,
  status,
  completion_pending: status === "completed",
  cut: { journal: { child: "agent-exact" }, leaf: `attempt-${attempt}` },
  description: `Task ${attempt}`,
});
const outcome = (
  attempt = 1,
  status: ChildOutcome["status"] = "completed",
): ChildOutcome => ({
  handle: "agent-exact",
  attempt,
  status,
  result: `Result ${attempt}`,
  error: status === "failed" ? "Exact failure" : null,
});
function harness() {
  const reads: unknown[] = [];
  let rows: CodingRow[] = [
    { id: "saved", kind: "assistant", text: "Bounded saved child reply" },
  ];
  let retained: ChildOutcome | null = null;
  let detailChild: ChildAttempt | null = null;
  const view = createChildView("parent", {
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
    },
    async readEntries(id, cut, anchor): Promise<EntryPage> {
      reads.push({ id, cut, anchor });
      return {
        cut,
        rows,
        older: false,
        newer: false,
        first_id: rows[0]?.id ?? null,
        last_id: rows.at(-1)?.id ?? null,
      };
    },
    async readChild(id, handle, attempt): Promise<ChildDetail> {
      reads.push({ id, handle, attempt });
      return { child: detailChild, outcome: retained };
    },
  });
  return {
    view,
    reads,
    setRows: (value: CodingRow[]) => {
      rows = value;
    },
    setOutcome: (value: ChildOutcome | null) => {
      retained = value;
    },
    setDetail: (value: ChildAttempt | null) => {
      detailChild = value;
    },
  };
}

test("child latest and earlier history use complete entry resolution while uninspected deltas keep their exact base", async () => {
  const cut = child().cut!;
  const rows: CodingRow[] = [
    { id: "full", entry_id: "entry", kind: "assistant", text: "complete 漢🙂" },
  ];
  const ref = {
    cut,
    entry_id: "entry",
  };
  const view = createChildView("parent", {
    async readChild() {
      return { child: null, outcome: null };
    },
    async readPublicEntry(_id, reference) {
      assert.deepEqual(reference, { ...ref, cut: reference.cut });
      assert.ok(["attempt-1", "attempt-2"].includes(reference.cut.leaf!));
      return rows;
    },
    async readEntries(_id, captured, anchor) {
      const latest = anchor === "latest";
      const referenced = !latest || captured.leaf === "attempt-2";
      return {
        cut: captured,
        rows: !referenced
          ? [
              {
                id: "saved",
                entry_id: "saved",
                kind: "assistant",
                text: "latest",
              },
            ]
          : [
              {
                id: "entry",
                entry_id: "entry",
                request_id: null,
                kind: "content_ref",
                content_ref: { ...ref, cut: captured },
              },
            ],
        older: latest,
        newer: !latest,
        first_id: referenced ? "entry" : "saved",
        last_id: referenced ? "entry" : "saved",
      };
    },
  });
  await view.capture([child(), child(2)], []);
  view.setConnected(true);
  const row = {
    id: "live",
    entry_id: null,
    request_id: "child-request",
    kind: "assistant" as const,
  };
  view.textDelta(child(2), {
    type: "text_delta",
    row,
    offset: 0,
    delta: "漢🙂",
  });
  await view.open(child());
  view.textDelta(child(2), {
    type: "text_delta",
    row,
    offset: 7,
    delta: " tail",
  });
  await view.open(child(2));
  assert.equal(
    view.getSnapshot().inspection?.rows.find((item) => item.id === "live")
      ?.text,
    "漢🙂 tail",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    view.getSnapshot().inspection?.rows.find((item) => item.id === "full")
      ?.text,
    "complete 漢🙂",
  );
  await view.open(child());
  await view.loadEarlier();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    view.getSnapshot().inspection?.rows.map((item) => item.text),
    ["complete 漢🙂"],
  );
  assert.equal(
    view
      .getSnapshot()
      .inspection?.rows.some((item) => item.kind === "content_ref"),
    false,
  );
  view.detach();
});

test("uninspected child activity stays complete across selection and close/reopen", async () => {
  const h = harness();
  await h.view.capture([child()], []);
  h.setRows([]);
  h.view.activity(child(), [
    { id: "live-1", kind: "assistant", text: "x".repeat(600000) },
    { id: "live-2", kind: "reasoning", text: "y".repeat(600000) },
  ]);
  await h.view.open(child());
  assert.deepEqual(
    h.view.getSnapshot().inspection?.rows.map((row) => row.id),
    ["live-1", "live-2"],
  );
  h.view.close();
  await h.view.open(child());
  assert.deepEqual(
    h.view.getSnapshot().inspection?.rows.map((row) => row.id),
    ["live-1", "live-2"],
  );
  h.view.detach();
});

test("child single saved entry is retained in full even when it exceeds the window", async () => {
  const h = harness();
  h.setRows([
    { id: "a", entry_id: "only", kind: "assistant", text: "x".repeat(400000) },
    { id: "b", entry_id: "only", kind: "reasoning", text: "y".repeat(400000) },
  ]);
  await h.view.capture([child()], []);
  await h.view.open(child());
  assert.deepEqual(
    h.view.getSnapshot().inspection?.rows.map((row) => row.id),
    ["a", "b"],
  );
  h.view.detach();
});

test("captured native children are compact and lazy; inspection reads only exact captured cut and outcome", async () => {
  const h = harness();
  await h.view.capture([child()], []);
  h.view.setConnected(true);
  assert.equal(h.reads.length, 0);
  await h.view.open(child());
  assert.deepEqual(h.reads, [
    { id: "parent", cut: child().cut, anchor: "latest" },
    { id: "parent", handle: "agent-exact", attempt: 1 },
  ]);
  assert.equal(h.view.getSnapshot().inspection?.rows[0].historical, true);
  assert.equal(h.view.getSnapshot().inspection?.outcome, null);
  assert.equal(
    h.view.getSnapshot().attempts[0].status,
    "running",
    "launch/view acceptance is not terminal",
  );
  h.view.detach();
});

test("continued attempt keeps prior cut and terminal outcome and isolates later activity", async () => {
  const h = harness();
  const first = child(1, "completed");
  h.setOutcome(outcome());
  await h.view.capture([first], []);
  await h.view.open(first);
  const retained = h.view.getSnapshot().inspection?.outcome;
  await h.view.child(child(2));
  h.view.activity(child(2), [
    { id: "second-live", kind: "assistant", text: "New attempt" },
  ]);
  assert.deepEqual(h.view.getSnapshot().inspection?.outcome, retained);
  assert.deepEqual(h.view.getSnapshot().inspection?.cut, first.cut);
  assert.equal(
    h.view
      .getSnapshot()
      .inspection?.rows.some((row) => row.id === "second-live"),
    false,
  );
  const attempts = h.view.getSnapshot().attempts;
  assert.equal(attempts[0].historical, true);
  assert.match(childStatusLabel(attempts[0], true), /Historical.*not live/);
  assert.equal(attempts[1].historical, false);
  h.setOutcome(null);
  await h.view.open(child(2));
  assert.equal(h.view.getSnapshot().inspection?.outcome, null);
  h.setOutcome(outcome(1));
  await h.view.open(first);
  assert.deepEqual(h.view.getSnapshot().inspection?.outcome, outcome(1));
  h.view.detach();
});

test("saved historical terminal records upgrade historical launch observations but never override live current attempts", async () => {
  const h = harness();
  const historical = (c: ChildAttempt): CodingRow => ({
    id: `row-${c.status}`,
    kind: "child",
    child: c,
  });
  await h.view.capture(
    [child(2)],
    [
      historical(child(1)),
      historical(child(1, "failed")),
      historical(child(2, "completed")),
    ],
  );
  const first = h.view
    .getSnapshot()
    .attempts.find((item) => item.attempt === 1);
  assert.ok(first);
  assert.equal(first.status, "failed");
  assert.equal(first.historical, true);
  assert.equal(
    h.view.getSnapshot().attempts.find((item) => item.attempt === 2)?.status,
    "running",
  );
  h.view.history([historical(child(1))]);
  assert.equal(
    h.view.getSnapshot().attempts.find((item) => item.attempt === 1)?.status,
    "failed",
  );
  h.view.detach();
});

test("oversized detail read fills description without advancing ordered lifecycle or cut", async () => {
  const h = harness();
  const header = { ...child(), description: undefined, oversized: true };
  await h.view.capture([header], []);
  h.setDetail({
    ...child(1, "completed"),
    description: "Supported bounded details",
    cut: { journal: { child: "agent-exact" }, leaf: "future-cut" },
    clipped: true,
  });
  await h.view.open(header);
  assert.equal(
    h.view.getSnapshot().attempts[0].description,
    "Supported bounded details",
  );
  assert.equal(h.view.getSnapshot().attempts[0].status, "running");
  assert.deepEqual(h.view.getSnapshot().attempts[0].cut, header.cut);
  assert.equal(h.view.getSnapshot().attempts[0].clipped, true);
  h.view.detach();
});

test("mismatched outcome identity or nonterminal outcome is rejected instead of attributed to inspected attempt", async () => {
  const h = harness();
  await h.view.capture([child()], []);
  h.setOutcome(outcome(2));
  await h.view.open(child());
  assert.match(h.view.getSnapshot().inspection?.error ?? "", /another attempt/);
  assert.equal(h.view.getSnapshot().inspection?.outcome, null);
  h.setOutcome({ ...outcome(), status: "running" });
  await h.view.open(child());
  assert.match(
    h.view.getSnapshot().inspection?.error ?? "",
    /terminal attempt/,
  );
  h.view.detach();
});

test("child checkpoint replaces provisional reply and retains only exact live tool invocations", async () => {
  const h = harness();
  await h.view.capture([child()], []);
  await h.view.open(child());
  const tool: CodingRow = {
    id: "live-tool",
    kind: "tool",
    tool: {
      invocation_id: "exact",
      call_id: "call",
      request_id: null,
      name: "shell",
      title: "Work",
      output: "",
      status: "running",
      clipped: false,
      quiet: false,
      row_group: null,
    },
  };
  h.view.activity(child(), [
    { id: "live-text", kind: "assistant", text: "Partial" },
    tool,
  ]);
  h.setRows([
    { id: "saved-new", kind: "assistant", text: "Completed checkpoint" },
  ]);
  const cut: JournalCut = {
    journal: { child: "agent-exact" },
    leaf: "new-cut",
  };
  await h.view.checkpoint(child(), cut, ["exact"]);
  assert.deepEqual(
    h.view.getSnapshot().inspection?.rows.map((row) => row.id),
    ["saved-new", "live-tool"],
  );
  assert.deepEqual(h.view.getSnapshot().attempts[0].cut, cut);
  assert.throws(
    () =>
      h.view.checkpoint(
        child(),
        { journal: { child: "sibling" }, leaf: null },
        [],
      ),
    /another attempt or journal/,
  );
  h.view.detach();
});

test("disconnect and recapture rebuild selected exact identity without treating old work as live", async () => {
  const h = harness();
  await h.view.capture([child(1, "completed")], []);
  h.setOutcome(outcome());
  await h.view.open(child());
  h.view.setConnected(false);
  h.setOutcome(outcome());
  await h.view.capture([child(2)], []);
  h.view.setConnected(true);
  const snapshot = h.view.getSnapshot();
  assert.equal(snapshot.inspection?.attempt, 1);
  assert.deepEqual(snapshot.inspection?.outcome, outcome());
  assert.equal(
    snapshot.attempts.find((item) => item.attempt === 1)?.historical,
    true,
  );
  h.view.detach();
});

test("late reads after navigating attempts or dismissing cannot resurrect wrong result", async () => {
  let finish!: (page: EntryPage) => void;
  let pending = true;
  const view = createChildView("parent", {
    async readChild() {
      return { child: null, outcome: null };
    },
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
    },
    async readEntries(_id, cut) {
      if (pending) {
        pending = false;
        return await new Promise<EntryPage>((resolve) => {
          finish = resolve;
        });
      }
      return {
        cut,
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
      };
    },
  });
  await view.capture([child(1), child(2)], []);
  const opening = view.open(child(1));
  await view.open(child(2));
  const oldCut = child(1).cut;
  assert.ok(oldCut);
  finish({
    cut: oldCut,
    rows: [{ id: "old", kind: "assistant", text: "Stale" }],
    older: false,
    newer: false,
    first_id: "old",
    last_id: "old",
  });
  await opening;
  assert.equal(view.getSnapshot().inspection?.attempt, 2);
  assert.equal(view.getSnapshot().inspection?.rows.length, 0);
  view.close();
  assert.equal(view.getSnapshot().inspection, null);
});

test("large live transcripts retain every provisional row without a false omission notice", async () => {
  const h = harness();
  h.setRows([]);
  await h.view.capture([child()], []);
  await h.view.open(child());
  h.view.activity(
    child(),
    Array.from({ length: 500 }, (_, n) => ({
      id: String(n),
      kind: "assistant" as const,
      text: "x".repeat(4096),
    })),
  );
  const inspection = h.view.getSnapshot().inspection;
  assert.ok(inspection);
  assert.deepEqual(
    inspection.rows.map((row) => row.id),
    Array.from({ length: 500 }, (_, n) => String(n)),
  );
  assert.equal(
    inspection.rows.reduce((n, row) => n + (row.text?.length ?? 0), 0),
    500 * 4096,
  );
  assert.equal(h.view.getSnapshot().inspection?.bounded, false);
  h.view.detach();
});

test("historical unavailable cut never substitutes later journal and clipped result retains outcome identity", async () => {
  const h = harness();
  await h.view.capture(
    [child(2)],
    [
      {
        id: "old",
        kind: "child",
        child: { ...child(1, "completed"), cut: null },
      },
    ],
  );
  h.setOutcome({ ...outcome(1), result_clipped: true });
  h.reads.length = 0;
  await h.view.open(child(1));
  assert.deepEqual(h.reads, [
    { id: "parent", handle: "agent-exact", attempt: 1 },
  ]);
  assert.equal(h.view.getSnapshot().inspection?.cut, null);
  assert.equal(h.view.getSnapshot().inspection?.outcome?.result_clipped, true);
  h.view.detach();
});
