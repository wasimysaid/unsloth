// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  codingGoalLabel,
  goalActionDisabledReason,
} from "../src/features/coding/goal.ts";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import type {
  GoalAction,
  GoalChange,
  NativeGoal,
  NativeState,
  RunApi,
} from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

const goal: NativeGoal = {
  id: "native-goal",
  objective: "Verified work",
  phase: "active",
  cause: "started",
  reason: null,
  review_gap: null,
  work_turns: 1,
  started_at: "2026-01-01",
  completion: null,
};
function native(
  revision = "owner:goal:1",
  value: NativeGoal | null = goal,
): NativeState {
  return {
    info: { id: "conversation", cwd: "/project" },
    configuration: {
      provider: "external",
      model: "fixture",
      reasoning: null,
      mode: "build",
    },
    running_configuration: null,
    active_request: "request",
    requests: [{ id: "request", status: "running", submission_key: null }],
    pending_user_request: false,
    user_request: null,
    plan: null,
    action_disabled_reason: null,
    goal: value,
    goal_controls: {
      revision,
      actions: (
        ["start", "edit", "pause", "resume", "clear"] as GoalAction[]
      ).map((action) => ({
        action,
        admitted: action === "edit" || action === "pause" || action === "clear",
        reason:
          action === "start"
            ? "Native goal already exists"
            : action === "resume"
              ? "Native goal already active"
              : null,
      })),
    },
  };
}
function harness() {
  let deliver!: (event: unknown) => Promise<void>;
  let position = 0;
  let view = 0;
  const changes: GoalChange[] = [];
  const cancellations: string[] = [];
  let fail = false;
  let hold:
    | (() => Promise<{ conversation_id: string; request_id: null }>)
    | null = null;
  const api: RunApi = {
    async setMode() {
      throw new Error("Goal tests must not change native mode");
    },
    async decidePlan() {
      throw new Error("Goal tests must not decide plans");
    },
    async answer() {
      throw new Error("Goal tests must not answer questions");
    },
    async configure() {
      return native().configuration;
    },
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      return { child: null, outcome: null };
    },
    async changeGoal(id, change) {
      changes.push(change);
      if (fail) throw new Error("Acknowledgment lost");
      if (hold) return await hold();
      return { conversation_id: id, request_id: null };
    },
    async cancel(id, request) {
      cancellations.push(request);
      return {
        conversation_id: id,
        request_id: request,
        cancel_requested: true,
      };
    },
    async submit() {
      throw new Error("Not a prompt");
    },
    async readEntries(_id, cut) {
      return {
        cut,
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
      };
    },
    async watch(_id, signal, _connected, consume) {
      position = 0;
      const subscription = `view-${++view}`;
      deliver = async (event) => {
        await consume({ subscription, position: ++position, event });
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  const run = createCodingRun("conversation", api, () => "key", {
    storage: memorySubmissionStorage,
  });
  run.connect();
  return {
    run,
    api,
    changes,
    cancellations,
    start: (state = native()) =>
      deliver({
        type: "start",
        state,
        recovering: false,
        root: { cut: { journal: "root", leaf: null }, live_invocations: [] },
      }),
    state: (state: NativeState) => deliver({ type: "state", state }),
    fail: () => {
      fail = true;
    },
    hold: (value: typeof hold) => {
      hold = value;
    },
  };
}

for (const status of [409, 503]) {
  test(`goal owner-loss evidence ${status} requires deliberate reopen and never replays the action`, async () => {
    const h = harness();
    await h.start();
    h.hold(async () => { throw new CodingHttpError(status, "Runtime changed; deliberately reopen", true); });
    try {
      assert.equal(await h.run.changeGoal({ action: "pause", revision: "owner:goal:1" }), false);
      assert.equal(h.run.getSnapshot().reopenRequired, true);
      assert.equal(h.run.getSnapshot().connection, "disconnected");
      assert.equal(h.run.getSnapshot().native?.goal?.phase, "active");
      assert.equal(h.run.getSnapshot().reconcilingGoal, "pause");
      assert.match(h.run.getSnapshot().goalNotice!, /reopen/i);
      h.run.connect();
      assert.equal(await h.run.changeGoal({ action: "pause", revision: "owner:goal:1" }), false);
      assert.equal(h.changes.length, 1);
      assert.equal(h.run.getSnapshot().connection, "disconnected");
    } finally {
      h.run.detach();
    }
  });
}

test("only native goal completion evidence is independently verified, never an ordinary turn ending", async () => {
  const h = harness();
  await h.start();
  assert.equal(codingGoalLabel(h.run.getSnapshot()), "Goal running");
  await h.state({
    ...native(),
    active_request: null,
    requests: [{ id: "request", status: "completed", submission_key: null }],
  });
  assert.equal(
    codingGoalLabel(h.run.getSnapshot()),
    "Goal active · not verified complete",
  );
  await h.state(
    native("rev2", { ...goal, phase: "complete", cause: "review-accepted" }),
  );
  assert.equal(
    codingGoalLabel(h.run.getSnapshot()),
    "Completion verification unavailable",
  );
  await h.state(
    native("rev3", {
      ...goal,
      phase: "complete",
      cause: "review-accepted",
      completion: {
        checklist: [
          { requirement: "file exists", evidence: "read_file result" },
        ],
        limitations: "fixture",
        completed_at: "2026-01-02",
      },
    }),
  );
  assert.equal(
    codingGoalLabel(h.run.getSnapshot()),
    "Independently verified completion",
  );
  h.run.detach();
});

test("paused, blocked, reopened interrupted and transport uncertainty remain distinct", async () => {
  const h = harness();
  await h.start(
    native("rev1", { ...goal, phase: "paused", cause: "user-paused" }),
  );
  assert.equal(codingGoalLabel(h.run.getSnapshot()), "Goal paused");
  await h.state(
    native("rev2", {
      ...goal,
      phase: "blocked",
      cause: "blocked",
      reason: "Missing access",
      review_gap: "Need filesystem evidence",
    }),
  );
  assert.equal(codingGoalLabel(h.run.getSnapshot()), "Goal blocked");
  assert.equal(
    h.run.getSnapshot().native?.goal?.review_gap,
    "Need filesystem evidence",
  );
  await h.state(native("rev3", { ...goal, phase: "paused", cause: "restart" }));
  assert.equal(
    codingGoalLabel(h.run.getSnapshot()),
    "Interrupted · explicit resume required",
  );
  assert.deepEqual(h.changes, [], "Reopening cannot resume a goal");
  h.run.connect();
  assert.equal(codingGoalLabel(h.run.getSnapshot()), "Goal state unconfirmed");
  assert.match(
    goalActionDisabledReason(h.run.getSnapshot(), "resume")!,
    /connected, reconstructed/,
  );
  h.run.detach();
});

test("exact native admission refuses stale and disabled controls without issuing a command", async () => {
  const h = harness();
  await h.start();
  assert.match(
    goalActionDisabledReason(h.run.getSnapshot(), "start")!,
    /already exists/,
  );
  assert.equal(
    await h.run.changeGoal({
      action: "start",
      revision: "owner:goal:1",
      objective: "different",
    }),
    false,
  );
  await h.state(native("owner:goal:2"));
  assert.equal(
    await h.run.changeGoal({ action: "pause", revision: "owner:goal:1" }),
    false,
  );
  assert.match(h.run.getSnapshot().goalNotice!, /stale/);
  assert.deepEqual(h.changes, []);
  h.run.detach();
});

test("uncertain goal delivery rebuilds fresh native state and never retries the non-idempotent action", async () => {
  const h = harness();
  await h.start();
  h.fail();
  assert.equal(
    await h.run.changeGoal({ action: "pause", revision: "owner:goal:1" }),
    false,
  );
  assert.equal(h.run.getSnapshot().reconcilingGoal, "pause");
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.equal(
    h.run.getSnapshot().native?.goal?.phase,
    "active",
    "No optimistic phase",
  );
  await h.start(
    native("owner:goal:2", { ...goal, phase: "paused", cause: "user-paused" }),
  );
  assert.equal(h.run.getSnapshot().reconcilingGoal, null);
  assert.match(h.run.getSnapshot().goalNotice!, /No goal action was replayed/);
  assert.equal(h.changes.length, 1);
  h.run.detach();
});

test("goal command acceptance is not completion; main-session Stop stays available while awaiting goal admission", async () => {
  const h = harness();
  await h.start();
  let accept!: (result: { conversation_id: string; request_id: null }) => void;
  h.hold(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const change = h.run.changeGoal({
    action: "edit",
    revision: "owner:goal:1",
    objective: "Edited objective",
  });
  assert.equal(h.run.getSnapshot().goalChanging, "edit");
  await h.run.stop();
  assert.deepEqual(h.cancellations, ["request"]);
  assert.equal(
    h.run.getSnapshot().stopping,
    "request",
    "Cancellation acceptance is not terminal cleanup",
  );
  accept({ conversation_id: "conversation", request_id: null });
  assert.equal(await change, true);
  assert.notEqual(
    codingGoalLabel(h.run.getSnapshot()),
    "Independently verified completion",
  );
  await h.start(
    native("owner:goal:2", { ...goal, objective: "Edited objective" }),
  );
  assert.equal(h.changes.length, 1);
  h.run.detach();
});

for (const failure of ["refused", "lost"] as const) {
  test(`goal-triggered reconstruction preserves pending Stop reconciliation when cancellation is ${failure}`, async () => {
    const h = harness();
    await h.start();
    let rejectGoal!: (error: Error) => void;
    h.hold(
      () =>
        new Promise((_resolve, reject) => {
          rejectGoal = reject;
        }),
    );
    let settleCancel!: () => void;
    const cancellations: string[] = [];
    h.api.cancel = async (id, request) => {
      cancellations.push(request);
      return await new Promise((resolve, reject) => {
        settleCancel = () =>
          failure === "lost"
            ? reject(new Error("Cancellation delivery lost"))
            : resolve({
                conversation_id: id,
                request_id: request,
                cancel_requested: false,
              });
      });
    };
    const changing = h.run.changeGoal({
      action: "edit",
      revision: "owner:goal:1",
      objective: "New objective",
    });
    const stopping = h.run.stop();
    rejectGoal(new Error("Goal delivery lost"));
    await changing;
    await h.start(native("owner:goal:2")); // Still running: no cancellation was delivered.
    settleCancel();
    await stopping;
    assert.equal(
      h.run.getSnapshot().reconcilingAction,
      "request",
      "Pending cancellation must remain actionable across a goal-triggered watcher replacement",
    );
    await h.start(native("owner:goal:2"));
    assert.equal(h.run.getSnapshot().stopping, null);
    assert.equal(h.run.getSnapshot().retryStop, "request");
    assert.deepEqual(
      cancellations,
      ["request"],
      "No automatic cancellation replay",
    );
    h.run.detach();
  });
}

test("reconnect supersedes late acknowledgments without reviving stale controls", async () => {
  const h = harness();
  await h.start();
  let accept!: (result: { conversation_id: string; request_id: null }) => void;
  h.hold(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const change = h.run.changeGoal({
    action: "pause",
    revision: "owner:goal:1",
  });
  h.run.connect();
  await h.start(
    native("new-owner:goal:2", { ...goal, phase: "paused", cause: "restart" }),
  );
  assert.equal(h.run.getSnapshot().goalChanging, null);
  accept({ conversation_id: "conversation", request_id: null });
  assert.equal(await change, false);
  assert.equal(h.changes.length, 1);
  assert.equal(
    h.run.getSnapshot().native?.goal_controls?.revision,
    "new-owner:goal:2",
  );
  h.run.detach();
});

for (const operation of ["configuration", "command"] as const) {
  test(`pending and uncertain ${operation} delivery guards native goal admission`, async () => {
    const h = harness();
    await h.start();
    let reject!: (reason: Error) => void;
    if (operation === "configuration")
      h.api.configure = () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        });
    else
      h.api.command = () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        });
    const pending = (
      operation === "configuration"
        ? h.run.configure({ model: "other" })
        : h.run.executeCommand("compress")
    ).catch(() => false);
    try {
      assert.ok(goalActionDisabledReason(h.run.getSnapshot(), "pause"));
      assert.equal(
        await h.run.changeGoal({ action: "pause", revision: "owner:goal:1" }),
        false,
      );
      assert.deepEqual(h.changes, []);
      reject(new Error("Delivery lost"));
      await pending;
      assert.ok(goalActionDisabledReason(h.run.getSnapshot(), "pause"));
      assert.equal(
        await h.run.changeGoal({ action: "pause", revision: "owner:goal:1" }),
        false,
      );
      assert.deepEqual(h.changes, []);
    } finally {
      reject(new Error("Delivery lost"));
      await pending;
      h.run.detach();
    }
  });
}

