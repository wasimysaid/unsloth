// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import type {
  AnswerTarget,
  CodingRow,
  NativeAnswer,
  NativeState,
  RunApi,
} from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

function currentTarget(run: ReturnType<typeof createCodingRun>): AnswerTarget {
  const target = run.getSnapshot().answerTarget;
  assert.ok(target, "A current native answer target must exist");
  return target;
}
const waiting = (id = "question"): NativeState => ({
  info: { id: "conversation", cwd: "/project" },
  configuration: {
    provider: "fixture",
    model: "model",
    reasoning: null,
    mode: "build",
  },
  running_configuration: null,
  active_request: "request",
  requests: [{ id: "request", status: "running", submission_key: "key" }],
  pending_user_request: true,
  user_request: {
    id,
    questions: [
      {
        id: "choice",
        prompt: "Which option?",
        allow_multiple: false,
        options: [
          { label: "First", description: "Native first" },
          { label: "Second", description: "Native second" },
        ],
      },
    ],
  },
});
const answers: NativeAnswer[] = [
  {
    question_id: "choice",
    selected_options: ["Second"],
    freeform_text: "Keep this draft",
  },
];
function harness() {
  let deliver!: (view: unknown) => Promise<void>;
  let generation = 0;
  let position = 0;
  let rows: CodingRow[] = [];
  let respond: RunApi["answer"] = async (id, target) => ({
    conversation_id: id,
    ...target,
    accepted: true,
  });
  const calls: { id: string; target: AnswerTarget; answers: NativeAnswer[] }[] =
    [];
  const api: RunApi = {
    async configure() {
      throw new Error("Question tests must not configure the conversation");
    },
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      return { child: null, outcome: null };
    },
    async answer(id, target, input) {
      calls.push({ id, target, answers: input });
      return await respond(id, target, input);
    },
    async submit(id, key) {
      return {
        conversation_id: id,
        request_id: "request",
        submission_key: key,
      };
    },
    async cancel(id, request) {
      return {
        conversation_id: id,
        request_id: request,
        cancel_requested: true,
      };
    },
    async readEntries(_id, cut) {
      return {
        cut,
        rows,
        older: false,
        newer: false,
        first_id: rows[0]?.id ?? null,
        last_id: rows.at(-1)?.id ?? null,
      };
    },
    async watch(_id, _signal, _connected, consume) {
      generation++;
      position = 0;
      deliver = consume;
      await new Promise(() => {});
    },
  };
  const run = createCodingRun("conversation", api, () => "key", {
    storage: () => memorySubmissionStorage(),
  });
  run.connect();
  const event = (event: unknown) =>
    deliver({
      subscription: `view-${generation}`,
      position: ++position,
      event,
    });
  const start = (state = waiting(), recovering = false) =>
    event({
      type: "start",
      state,
      recovering,
      root: {
        cut: { journal: "root", leaf: `cut-${generation}` },
        live_invocations: [],
      },
    });
  return {
    run,
    api,
    calls,
    event,
    start,
    setRows: (value: CodingRow[]) => {
      rows = value;
    },
    respond: (value: RunApi["answer"]) => {
      respond = value;
    },
  };
}

for (const status of [409, 503]) {
  test(`answer loss evidence ${status} requires deliberate owner reopen without replaying the retained draft`, async () => {
    const h = harness();
    await h.start();
    const target = currentTarget(h.run);
    h.run.editAnswer(target, answers);
    h.respond(async () => { throw new CodingHttpError(status, "Runtime changed; deliberately reopen", true); });
    try {
      await h.run.answer(target);
      assert.equal(h.run.getSnapshot().reopenRequired, true);
      assert.equal(h.run.getSnapshot().connection, "disconnected");
      assert.equal(h.run.getSnapshot().answerTarget, null);
      assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, answers);
      h.run.connect();
      await h.run.answer(target);
      assert.equal(h.calls.length, 1, "an answer cannot reach a replacement owner or replay itself");
      assert.equal(h.run.getSnapshot().connection, "disconnected");
    } finally {
      h.run.detach();
    }
  });

  test(`accepted native answer history does not hide owner-loss evidence ${status} from a late ACK`, async () => {
    const h = harness();
    await h.start();
    const target = currentTarget(h.run);
    h.run.editAnswer(target, answers);
    h.respond(async () => {
      h.setRows([{
        id: "accepted",
        kind: "user",
        answer: { request_id: "request", user_request_id: "question", answers },
      }]);
      await h.event({
        type: "checkpoint",
        cut: { journal: "root", leaf: "accepted-answer-cut" },
        live_invocations: [],
      });
      assert.equal(h.run.getSnapshot().answerForms[0].status, "accepted");
      throw new CodingHttpError(status, "Runtime changed; deliberately reopen", true);
    });
    try {
      await h.run.answer(target);
      assert.equal(h.run.getSnapshot().reopenRequired, true);
      assert.equal(h.run.getSnapshot().connection, "disconnected");
      assert.equal(h.run.getSnapshot().answerTarget, null);
      assert.equal(h.run.getSnapshot().answerForms[0].status, "accepted");
      assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, answers);
      assert.equal(h.run.getSnapshot().rows[0].id, "accepted");
      h.run.connect();
      await h.run.answer(target);
      assert.equal(h.calls.length, 1);
    } finally {
      h.run.detach();
    }
  });
}

