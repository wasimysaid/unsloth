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

import {
  type SubmissionStorage,
  pendingSubmissionStorageKey,
} from "../src/features/coding/pending-submission.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

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
function harness(
  storage: SubmissionStorage = memorySubmissionStorage(),
  reconnectDelay?: (attempt: number) => number,
) {
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
    async readChild() {
      return { child: null, outcome: null };
    },
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
  const run = createCodingRun("conversation", api, () => "key", {
    storage: () => storage,
    reconnectDelay,
  });
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
    storage,
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const storageName = pendingSubmissionStorageKey("conversation");

test("delivery identity is durable before HTTP and survives reload without automatic replay", async () => {
  const h = harness();
  await h.start();
  h.api.submit = async (_id, key, text) => {
    const record = h.storage.getItem(storageName);
    assert.ok(record);
    assert.deepEqual(JSON.parse(record), {
      version: 1,
      conversation_id: "conversation",
      key,
      text,
    });
    h.submissions.push({ key, text });
    throw new Error("Lost delivery");
  };
  await h.run.send("Run only once");
  h.run.detach();
  const reopened = createCodingRun("conversation", h.api, () => "NEW-KEY", {
    storage: () => h.storage,
  });
  assert.deepEqual(reopened.getSnapshot().uncertainSubmission, {
    key: "key",
    text: "Run only once",
  });
  reopened.connect();
  await assert.rejects(reopened.retrySubmission(), /reconstructed/);
  await h.start();
  assert.equal(
    h.submissions.length,
    1,
    "capture must not automatically replay input",
  );
  await reopened.retrySubmission();
  assert.deepEqual(h.submissions, [
    { key: "key", text: "Run only once" },
    { key: "key", text: "Run only once" },
  ]);
  const interrupted = native();
  interrupted.requests = [
    { id: "original", status: "interrupted", submission_key: "key" },
  ];
  await h.event({ type: "state", state: interrupted });
  assert.equal(reopened.getSnapshot().uncertainSubmission, null);
  assert.equal(h.storage.getItem(storageName), null);
  assert.equal(reopened.getSnapshot().deliveryRecovered, true);
  assert.match(
    codingRunLabel(reopened.getSnapshot()),
    /explicit continuation required/,
  );
  assert.equal(
    h.submissions.length,
    2,
    "delivery recovery is not process continuation",
  );
  reopened.detach();
});

test("accepted lost ACK is reconciled by fresh captured native history after restart", async () => {
  const h = harness();
  await h.start();
  h.setSubmitError(new Error("ACK lost"));
  await h.run.send("Accepted");
  h.run.detach();
  const reopened = createCodingRun("conversation", h.api, () => "different", {
    storage: () => h.storage,
  });
  reopened.connect();
  await h.start(native("original-request"));
  assert.equal(reopened.getSnapshot().uncertainSubmission, null);
  assert.equal(h.storage.getItem(storageName), null);
  assert.equal(h.submissions.length, 1);
  assert.equal(reopened.getSnapshot().deliveryRecovered, true);
  reopened.detach();
});

test("storage load/write/readback/corruption failures fail closed before prompt delivery", async () => {
  for (const failure of ["load", "write", "readback", "corrupt"]) {
    const storage = memorySubmissionStorage();
    if (failure === "load")
      storage.getItem = () => {
        throw new Error("Disabled");
      };
    if (failure === "write")
      storage.setItem = () => {
        throw new Error("Quota");
      };
    if (failure === "readback") storage.setItem = () => {};
    if (failure === "corrupt") storage.setItem(storageName, "{broken");
    const h = harness(storage);
    await h.start();
    if (h.run.getSnapshot().storageError)
      await assert.rejects(h.run.send("Must not run"));
    else await h.run.send("Must not run");
    assert.equal(h.submissions.length, 0, failure);
    assert.match(h.run.getSnapshot().storageError ?? "", /storage unavailable/);
    h.run.detach();
  }
});

test("failed pending cleanup prevents new input even after accepted delivery", async () => {
  const storage = memorySubmissionStorage();
  storage.removeItem = () => {
    throw new Error("Storage locked");
  };
  const h = harness(storage);
  await h.start();
  await h.run.send("Accepted");
  assert.equal(h.run.getSnapshot().uncertainSubmission?.key, "key");
  assert.match(h.run.getSnapshot().storageError ?? "", /Sending is disabled/);
  await assert.rejects(h.run.send("New copy"), /Reconcile/);
  assert.equal(h.submissions.length, 1);
  h.run.detach();
});

test("automatic reconnect keeps disconnect banner through history capture and recovering checkpoint", async () => {
  const attempts: number[] = [];
  const h = harness(memorySubmissionStorage(), (attempt) => {
    attempts.push(attempt);
    return 0;
  });
  await h.start(native("running"));
  const firstSignal = h.signal();
  h.failWatch(new Error("Lost stream"));
  await tick();
  assert.equal(h.run.getSnapshot().disconnected, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(firstSignal?.aborted, true);
  assert.notEqual(h.signal(), firstSignal);
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.equal(h.run.getSnapshot().disconnected, true);
  await h.start(native("running"), true);
  assert.equal(h.run.getSnapshot().disconnected, true);
  assert.equal(h.run.getSnapshot().recovering, true);
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "cut1" },
    live_invocations: [],
  });
  assert.equal(h.run.getSnapshot().disconnected, false);
  assert.equal(h.run.getSnapshot().recovering, false);
  assert.deepEqual(attempts, [0]);
  assert.equal(h.submissions.length, 0);
  assert.equal(h.cancellations.length, 0);
  h.run.detach();
});

