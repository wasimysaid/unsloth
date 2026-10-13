// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  codingRunCompletion,
  codingRunLabel,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type {
  CodingRow,
  EntryPage,
  JournalCut,
  NativeState,
  RunApi,
} from "../src/features/coding/run-types.ts";

const native = (active: string | null = null): NativeState => ({
  info: { id: "conversation", cwd: "/project" },
  configuration: {
    provider: "external",
    model: "model",
    reasoning: null,
    mode: "build",
  },
  active_request: active,
  requests: active
    ? [{ id: active, status: "running", submission_key: "key" }]
    : [],
  pending_user_request: false,
});
function harness() {
  let deliver!: (value: unknown) => Promise<void>;
  let connection: AbortSignal | null = null;
  let failWatch!: (reason: unknown) => void;
  let pos = 0;
  const reads: { cut: JournalCut; anchor: unknown }[] = [];
  const submissions: unknown[] = [];
  const cancellations: unknown[] = [];
  let rows: CodingRow[] = [];
  let submitError: Error | null = null;
  const api: RunApi = {
    async submit(id, key, text) {
      submissions.push({ id, key, text });
      if (submitError) throw submitError;
      return {
        conversation_id: id,
        request_id: "request",
        submission_key: key,
      };
    },
    async cancel(id, request) {
      cancellations.push({ id, request });
      return {
        conversation_id: id,
        request_id: request,
        cancel_requested: true,
      };
    },
    async readEntries(_id, cut, anchor) {
      reads.push({ cut, anchor });
      return {
        cut,
        rows,
        older: false,
        newer: false,
        first_id: rows[0]?.id ?? null,
        last_id: rows.at(-1)?.id ?? null,
      };
    },
    async watch(_id, signal, _connected, onView) {
      deliver = onView;
      connection = signal;
      await new Promise<void>((_resolve, reject) => {
        failWatch = reject;
      });
    },
  };
  const run = createCodingRun("conversation", api, () => "key");
  run.connect();
  const event = (event: unknown) =>
    deliver({ subscription: "view", position: ++pos, event });
  const start = (state = native(), recovering = false) =>
    event({
      type: "start",
      state,
      recovering,
      root: { cut: { journal: "root", leaf: "cut1" }, live_invocations: [] },
    });
  return {
    run,
    api,
    reads,
    submissions,
    cancellations,
    event,
    start,
    setRows(value: CodingRow[]) {
      rows = value;
    },
    setSubmitError(error: Error | null) {
      submitError = error;
    },
    signal: () => connection,
    failWatch: (reason: unknown) => failWatch(reason),
  };
}

test("initial capture reconstructs only its immutable history cut, without optimistic messages", async () => {
  const h = harness();
  const row: CodingRow = { id: "history1", kind: "user", text: "Saved input" };
  h.setRows([row]);
  await h.start();
  assert.deepEqual(h.reads, [
    { cut: { journal: "root", leaf: "cut1" }, anchor: "latest" },
  ]);
  assert.deepEqual(h.run.getSnapshot().rows, [{ ...row, historical: true }]);
  await h.run.send("New input");
  assert.deepEqual(h.submissions, [
    { id: "conversation", key: "key", text: "New input" },
  ]);
  assert.deepEqual(h.run.getSnapshot().rows, [{ ...row, historical: true }]);
  assert.equal(codingRunLabel(h.run.getSnapshot()), "Ready");
  h.run.detach();
});

test("checkpoint replaces provisional rows, preserves still-live exact tool invocation, and reset discards old branch", async () => {
  const h = harness();
  await h.start();
  const tool: CodingRow = {
    id: "live-tool",
    kind: "tool",
    tool: {
      invocation_id: "invocation",
      call_id: "call",
      request_id: "request",
      name: "shell",
      title: "Run shell",
      status: "running",
      output: "",
      clipped: false,
      quiet: false,
      row_group: null,
    },
  };
  await h.event({
    type: "activity",
    rows: [{ id: "provisional", kind: "assistant", text: "Partial" }, tool],
  });
  h.setRows([{ id: "saved", kind: "assistant", text: "Saved reply" }]);
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "cut2" },
    live_invocations: ["invocation"],
  });
  assert.deepEqual(h.reads.at(-1)?.anchor, { after: "cut1" });
  assert.deepEqual(
    h.run.getSnapshot().rows.map((row) => row.id),
    ["saved", "live-tool"],
  );
  h.setRows([{ id: "newbranch", kind: "user", text: "Different branch" }]);
  await h.event({
    type: "reset",
    state: native(),
    recovering: true,
    root: { cut: { journal: "root", leaf: "branch" }, live_invocations: [] },
  });
  assert.deepEqual(
    h.run.getSnapshot().rows.map((row) => row.id),
    ["newbranch"],
  );
  assert.equal(h.run.getSnapshot().recovering, true);
  await assert.rejects(h.run.send("must not run"), /reconstructed/);
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "branch" },
    live_invocations: [],
  });
  assert.equal(h.run.getSnapshot().recovering, false);
  h.run.detach();
});

