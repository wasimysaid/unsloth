// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { goalActionDisabledReason } from "../src/features/coding/goal.ts";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import type {
  NativePlan,
  PlanDecision,
} from "../src/features/coding/plan-types.ts";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import {
  codingCanEdit,
  codingPlanControlReason,
  codingSendBlockedReason,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type { NativeState, RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

const plan: NativePlan = {
  id: "plan-exact",
  revision: "revision-exact",
  name: "Native proposal",
  path: "/project/plan.md",
  markdown: "# Native proposal\n\nPreserve this text.\n",
  status: "review_pending",
};
const native = (): NativeState => ({
  info: { id: "conversation", cwd: "/project" },
  configuration: {
    provider: "fixture",
    model: "fixture",
    reasoning: null,
    mode: "plan",
  },
  running_configuration: null,
  active_request: null,
  requests: [],
  pending_user_request: false,
  user_request: null,
  plan,
  action_disabled_reason: null,
});
function harness(modeSettleDelay = 5000) {
  let deliver!: (value: unknown) => Promise<void>;
  let position = 0;
  let watches = 0;
  const calls: unknown[] = [];
  const api: RunApi = {
    async answer() {
      throw new Error("Plan actions must never answer a native question.");
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
    async setMode(id, mode) {
      calls.push({ id, mode });
      return { conversation_id: id, mode };
    },
    async decidePlan(id, selected, decision) {
      calls.push({
        id,
        plan_id: selected.id,
        revision: selected.revision,
        decision,
      });
      return {
        conversation_id: id,
        plan_id: selected.id,
        decision,
        request_id:
          decision === "save_and_stop" ? null : "native-implementation",
      };
    },
    async submit() {
      throw new Error("Plan actions must never submit a Studio prompt.");
    },
    async cancel() {
      throw new Error("Plan actions must never simulate Stop.");
    },
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
    },
    async readEntries(_id, cut) {
      return {
        cut,
        rows: [{ id: "saved-plan", kind: "notice", plan }],
        older: false,
        newer: false,
        first_id: "saved-plan",
        last_id: "saved-plan",
      };
    },
    async watch(_id, _signal, _connected, onView) {
      watches++;
      deliver = onView;
      await new Promise(() => {});
    },
  };
  const run = createCodingRun("conversation", api, () => "unused", {
    storage: () => memorySubmissionStorage(),
    modeSettleDelay,
  });
  run.connect();
  // An ordered whole-state item on the already-open view.
  const state = (value: NativeState) =>
    deliver({
      subscription: "view",
      position: ++position,
      event: { type: "state", state: value },
    });
  const start = (state = native()) =>
    deliver({
      subscription: "view",
      position: ++position,
      event: {
        type: "start",
        state,
        root: { cut: { journal: "root", leaf: "cut" }, live_invocations: [] },
      },
    });
  return {
    run,
    api,
    calls,
    start,
    state,
    get watches() {
      return watches;
    },
  };
}

for (const operation of ["mode", "plan"] as const) {
  for (const status of [409, 503]) {
    test(`${operation} owner-loss evidence ${status} requires deliberate reopen without replay`, async () => {
      const h = harness();
      await h.start();
      const reject = async () => {
        h.calls.push(operation);
        throw new CodingHttpError(status, "Runtime changed; deliberately reopen", true);
      };
      h.api.setMode = reject;
      h.api.decidePlan = reject;
      const change = () => operation === "mode" ? h.run.setMode("build") : h.run.decidePlan(plan, "implement");
      try {
        await change();
        assert.equal(h.run.getSnapshot().reopenRequired, true);
        assert.equal(h.run.getSnapshot().connection, "disconnected");
        assert.ok(h.run.getSnapshot().planControl);
        assert.equal(h.run.getSnapshot().native?.plan?.status, "review_pending");
        assert.equal(h.run.getSnapshot().native?.configuration.mode, "plan");
        assert.match(h.run.getSnapshot().planControlError!, /reopen/i);
        h.run.connect();
        await change();
        assert.deepEqual(h.calls, [operation]);
        assert.equal(h.run.getSnapshot().connection, "disconnected");
      } finally {
        h.run.detach();
      }
    });
  }
}

const built = () => {
  const value = native();
  value.configuration.mode = "build";
  return value;
};

test("mode selection is configuration, not plan acceptance; ordered native state settles it without reconnecting", async () => {
  const h = harness();
  await h.start();
  const rows = h.run.getSnapshot().rows;
  await h.run.setMode("build");
  assert.deepEqual(h.calls, [{ id: "conversation", mode: "build" }]);
  assert.equal(
    h.run.getSnapshot().native?.configuration.mode,
    "plan",
    "no optimistic mode change",
  );
  assert.equal(h.run.getSnapshot().native?.plan?.status, "review_pending");
  assert.equal(h.run.getSnapshot().planControl?.kind, "mode");
  assert.equal(h.run.getSnapshot().planControlReconciling, false);
  assert.equal(h.watches, 1, "a definite acknowledgment never reconnects");
  assert.equal(h.run.getSnapshot().connection, "connected");
  await h.state(built());
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.equal(h.run.getSnapshot().native?.configuration.mode, "build");
  assert.equal(h.run.getSnapshot().planControlNotice, null);
  assert.equal(h.watches, 1);
  assert.equal(h.run.getSnapshot().rows, rows, "history is not re-read");
  assert.deepEqual(h.run.getSnapshot().rows[0].plan, plan);
  h.run.detach();
});

test("ordered native state that arrives before the acknowledgment settles the mode at ack", async () => {
  const h = harness();
  await h.start();
  let finish!: () => void;
  h.api.setMode = async (id, mode) => {
    h.calls.push({ id, mode });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { conversation_id: id, mode };
  };
  const changing = h.run.setMode("build");
  await h.state(built());
  assert.equal(
    h.run.getSnapshot().planControl?.kind,
    "mode",
    "state alone does not settle a command still awaiting admission",
  );
  finish();
  await changing;
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.equal(h.watches, 1);
  h.run.detach();
});

test("a delayed or missing native confirmation is reconciled by one bounded fresh capture", async () => {
  const h = harness(5);
  await h.start();
  await h.run.setMode("build");
  assert.equal(h.watches, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.watches, 2, "one fresh capture after the bound, never a replay");
  assert.equal(h.run.getSnapshot().planControlReconciling, true);
  await h.start(); // Authoritative capture still reports Plan.
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.match(
    h.run.getSnapshot().planControlNotice ?? "",
    /Authoritative mode: plan.*No command was replayed/,
  );
  assert.deepEqual(h.calls, [{ id: "conversation", mode: "build" }]);
  h.run.detach();
});

test("a definite mode refusal keeps the authoritative view and needs no reconstruction", async () => {
  const h = harness();
  await h.start();
  h.api.setMode = async (id, mode) => {
    h.calls.push({ id, mode });
    throw new CodingHttpError(409, "Native mode change refused while busy");
  };
  await h.run.setMode("build");
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.match(h.run.getSnapshot().planControlError ?? "", /refused/);
  assert.equal(h.run.getSnapshot().native?.configuration.mode, "plan");
  assert.equal(h.watches, 1);
  h.run.detach();
});

test("uncertain mode delivery waits for ordered evidence and never replays", async () => {
  const h = harness();
  await h.start();
  h.api.setMode = async (id, mode) => {
    h.calls.push({ id, mode });
    throw new Error("Coding response unconfirmed");
  };
  await h.run.setMode("build");
  assert.equal(h.run.getSnapshot().planControlUncertain, true);
  assert.match(h.run.getSnapshot().planControlError ?? "", /unconfirmed/);
  assert.equal(h.run.getSnapshot().planControl?.kind, "mode");
  await h.state(built());
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.equal(h.run.getSnapshot().planControlError, null);
  assert.match(
    h.run.getSnapshot().planControlNotice ?? "",
    /Delivery was unconfirmed.*build mode.*No command was replayed/,
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.watches, 1);
  h.run.detach();
});

test("while a mode change settles, the draft stays editable, Send is gated and Stop stays available", async () => {
  const h = harness();
  const running = native();
  running.active_request = "exact-request";
  running.requests = [
    { id: "exact-request", status: "running", submission_key: "key" },
  ];
  await h.start(running);
  const cancelled: string[] = [];
  h.api.cancel = async (id, request) => {
    cancelled.push(request);
    return { conversation_id: id, request_id: request, cancel_requested: true };
  };
  await h.run.setMode("build");
  const pending = h.run.getSnapshot();
  assert.equal(codingCanEdit(pending, h.run), true, "typing is never blocked");
  assert.equal(codingRunAdapter(pending, h.run).isDisabled, false);
  assert.match(codingSendBlockedReason(pending) ?? "", /mode confirmation/);
  await h.run.stop();
  assert.deepEqual(cancelled, ["exact-request"]);
  assert.equal(h.run.getSnapshot().connection, "connected");
  h.run.detach();
});

for (const decision of [
  "implement",
  "implement_fresh",
  "save_and_stop",
] as PlanDecision[]) {
  test(`${decision} addresses native plan revision without changing mode or inventing implementation`, async () => {
    const h = harness();
    await h.start();
    await h.run.decidePlan(plan, decision);
    assert.deepEqual(h.calls, [
      {
        id: "conversation",
        plan_id: plan.id,
        revision: plan.revision,
        decision,
      },
    ]);
    assert.equal(h.run.getSnapshot().native?.configuration.mode, "plan");
    await h.run.decidePlan(plan, decision);
    assert.equal(
      h.calls.length,
      1,
      "another choice blocked until fresh reconstruction",
    );
    const settled = native();
    settled.configuration.mode = "build";
    settled.plan = {
      ...plan,
      status: decision === "save_and_stop" ? "saved_stopped" : "accepted",
      revision: "new-revision",
    };
    await h.start(settled);
    assert.equal(h.run.getSnapshot().planControl, null);
    assert.equal(h.calls.length, 1);
    h.run.detach();
  });
}

test("uncertain plan acceptance reconnects but never retries; pending capture does not unlock actions", async () => {
  const h = harness();
  await h.start();
  h.api.decidePlan = async () => {
    h.calls.push("lost-plan-ack");
    throw new Error("Lost acknowledgment");
  };
  await h.run.decidePlan(plan, "implement");
  assert.equal(h.run.getSnapshot().planControlUncertain, true);
  const changed = native();
  changed.plan = {
    ...plan,
    status: "implementing",
    revision: "accepted-revision",
  };
  let release!: () => void;
  const history = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = h.api.readEntries;
  h.api.readEntries = async (...args) => {
    await history;
    return read(...args);
  };
  const capture = h.start(changed);
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.ok(h.run.getSnapshot().planControl, "pending history still blocks actions");
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(h.calls, ["lost-plan-ack"]);
  release();
  await capture;
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.match(
    h.run.getSnapshot().planControlNotice ?? "",
    /Delivery remains unconfirmed.*implementing.*No command was replayed/,
  );
  assert.deepEqual(h.calls, ["lost-plan-ack"]);
  h.run.detach();
});

test("stale identities/revisions and native busy reasons cannot dispatch a different plan", async () => {
  const h = harness();
  await h.start();
  await h.run.decidePlan({ ...plan, id: "old-plan" }, "implement");
  await h.run.decidePlan(
    { ...plan, revision: "old-revision" },
    "save_and_stop",
  );
  assert.equal(h.calls.length, 0);
  assert.match(h.run.getSnapshot().planControlError ?? "", /stale/);
  const busy = native();
  busy.action_disabled_reason = "Native child and tool work must settle first.";
  await h.start(busy);
  assert.match(
    codingPlanControlReason(h.run.getSnapshot()) ?? "",
    /child and tool/,
  );
  await h.run.decidePlan(plan, "implement_fresh");
  assert.equal(h.calls.length, 0);
  await h.run.setMode("build");
  assert.deepEqual(
    h.calls,
    [{ id: "conversation", mode: "build" }],
    "mode selection applies to future work; native plan busy admission is separate",
  );
  h.run.detach();
});

test("mode reconstruction cannot swallow a concurrent Stop failure or strand stopping", async () => {
  const h = harness();
  const running = native();
  running.active_request = "exact-running";
  running.requests = [
    { id: "exact-running", status: "running", submission_key: null },
  ];
  running.action_disabled_reason = "busy";
  await h.start(running);
  let resolveMode!: (value: Awaited<ReturnType<RunApi["setMode"]>>) => void;
  let rejectStop!: (reason: Error) => void;
  h.api.setMode = async () =>
    new Promise((resolve) => {
      resolveMode = resolve;
    });
  h.api.cancel = async () =>
    new Promise((_resolve, reject) => {
      rejectStop = reject;
    });
  const selecting = h.run.setMode("build");
  const stopping = h.run.stop();
  resolveMode({ conversation_id: "conversation", mode: "build" });
  await selecting;
  await h.start(running);
  rejectStop(new Error("Cancellation response lost"));
  await stopping;
  assert.equal(h.run.getSnapshot().reconcilingAction, "exact-running");
  await h.start(running);
  assert.equal(h.run.getSnapshot().stopping, null);
  assert.equal(h.run.getSnapshot().retryStop, "exact-running");
  assert.match(h.run.getSnapshot().error ?? "", /explicitly retry Stop/);
  h.run.detach();
});

test("completed plan blocks replay but not mode selection; saved-stopped can be explicitly implemented", async () => {
  const h = harness();
  const completed = native();
  completed.plan = {
    ...plan,
    status: "completed",
    revision: "completed-revision",
    action_disabled_reason: "plan_finished",
  };
  await h.start(completed);
  assert.equal(codingPlanControlReason(h.run.getSnapshot()), null);
  await h.run.decidePlan(completed.plan, "implement");
  assert.equal(h.calls.length, 0);
  assert.match(h.run.getSnapshot().planControlError ?? "", /finished/);
  await h.run.setMode("plan");
  assert.deepEqual(h.calls, [{ id: "conversation", mode: "plan" }]);
  const saved = native();
  saved.plan = { ...plan, status: "saved_stopped", revision: "saved-revision" };
  await h.start(saved);
  await h.run.decidePlan(saved.plan, "implement");
  assert.equal(h.calls.length, 2);
  h.run.detach();
});

test("late mode or plan replies cannot reconnect a detached surface", async () => {
  const h = harness();
  await h.start();
  let resolve!: (value: Awaited<ReturnType<RunApi["decidePlan"]>>) => void;
  h.api.decidePlan = async () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.run.decidePlan(plan, "implement");
  h.run.detach();
  resolve({
    conversation_id: "conversation",
    plan_id: plan.id,
    decision: "implement",
    request_id: "native-request",
  });
  await pending;
  assert.equal(h.run.getSnapshot().planControlReconciling, false);
  assert.equal(h.run.getSnapshot().native?.configuration.mode, "plan");
});

test("definite native rejection is displayed and reconciled without retry or content loss", async () => {
  const h = harness();
  await h.start();
  h.api.decidePlan = async () => {
    throw Object.assign(new Error("Native plan revision changed"), {
      admissionRejected: true,
    });
  };
  await h.run.decidePlan(plan, "implement");
  assert.equal(h.run.getSnapshot().planControlUncertain, false);
  assert.match(h.run.getSnapshot().planControlError ?? "", /revision changed/);
  await h.start();
  assert.equal(h.run.getSnapshot().planControl, null);
  assert.equal(h.run.getSnapshot().native?.plan?.markdown, plan.markdown);
  h.run.detach();
});

test("configuration and command uncertainty guard plan and mode admission", async () => {
  const h = harness();
  await h.start();
  let finish!: () => void;
  h.api.configure = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return native().configuration;
  };
  const changing = h.run.configure({ model: "other" });
  await h.run.setMode("build");
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(
    h.calls,
    [],
    "no plan/mode action during configuration delivery",
  );
  finish();
  await changing;
  h.api.command = async () => {
    throw new Error("Lost command acknowledgment");
  };
  await h.run.executeCommand("native-command");
  await h.start();
  assert.ok(h.run.getSnapshot().uncertainCommand);
  await h.run.setMode("build");
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(
    h.calls,
    [],
    "fresh capture does not settle an unknown command receipt",
  );
  h.run.detach();
});

test("plan reconstruction guards model selection and slash dispatch", async () => {
  const h = harness();
  await h.start();
  let finish!: () => void;
  h.api.setMode = async (id, mode) => {
    h.calls.push({ id, mode });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { conversation_id: id, mode };
  };
  const changing = h.run.setMode("build");
  await h.start(); // A fresh view cannot supersede an operation still awaiting acknowledgment.
  await assert.rejects(h.run.configure({ model: "other" }), /reconstructed/);
  await assert.rejects(h.run.send("/native-command"), /reconstructed/);
  assert.deepEqual(h.calls, [{ id: "conversation", mode: "build" }]);
  finish();
  await changing;
  // Still a conflicting action until native state confirms the mode.
  await assert.rejects(h.run.configure({ model: "other" }), /reconstructed/);
  await h.start(built());
  await h.run.configure({ model: "other" });
  h.run.detach();
});

test("plan admission and reconstruction block goal actions without replay", async () => {
  const h = harness();
  const current = native();
  current.goal_controls = {
    revision: "goal-revision",
    actions: [{ action: "pause", admitted: true, reason: null }],
  };
  await h.start(current);
  let finish!: () => void;
  h.api.setMode = async (id, mode) => {
    h.calls.push({ id, mode });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { conversation_id: id, mode };
  };
  h.api.changeGoal = async (id, change) => {
    h.calls.push(change);
    return { conversation_id: id, request_id: null };
  };
  const changing = h.run.setMode("build");
  const goalChange = { revision: "goal-revision", action: "pause" as const };
  assert.ok(goalActionDisabledReason(h.run.getSnapshot(), "pause"));
  let preflightCalls = 0;
  h.api.checkOverlap = async () => {
    ++preflightCalls;
    return { cwd: "/project", conversations: [{ id: "other-owner" }] };
  };
  await assert.rejects(
    h.run.send("No new draft during mode admission"),
    /reconstructed/,
  );
  assert.equal(
    preflightCalls,
    0,
    "pending plan/mode admission must block preflight",
  );
  assert.equal(await h.run.changeGoal(goalChange), false);
  finish();
  await changing;
  assert.equal(h.run.getSnapshot().planControl?.kind, "mode");
  assert.equal(await h.run.changeGoal(goalChange), false);
  assert.deepEqual(h.calls, [{ id: "conversation", mode: "build" }]);
  current.configuration.mode = "build";
  await h.start(current);
  assert.equal(await h.run.changeGoal(goalChange), true);
  assert.deepEqual(h.calls, [
    { id: "conversation", mode: "build" },
    goalChange,
  ]);
  h.run.detach();
});

test("goal admission blocks mode and plan decisions until native reconstruction", async () => {
  const h = harness();
  const current = native();
  current.goal_controls = {
    revision: "goal-revision",
    actions: [{ action: "pause", admitted: true, reason: null }],
  };
  await h.start(current);
  let finish!: () => void;
  h.api.changeGoal = async (id, change) => {
    h.calls.push(change);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { conversation_id: id, request_id: null };
  };
  const goalChange = { revision: "goal-revision", action: "pause" as const };
  const changing = h.run.changeGoal(goalChange);
  assert.ok(codingPlanControlReason(h.run.getSnapshot()));
  await h.run.setMode("build");
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(h.calls, [goalChange]);
  finish();
  await changing;
  await h.run.setMode("build");
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(h.calls, [goalChange]);
  await h.start(current);
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(h.calls, [
    goalChange,
    {
      id: "conversation",
      plan_id: plan.id,
      revision: plan.revision,
      decision: "implement",
    },
  ]);
  h.run.detach();
});

test("pending questions and overlap drafts cannot be bypassed by plan decisions", async () => {
  const h = harness();
  const waiting = native();
  waiting.pending_user_request = true;
  await h.start(waiting);
  await h.run.decidePlan(plan, "implement");
  assert.deepEqual(h.calls, []);
  await h.start();
  h.api.checkOverlap = async () => ({
    cwd: "/project",
    conversations: [{ id: "other-owner" }],
  });
  await h.run.send("Retain the warned draft");
  const warning = h.run.getSnapshot().overlapWarning;
  await h.run.decidePlan(plan, "implement");
  await h.run.setMode("build");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.run.getSnapshot().overlapWarning, warning);
  h.run.detach();
});

test("/build leaves plan mode through the native mode API when the registry has no build command", async () => {
  const h = harness();
  await h.start();
  const adapter = codingRunAdapter(h.run.getSnapshot(), h.run);
  await adapter.onNew?.({
    role: "user",
    content: [{ type: "text", text: "/build" }],
  } as never);
  assert.deepEqual(h.calls, [{ id: "conversation", mode: "build" }]);
  await h.state(built());
  assert.equal(h.run.getSnapshot().native?.configuration.mode, "build");
  h.run.detach();
});