test("native controls and exact conversation/view/request/question answers; no optimistic transcript", async () => {
  const h = harness();
  await h.start();
  const target = currentTarget(h.run);
  assert.deepEqual(
    h.run.getSnapshot().answerForms[0].question,
    waiting().user_request,
  );
  h.run.editAnswer(target, answers);
  let resolve!: (result: Awaited<ReturnType<RunApi["answer"]>>) => void;
  h.respond(
    async () =>
      await new Promise((done) => {
        resolve = done;
      }),
  );
  const submission = h.run.answer(target);
  assert.equal(h.run.getSnapshot().answerForms[0].status, "submitting");
  assert.deepEqual(h.run.getSnapshot().rows, []);
  await h.run.answer(target);
  assert.deepEqual(h.calls, [{ id: "conversation", target, answers }]);
  resolve({ conversation_id: "conversation", ...target, accepted: true });
  await submission;
  assert.equal(h.run.getSnapshot().answerForms[0].status, "accepted");
  assert.deepEqual(
    h.run.getSnapshot().rows,
    [],
    "only native public history creates accepted transcript rows",
  );
  await h.run.answer(target);
  assert.equal(h.calls.length, 1);
  h.run.detach();
});

test("reconnect rejects old controls but retains draft for explicit action against a new live view", async () => {
  const h = harness();
  await h.start();
  const stale = currentTarget(h.run);
  h.run.editAnswer(stale, answers);
  h.run.connect();
  await h.run.answer(stale);
  await h.start();
  await h.run.answer(stale);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, answers);
  const fresh = currentTarget(h.run);
  assert.notEqual(fresh.subscription, stale.subscription);
  await h.run.answer(fresh);
  assert.equal(h.calls.length, 1);
  h.run.detach();
});

test("replacement and Stop invalidate stale answers without modifying the replacement", async () => {
  const h = harness();
  await h.start();
  const stale = currentTarget(h.run);
  h.run.editAnswer(stale, answers);
  await h.event({ type: "state", state: waiting("replacement") });
  await h.run.answer(stale);
  h.run.editAnswer(stale, []);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, answers);
  assert.equal(h.run.getSnapshot().answerForms[0].status, "inactive");
  assert.equal(
    h.run.getSnapshot().answerTarget?.user_request_id,
    "replacement",
  );
  const replacement = currentTarget(h.run);
  await h.run.stop();
  await h.run.answer(replacement);
  assert.equal(h.calls.length, 0);
  assert.equal(h.run.getSnapshot().stopping, "request");
  await h.event({
    type: "completed",
    request_id: "request",
    stop_reason: "cancelled",
    error: null,
  });
  await h.event({
    type: "state",
    state: {
      ...waiting(),
      active_request: null,
      pending_user_request: false,
      user_request: null,
      requests: [{ id: "request", status: "cancelled", submission_key: "key" }],
    },
  });
  assert.equal(h.run.getSnapshot().answerTarget, null);
  await h.run.answer(replacement);
  assert.equal(h.calls.length, 0);
  h.run.detach();
});

test("lost ACK reconciles against accepted public history and never replays", async () => {
  const h = harness();
  await h.start();
  const target = currentTarget(h.run);
  h.run.editAnswer(target, answers);
  h.respond(async () => {
    throw new Error("Lost acknowledgement");
  });
  await h.run.answer(target);
  assert.equal(h.run.getSnapshot().answerForms[0].status, "uncertain");
  assert.equal(h.run.getSnapshot().answerTarget, null);
  h.setRows([
    {
      id: "accepted",
      kind: "user",
      text: "Second; Keep this draft",
      answer: { request_id: "request", user_request_id: "question", answers },
    },
  ]);
  await h.start({
    ...waiting(),
    user_request: null,
    pending_user_request: false,
  });
  assert.equal(h.run.getSnapshot().answerForms[0].status, "accepted");
  assert.equal(h.run.getSnapshot().rows[0].historical, true);
  assert.equal(h.calls.length, 1);
  await h.run.answer(target);
  assert.equal(h.calls.length, 1);
  h.run.detach();
});