test("repeated reconnect failures back off until capture and detach cancels scheduled attempts", async () => {
  const attempts: number[] = [];
  const h = harness(memorySubmissionStorage(), (attempt) => {
    attempts.push(attempt);
    return 5;
  });
  h.failWatch(new Error("Offline"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  h.failWatch(new Error("Still offline"));
  await tick();
  assert.deepEqual(attempts, [0, 1]);
  h.run.detach();
  const detachedSignal = h.signal();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.signal(), detachedSignal);
  assert.equal(detachedSignal?.aborted, true);
});

test("uncertain Stop must inspect fresh capture before offering explicit same-request retry", async () => {
  const h = harness();
  await h.start(native("exact"));
  h.api.cancel = async (id, request) => {
    h.cancellations.push({ id, request });
    throw new Error("Cancel ACK lost");
  };
  await h.run.stop();
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.equal(h.run.getSnapshot().reconcilingAction, "exact");
  await h.run.stop();
  assert.equal(h.cancellations.length, 1);
  await h.start(native("exact"), true);
  assert.equal(
    h.run.getSnapshot().retryStop,
    null,
    "recovering state is not a retry decision",
  );
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "cut1" },
    live_invocations: [],
  });
  assert.equal(h.run.getSnapshot().retryStop, "exact");
  assert.equal(h.run.getSnapshot().stopping, null);
  assert.match(h.run.getSnapshot().error ?? "", /Fresh native view/);
  assert.equal(h.cancellations.length, 1, "never automatically replay Stop");
  await h.run.stop();
  assert.deepEqual(h.cancellations, [
    { id: "conversation", request: "exact" },
    { id: "conversation", request: "exact" },
  ]);
  const settled = native("other");
  settled.requests.push({
    id: "exact",
    status: "cancelled",
    submission_key: null,
  });
  await h.start(settled);
  assert.equal(h.run.getSnapshot().retryStop, null);
  assert.equal(h.run.getSnapshot().stopping, null);
  assert.equal(h.run.getSnapshot().reconcilingAction, null);
  assert.equal(
    h.cancellations.length,
    2,
    "fresh view cannot substitute another cancellation target",
  );
  h.run.detach();
});