test("Stop addresses the captured active request and stays stopping through acceptance and unrelated completion", async () => {
  const h = harness();
  await h.start(native("exact-request"));
  await h.run.stop();
  assert.deepEqual(h.cancellations, [
    { id: "conversation", request: "exact-request" },
  ]);
  assert.match(codingRunLabel(h.run.getSnapshot()), /^Stopping/);
  await h.event({ type: "state", state: native("different-queued-request") });
  await h.event({
    type: "completed",
    request_id: "unrelated",
    stop_reason: "completed",
    error: null,
  });
  assert.equal(h.run.getSnapshot().stopping, "exact-request");
  await h.run.stop();
  assert.equal(h.cancellations.length, 1);
  await h.event({
    type: "completed",
    request_id: "exact-request",
    stop_reason: "cancelled",
    error: "Native cleanup failed",
  });
  assert.equal(h.run.getSnapshot().stopping, null);
  assert.equal(h.run.getSnapshot().completion?.error, "Native cleanup failed");
  h.run.detach();
});

test("request feedback never attributes an earlier failure to a later running or stopping request", async () => {
  const h = harness();
  await h.start(native("old-request"));
  const failed = native();
  failed.requests = [
    { id: "old-request", status: "failed", submission_key: "old-key" },
  ];
  await h.event({ type: "state", state: failed });
  await h.event({
    type: "completed",
    request_id: "old-request",
    stop_reason: "error",
    error: "Old provider failure",
  });
  assert.equal(
    codingRunCompletion(h.run.getSnapshot())?.error,
    "Old provider failure",
  );
  await h.event({ type: "state", state: native("new-request") });
  assert.equal(codingRunLabel(h.run.getSnapshot()), "Running");
  assert.equal(codingRunCompletion(h.run.getSnapshot()), null);
  await h.run.stop();
  assert.match(codingRunLabel(h.run.getSnapshot()), /^Stopping/);
  assert.equal(codingRunCompletion(h.run.getSnapshot()), null);
  const complete = native();
  complete.requests = [
    { id: "new-request", status: "completed", submission_key: "new-key" },
  ];
  await h.event({ type: "state", state: complete });
  // Failure from this exact request must remain visible after native cleanup,
  // including if its saved terminal status arrived before the completion item.
  await h.event({
    type: "completed",
    request_id: "new-request",
    stop_reason: "error",
    error: "Current cleanup failure",
  });
  assert.equal(
    codingRunCompletion(h.run.getSnapshot())?.error,
    "Current cleanup failure",
  );
  assert.match(codingRunLabel(h.run.getSnapshot()), /^Failed/);
  await h.event({ type: "state", state: native("third-request") });
  const third = native();
  third.requests = [
    { id: "third-request", status: "completed", submission_key: "third-key" },
  ];
  await h.event({ type: "state", state: third });
  assert.equal(codingRunCompletion(h.run.getSnapshot()), null);
  assert.equal(
    codingRunLabel(h.run.getSnapshot()),
    "Completed",
    "old completion cannot corrupt a newer native terminal label",
  );
  h.run.detach();
});