test("another live view's accepted answer replaces an unsubmitted local draft with native values", async () => {
  const h = harness();
  await h.start();
  h.run.editAnswer(currentTarget(h.run), answers);
  const nativeAnswers = [
    {
      question_id: "choice",
      selected_options: ["First"],
      freeform_text: "Actual accepted answer from another view",
    },
  ];
  h.setRows([
    {
      id: "native-accepted",
      kind: "user",
      answer: {
        request_id: "request",
        user_request_id: "question",
        answers: nativeAnswers,
      },
    },
  ]);
  h.run.connect();
  await h.start({
    ...waiting(),
    user_request: null,
    pending_user_request: false,
  });
  assert.equal(h.run.getSnapshot().answerForms[0].status, "accepted");
  assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, nativeAnswers);
  assert.equal(h.calls.length, 0);
  h.run.detach();
});

test("failed delivery retains actionable draft only after fresh native waiting evidence", async () => {
  const h = harness();
  await h.start();
  const target = currentTarget(h.run);
  h.run.editAnswer(target, answers);
  h.respond(async () => {
    throw new Error("Transport failure before delivery");
  });
  await h.run.answer(target);
  await h.run.answer(target);
  assert.equal(h.calls.length, 1);
  await h.start();
  const form = h.run.getSnapshot().answerForms[0];
  assert.equal(form.status, "error");
  assert.match(form.error ?? "", /still waiting.*not replayed/);
  assert.deepEqual(form.answers, answers);
  assert.equal(h.calls.length, 1);
  h.respond(async (id, fresh) => ({
    conversation_id: id,
    ...fresh,
    accepted: true,
  }));
  await h.run.answer(currentTarget(h.run));
  assert.equal(h.calls.length, 2);
  assert.notEqual(
    h.calls[0].target.subscription,
    h.calls[1].target.subscription,
  );
  h.run.detach();
});

test("recovering capture reconciles uncertain answers only after its checkpoint", async () => {
  for (const stillWaiting of [true, false]) {
    const h = harness();
    await h.start();
    const target = currentTarget(h.run);
    h.run.editAnswer(target, answers);
    h.respond(async () => {
      throw new Error("Lost ACK");
    });
    await h.run.answer(target);
    await h.start(
      stillWaiting
        ? waiting()
        : { ...waiting(), user_request: null, pending_user_request: false },
      true,
    );
    assert.equal(h.run.getSnapshot().answerForms[0].status, "uncertain");
    await h.event({
      type: "checkpoint",
      cut: { journal: "root", leaf: "cut-2" },
      live_invocations: [],
    });
    assert.equal(
      h.run.getSnapshot().answerForms[0].status,
      stillWaiting ? "error" : "inactive",
    );
    assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, answers);
    assert.equal(h.calls.length, 1);
    h.run.detach();
  }
});

test("completion disables stale question before the clearing state event", async () => {
  const h = harness();
  await h.start();
  const target = currentTarget(h.run);
  await h.run.stop();
  await h.event({
    type: "completed",
    request_id: "request",
    stop_reason: "cancelled",
    error: null,
  });
  assert.equal(h.run.getSnapshot().answerTarget, null);
  await h.run.answer(target);
  assert.equal(h.calls.length, 0);
  h.run.detach();
});

test("failed Stop preserves an exact still-live question draft through intervening state", async () => {
  const h = harness();
  await h.start();
  const target = currentTarget(h.run);
  h.run.editAnswer(target, answers);
  let reject!: (reason: Error) => void;
  h.api.cancel = async () =>
    await new Promise((_resolve, fail) => {
      reject = fail;
    });
  const stopping = h.run.stop();
  await h.event({ type: "state", state: waiting() });
  reject(new Error("Stop delivery failed"));
  await stopping;
  await h.start();
  assert.equal(h.run.getSnapshot().stopping, null);
  assert.notEqual(h.run.getSnapshot().answerForms[0].status, "inactive");
  assert.deepEqual(h.run.getSnapshot().answerForms[0].answers, answers);
  await h.run.answer(currentTarget(h.run));
  assert.equal(h.calls.length, 1);
  h.run.detach();
});

test("wrong ACK identity and late replies after reconnect are not acceptance", async () => {
  const h = harness();
  await h.start();
  let resolve!: (result: Awaited<ReturnType<RunApi["answer"]>>) => void;
  const target = currentTarget(h.run);
  h.respond(async (id, target) => ({
    conversation_id: id,
    ...target,
    user_request_id: "wrong",
    accepted: true,
  }));
  await h.run.answer(target);
  assert.equal(h.run.getSnapshot().answerForms[0].status, "uncertain");
  await h.start();
  const fresh = currentTarget(h.run);
  h.respond(
    async () =>
      await new Promise((done) => {
        resolve = done;
      }),
  );
  const submission = h.run.answer(fresh);
  h.run.connect();
  await h.start({
    ...waiting(),
    user_request: null,
    pending_user_request: false,
  });
  resolve({ conversation_id: "conversation", ...fresh, accepted: true });
  await submission;
  assert.equal(h.run.getSnapshot().answerForms[0].status, "inactive");
  assert.match(h.run.getSnapshot().answerForms[0].error ?? "", /not confirmed/);
  h.run.detach();
});