test("reset hides old provisional rows while capture is unfinished, and reopened tools are historical", async () => {
  const h = harness();
  await h.start();
  await h.event({
    type: "activity",
    rows: [{ id: "partial", kind: "assistant", text: "Old" }],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.api.readEntries = async (_id, cut) => {
    await gate;
    return {
      cut,
      rows: [{ id: "saved-tool", kind: "tool" }],
      older: false,
      newer: false,
      first_id: "saved-tool",
      last_id: "saved-tool",
    };
  };
  const reset = h.event({
    type: "reset",
    state: native(),
    recovering: true,
    root: { cut: { journal: "root", leaf: "new" }, live_invocations: [] },
  });
  assert.deepEqual(h.run.getSnapshot().rows, []);
  assert.equal(h.run.getSnapshot().connection, "loading");
  release();
  await reset;
  assert.equal(h.run.getSnapshot().rows[0].historical, true);
  assert.equal(h.run.getSnapshot().recovering, true);
  h.run.detach();
});

test("nonprogressing older history keeps omission actionable instead of presenting completion", async () => {
  const h = harness();
  h.api.readEntries = async (_id, cut, anchor) => ({
    cut,
    rows:
      anchor === "latest"
        ? [{ id: "first", entry_id: "first", kind: "user" }]
        : [],
    older: true,
    newer: anchor !== "latest",
    first_id: "first",
    last_id: "first",
  });
  await h.start();
  await h.run.loadEarlier();
  assert.equal(h.run.getSnapshot().older, true);
  assert.equal(h.run.getSnapshot().viewingEarlier, false);
  assert.match(
    h.run.getSnapshot().error ?? "",
    /Earlier history is incomplete.*Retry/,
  );
  h.run.detach();
});

test("persisted pending identities are conversation-scoped and recovering reset never replays them", async () => {
  const h = harness();
  h.storage.setItem(
    pendingSubmissionStorageKey("other"),
    JSON.stringify({
      version: 1,
      conversation_id: "other",
      key: "other-key",
      text: "Other prompt",
    }),
  );
  await h.start();
  assert.equal(h.run.getSnapshot().uncertainSubmission, null);
  h.setSubmitError(new Error("Lost response"));
  await h.run.send("Pending here");
  await h.event({
    type: "reset",
    state: native("accepted"),
    recovering: true,
    root: { cut: { journal: "root", leaf: "recovery" }, live_invocations: [] },
  });
  assert.equal(h.run.getSnapshot().uncertainSubmission?.key, "key");
  assert.notEqual(h.storage.getItem(storageName), null);
  await assert.rejects(h.run.retrySubmission(), /reconstructed/);
  assert.equal(h.submissions.length, 1);
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "recovery" },
    live_invocations: [],
  });
  assert.equal(h.run.getSnapshot().uncertainSubmission, null);
  assert.equal(h.storage.getItem(storageName), null);
  assert.notEqual(
    h.storage.getItem(pendingSubmissionStorageKey("other")),
    null,
  );
  assert.equal(h.submissions.length, 1);
  h.run.detach();
});

test("disconnect banner is retained while reconnect captured history reads are outstanding", async () => {
  const h = harness();
  await h.start();
  h.failWatch(new Error("Stream lost"));
  await tick();
  h.run.connect();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalRead = h.api.readEntries;
  h.api.readEntries = async (...args) => {
    await gate;
    return originalRead(...args);
  };
  const capture = h.start();
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.equal(h.run.getSnapshot().disconnected, true);
  release();
  await capture;
  assert.equal(h.run.getSnapshot().disconnected, false);
  h.run.detach();
});

test("a closed native view requires deliberate reopen instead of automatic owner restart", async () => {
  const attempts: number[] = [];
  const h = harness(memorySubmissionStorage(), (attempt) => {
    attempts.push(attempt);
    return 0;
  });
  await h.start();
  h.failWatch(
    Object.assign(new Error("Native view closed. Reopen."), {
      requiresReopen: true,
    }),
  );
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.run.getSnapshot().reopenRequired, true);
  assert.equal(h.run.getSnapshot().disconnected, true);
  assert.deepEqual(attempts, []);
  h.run.detach();
});