test("disconnect never reports stopped and detach only cancels viewing", async () => {
  const h = harness();
  await h.start(native("running"));
  h.failWatch(new Error("Connection lost"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.run.getSnapshot().connection, "disconnected");
  assert.match(
    codingRunLabel(h.run.getSnapshot()),
    /work may still be running/,
  );
  await h.run.stop();
  assert.deepEqual(h.cancellations, []);
  h.run.detach();
  assert.equal(h.signal()?.aborted, true);
  assert.deepEqual(h.cancellations, []);
});

test("uncertain prompt retry reuses original submission identity and is reconciled by native request state", async () => {
  const h = harness();
  await h.start();
  h.setSubmitError(new Error("Lost acceptance"));
  await h.run.send("Only once");
  assert.equal(h.run.getSnapshot().uncertainSubmission?.key, "key");
  await assert.rejects(h.run.send("Duplicate"), /Reconcile/);
  h.setSubmitError(null);
  await h.run.retrySubmission();
  assert.deepEqual(h.submissions, [
    { id: "conversation", key: "key", text: "Only once" },
    { id: "conversation", key: "key", text: "Only once" },
  ]);
  h.setSubmitError(new Error("Lost acceptance"));
  await h.run.send("Next");
  await h.event({ type: "state", state: native("request") });
  assert.equal(h.run.getSnapshot().uncertainSubmission, null);
  h.run.detach();
});

test("out-of-order or wrong-conversation native evidence is rejected", async () => {
  const h = harness();
  await h.start();
  await assert.rejects(
    h.event({
      type: "state",
      state: { ...native(), info: { id: "other", cwd: "/other" } },
    }),
    /another conversation/,
  );
  const bad: RunApi = {
    ...h.api,
    readEntries: async () =>
      ({
        cut: { journal: "root", leaf: "not-captured" },
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
      }) as EntryPage,
  };
  const run = createCodingRun("conversation", bad);
  run.connect();
  await assert.rejects(h.start(), /captured view cut/);
  run.detach();
  h.run.detach();
});

test("definite pre-admission rejection permits corrected input instead of locking the conversation", async () => {
  const h = harness();
  await h.start();
  h.setSubmitError(
    Object.assign(new Error("Prompt rejected (422)"), {
      admissionRejected: true,
    }),
  );
  await h.run.send("x".repeat(70000));
  assert.equal(h.run.getSnapshot().uncertainSubmission, null);
  assert.match(h.run.getSnapshot().error ?? "", /rejected/);
  h.setSubmitError(null);
  await h.run.send("Corrected input");
  assert.equal(h.submissions.length, 2);
  h.run.detach();
});

test("late cancellation refusal or failure cannot overwrite matching terminal cleanup", async () => {
  for (const reject of [false, true]) {
    const h = harness();
    await h.start(native("exact-request"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.api.cancel = async (conversationId, requestId) => {
      await gate;
      if (reject) throw new Error("Lost cancel reply");
      return {
        conversation_id: conversationId,
        request_id: requestId,
        cancel_requested: false,
      };
    };
    const stop = h.run.stop();
    await h.event({
      type: "completed",
      request_id: "exact-request",
      stop_reason: "cancelled",
      error: null,
    });
    release();
    await stop;
    assert.equal(h.run.getSnapshot().stopping, null);
    assert.equal(h.run.getSnapshot().error, null);
    h.run.detach();
  }
});

test("reconnect releases an earlier-history loading flag from the old view incarnation", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.api.readEntries = async (_id, cut, anchor) => {
    if (typeof anchor === "object" && "before" in anchor) await gate;
    return {
      cut,
      rows: [{ id: "first", entry_id: "first", kind: "user", text: "Saved" }],
      older: true,
      newer: false,
      first_id: "first",
      last_id: "first",
    };
  };
  await h.start();
  const earlier = h.run.loadEarlier();
  assert.equal(h.run.getSnapshot().loadingEarlier, true);
  h.run.connect();
  await h.start();
  assert.equal(h.run.getSnapshot().loadingEarlier, false);
  release();
  await earlier;
  h.run.detach();
});

test("bounded history navigation anchors the retained entry and shows an earlier window without hiding omission", async () => {
  const h = harness();
  await h.start();
  for (let batch = 0; batch < 11; batch++) {
    h.setRows(
      Array.from(
        { length: 100 },
        (_, n): CodingRow => ({
          id: `entry-${batch * 100 + n}`,
          entry_id: `entry-${batch * 100 + n}`,
          kind: "assistant",
          text: `Row ${batch * 100 + n}`,
        }),
      ),
    );
    await h.event({
      type: "checkpoint",
      cut: { journal: "root", leaf: `cut-${batch}` },
      live_invocations: [],
    });
  }
  const oldest = h.run.getSnapshot().rows[0].entry_id;
  assert.equal(h.run.getSnapshot().rows.length, 1000);
  assert.equal(h.run.getSnapshot().older, true);
  let anchorSeen: unknown;
  h.api.readEntries = async (_id, cut, anchor) => {
    anchorSeen = anchor;
    return {
      cut,
      rows: [
        {
          id: "entry-99",
          entry_id: "entry-99",
          kind: "assistant",
          text: "Previously evicted",
        },
      ],
      older: true,
      newer: true,
      first_id: "entry-99",
      last_id: "entry-99",
    };
  };
  await h.run.loadEarlier();
  assert.deepEqual(anchorSeen, { before: oldest });
  assert.equal(h.run.getSnapshot().rows[0].text, "Previously evicted");
  assert.equal(h.run.getSnapshot().older, true);
  h.run.detach();
});
