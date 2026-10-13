// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type { ChildAttempt } from "../src/features/coding/child-types.ts";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import type { NativeState, RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

const native: NativeState = {
  info: { id: "parent", cwd: "/project" },
  configuration: {
    provider: null,
    model: null,
    reasoning: null,
    mode: "build",
  },
  running_configuration: null,
  active_request: "parent-request",
  requests: [
    { id: "parent-request", status: "running", submission_key: "key" },
  ],
  pending_user_request: false,
  user_request: null,
};
const child: ChildAttempt = {
  handle: "agent-native",
  attempt: 1,
  status: "running",
  completion_pending: false,
  cut: { journal: { child: "agent-native" }, leaf: "child-cut" },
  description: "Inspect native work",
};
function harness() {
  let deliver!: (value: unknown) => Promise<void>;
  let position = 0;
  const cancellations: unknown[] = [];
  const api: RunApi = {
    async answer() {
      throw new Error("Child inspection must not answer a parent question");
    },
    async configure() {
      throw new Error("Child inspection must not configure the parent");
    },
    async checkOverlap() {
      throw new Error("Child inspection must not submit work");
    },
    async readEntries(_id, cut) {
      return {
        cut,
        rows: [
          {
            id: cut.journal === "root" ? "root-text" : "child-text",
            kind: "assistant",
            text: "Saved public reply",
          },
        ],
        older: false,
        newer: false,
        first_id: "entry",
        last_id: "entry",
      };
    },
    async readChild(_id, handle, attempt) {
      return {
        child: null,
        outcome: {
          handle,
          attempt,
          status: "completed",
          result: "Exact retained result",
          error: null,
        },
      };
    },
    async watch(_id, signal, _connected, onView) {
      deliver = onView;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    async submit(id, submissionKey) {
      return {
        conversation_id: id,
        submission_key: submissionKey,
        request_id: "parent-request",
      };
    },
    async cancel(id, requestId) {
      cancellations.push({ id, request_id: requestId });
      return {
        conversation_id: id,
        request_id: requestId,
        cancel_requested: true,
      };
    },
  };
  const run = createCodingRun("parent", api, () => "key", {
    storage: () => memorySubmissionStorage(),
  });
  run.connect();
  const event = (event: unknown) =>
    deliver({ subscription: "native-view", position: ++position, event });
  return { run, event, cancellations, api };
}

test("slow optional child inspection does not delay parent recapture readiness or main Stop", async () => {
  const h = harness();
  const start = {
    type: "start",
    state: native,
    children: [child],
    recovering: false,
    root: { cut: { journal: "root", leaf: "root-cut" }, live_invocations: [] },
  };
  await h.event(start);
  await h.run.childView.open(child);
  let finish!: (detail: { child: null; outcome: null }) => void;
  h.api.readChild = async () =>
    await new Promise((resolve) => {
      finish = resolve;
    });
  const reset = h.event({ ...start, type: "reset" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(h.run.getSnapshot().connection, "connected");
    await h.run.stop();
    assert.deepEqual(h.cancellations, [
      { id: "parent", request_id: "parent-request" },
    ]);
  } finally {
    finish({ child: null, outcome: null });
    await reset;
    h.run.detach();
  }
});

test("recovering reset keeps a selected inspector usable after root checkpoint", async () => {
  const h = harness();
  const start = {
    type: "start",
    state: native,
    children: [child],
    recovering: false,
    root: { cut: { journal: "root", leaf: "root-cut" }, live_invocations: [] },
  };
  await h.event(start);
  await h.run.childView.open(child);
  await h.event({ ...start, type: "reset", recovering: true });
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "root-cut" },
    live_invocations: [],
  });
  const next = {
    journal: { child: child.handle },
    leaf: "child-after-recovery",
  };
  await h.event({
    type: "checkpoint",
    child: { handle: child.handle, attempt: 1 },
    cut: next,
    live_invocations: [],
  });
  assert.deepEqual(h.run.childView.getSnapshot().inspection?.cut, next);
  h.run.detach();
});

test("parent ordered capture routes exact child activity/checkpoints without flooding root or settling parent recovery", async () => {
  const h = harness();
  await h.event({
    type: "start",
    state: native,
    children: [child],
    recovering: true,
    root: { cut: { journal: "root", leaf: "root-cut" }, live_invocations: [] },
  });
  await h.run.childView.open(child);
  await h.event({
    type: "activity",
    child: { handle: child.handle, attempt: 1 },
    rows: [{ id: "child-live", kind: "assistant", text: "Child provisional" }],
  });
  assert.equal(
    h.run.childView
      .getSnapshot()
      .inspection?.rows.some((row) => row.id === "child-live"),
    true,
  );
  assert.equal(
    h.run.getSnapshot().rows.some((row) => row.id === "child-live"),
    false,
  );
  await h.event({
    type: "checkpoint",
    child: { handle: child.handle, attempt: 1 },
    cut: { journal: { child: child.handle }, leaf: "child-next" },
    live_invocations: [],
  });
  assert.equal(
    h.run.getSnapshot().recovering,
    true,
    "child checkpoint must not release root recovery",
  );
  assert.equal(h.run.childView.getSnapshot().connected, false);
  await h.event({
    type: "checkpoint",
    cut: { journal: "root", leaf: "root-cut" },
    live_invocations: [],
  });
  assert.equal(h.run.getSnapshot().recovering, false);
  assert.equal(h.run.childView.getSnapshot().connected, true);
  assert.equal(h.run.getSnapshot().native?.active_request, "parent-request");
  h.run.detach();
});

test("inspecting a terminal child and navigating continued attempts never consumes parent completion or settles main Stop", async () => {
  const h = harness();
  await h.event({
    type: "start",
    state: native,
    children: [child],
    recovering: false,
    root: { cut: { journal: "root", leaf: "root-cut" }, live_invocations: [] },
  });
  await h.run.childView.open(child);
  await h.run.stop();
  await h.event({
    type: "child",
    child: { ...child, status: "completed", completion_pending: true },
  });
  assert.equal(h.run.childView.getSnapshot().inspection?.outcome?.attempt, 1);
  assert.equal(
    h.run.childView.getSnapshot().attempts[0].completion_pending,
    true,
  );
  assert.equal(h.run.getSnapshot().stopping, "parent-request");
  await h.event({
    type: "child",
    child: {
      ...child,
      attempt: 2,
      status: "running",
      completion_pending: false,
    },
  });
  assert.equal(h.run.childView.getSnapshot().inspection?.attempt, 1);
  assert.equal(h.run.childView.getSnapshot().inspection?.outcome?.attempt, 1);
  assert.deepEqual(h.cancellations, [
    { id: "parent", request_id: "parent-request" },
  ]);
  await h.event({
    type: "completed",
    request_id: "parent-request",
    stop_reason: "cancelled",
    error: null,
  });
  assert.equal(h.run.getSnapshot().stopping, null);
  h.run.detach();
});