test("saved tool result replaces a provisional invocation without duplicate or live historical rows", async () => {
  const h = harness();
  await h.start();
  const tool = {
    invocation_id: "invocation",
    call_id: "call",
    request_id: "request",
    name: "shell",
    title: "Run shell",
    status: "running",
    output: "Partial",
    clipped: false,
    quiet: false,
    row_group: null,
  };
  await h.event({
    type: "activity",
    rows: [{ id: "live-tool", kind: "tool", tool }],
  });
  h.setRows([
    {
      id: "saved-tool",
      kind: "tool",
      entry_id: "saved-tool",
      tool: { ...tool, status: "completed", output: "Saved result" },
    },
  ]);
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "cut2" },
    live_invocations: ["invocation"],
  });
  assert.equal(h.run.getSnapshot().rows.length, 1);
  assert.equal(h.run.getSnapshot().rows[0].tool?.output, "Saved result");
  assert.equal(h.run.getSnapshot().rows[0].tool?.status, "completed");
  h.run.connect();
  await h.start();
  assert.equal(h.run.getSnapshot().rows.length, 1);
  assert.equal(h.run.getSnapshot().rows[0].historical, true);
  h.run.detach();
});

test("oversized older page remains actionable incomplete history instead of exceeding memory bound", async () => {
  const h = harness();
  h.api.readEntries = async (_id, cut, anchor) => ({
    cut,
    rows: [
      {
        id: "row",
        kind: "assistant",
        text: anchor === "latest" ? "Saved" : "x".repeat(2 * 1024 * 1024 + 1),
      },
    ],
    older: true,
    newer: anchor !== "latest",
    first_id: anchor === "latest" ? "row" : "older-row",
    last_id: "row",
  });
  await h.start();
  await h.run.loadEarlier();
  assert.equal(h.run.getSnapshot().viewingEarlier, false);
  assert.equal(h.run.getSnapshot().rows[0].text, "Saved");
  assert.match(h.run.getSnapshot().error ?? "", /incomplete/);
  h.run.detach();
});

test("uncertain Stop does not offer retry while terminal request still holds cleanup admission", async () => {
  const h = harness();
  await h.start(native("exact"));
  h.api.cancel = async () => {
    throw new Error("Lost cancellation ACK");
  };
  await h.run.stop();
  const cleanup = native("exact");
  cleanup.requests[0].status = "cancelled";
  await h.start(cleanup);
  assert.equal(h.run.getSnapshot().stopping, "exact");
  assert.equal(h.run.getSnapshot().retryStop, null);
  await assert.rejects(h.run.send("Do not bypass cleanup"), /reconstructed/);
  await h.event({
    type: "completed",
    request_id: "exact",
    stop_reason: "cancelled",
    error: null,
  });
  assert.equal(h.run.getSnapshot().stopping, null);
  assert.equal(h.run.getSnapshot().error, null);
  h.run.detach();
});

for (const rejected of [false, true]) {
  test(`detached late Stop ${rejected ? "rejection" : "refusal"} cannot resurrect a native watcher`, async () => {
    const h = harness();
    await h.start(native("exact"));
    const originalWatch = h.api.watch;
    let watches = 1;
    h.api.watch = async (...args) => {
      watches++;
      return originalWatch(...args);
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.api.cancel = async (id, request) => {
      await gate;
      if (rejected) throw new Error("Late cancellation ACK lost");
      return {
        conversation_id: id,
        request_id: request,
        cancel_requested: false,
      };
    };
    const stopping = h.run.stop();
    const previousSignal = h.signal();
    h.run.detach();
    const detached = h.run.getSnapshot();
    release();
    await stopping;
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assert.equal(
        watches,
        1,
        "late replies must not reconnect an abandoned view",
      );
      assert.equal(h.signal(), previousSignal);
      assert.equal(previousSignal?.aborted, true);
      assert.equal(
        h.run.getSnapshot(),
        detached,
        "no stale post-detach reconciliation updates",
      );
    } finally {
      h.run.detach();
    }
  });
}