test("pending and reconstructed goal actions guard configuration, commands and prompt preflight", async () => {
  const h = harness();
  await h.start();
  let accept!: (result: { conversation_id: string; request_id: null }) => void;
  h.hold(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const calls: string[] = [];
  h.api.configure = async () => {
    calls.push("configure");
    return native().configuration;
  };
  h.api.command = async (_id, _name, _tail, operation) => {
    calls.push("command");
    return {
      conversation_id: "conversation",
      operation_id: operation,
      outcome: "handled",
    };
  };
  h.api.checkOverlap = async () => {
    calls.push("overlap");
    return { cwd: "/project", conversations: [] };
  };
  const changing = h.run.changeGoal({
    action: "pause",
    revision: "owner:goal:1",
  });
  try {
    for (const phase of ["pending", "reconciling"] as const) {
      await assert.rejects(
        h.run.configure({ model: "other" }),
        /reconstructed/,
      );
      await assert.rejects(h.run.executeCommand("compress"), /reconstructed/);
      await assert.rejects(h.run.send("Keep the rich draft"), /reconstructed/);
      assert.deepEqual(calls, [], phase);
      if (phase === "pending") {
        accept({ conversation_id: "conversation", request_id: null });
        assert.equal(await changing, true);
        assert.equal(h.run.getSnapshot().reconcilingGoal, "pause");
      }
    }
  } finally {
    accept({ conversation_id: "conversation", request_id: null });
    await changing;
    h.run.detach();
  }
});
