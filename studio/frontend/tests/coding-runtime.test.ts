// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { ExternalStoreThreadRuntimeCore } from "../node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-thread-runtime-core.js";
import {
  projectTranscript,
  latestWindow,
} from "../src/features/coding/transcript-model.ts";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import {
  type CodingRunState,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type { CodingRow, RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";
import {
  type StubElement,
  loadWithStubs,
  stubJsxRuntime,
} from "./helpers/module-stubs.ts";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const input = {
  parentId: null,
  sourceId: null,
  role: "user" as const,
  content: [{ type: "text" as const, text: "Native input" }],
  attachments: [],
  createdAt: new Date(),
  metadata: { custom: {} },
  runConfig: {},
};

test("installed external runtime disables execution before project selection", async () => {
  const runtime = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    codingRunAdapter(null, null),
  );
  assert.equal(runtime.isDisabled, true);
  assert.equal(runtime.isRunning, false);
  assert.deepEqual(runtime.messages, []);
  await assert.rejects(runtime.append(input), /Choose a host project folder/);
  assert.deepEqual(runtime.messages, []);
  assert.equal(runtime.capabilities.edit, false);
  assert.equal(runtime.capabilities.reload, false);
});

async function installedRuntime(
  t: TestContext,
  rows: CodingRow[],
  storage = memorySubmissionStorage(),
) {
  const calls: unknown[] = [];
  let deliver!: (view: unknown) => Promise<void>;
  const api: RunApi = {
    async setMode(id, mode) {
      return { conversation_id: id, mode };
    },
    async decidePlan(id, plan, decision) {
      return {
        conversation_id: id,
        plan_id: plan.id,
        decision,
        request_id: null,
      };
    },
    async answer(id, target) {
      return { conversation_id: id, ...target, accepted: true };
    },
    async configure() {
      throw new Error("Unexpected configuration change in composer test");
    },
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      return { child: null, outcome: null };
    },
    async submit(id, submissionKey, text) {
      calls.push({ id, submission_key: submissionKey, text });
      return {
        conversation_id: id,
        request_id: "request",
        submission_key: submissionKey,
      };
    },
    async cancel(id, requestId) {
      return {
        conversation_id: id,
        request_id: requestId,
        cancel_requested: true,
      };
    },
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
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
    async watch(_id, _signal, _connected, onView) {
      deliver = onView;
      await new Promise(() => {});
    },
  };
  const run = createCodingRun("conversation", api, () => "submission", {
    storage: () => storage,
  });
  t.after(() => run.detach());
  run.connect();
  await deliver({
    subscription: "view",
    position: 1,
    event: {
      type: "start",
      state: {
        info: { id: "conversation", cwd: "/project" },
        configuration: { provider: "provider", model: "model", mode: "build" },
        active_request: null,
        requests: [],
        pending_user_request: false,
        user_request: null,
      },
      root: {
        cut: { journal: "root", leaf: rows.length ? "leaf" : null },
        live_invocations: [],
      },
    },
  });
  const runtime = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    codingRunAdapter(run.getSnapshot(), run),
  );
  return { run, runtime, calls };
}

test("installed external runtime projects native state and forwards exact submission without local turns", async (t) => {
  const { run, runtime, calls } = await installedRuntime(t, [
    { id: "entry", kind: "assistant", text: "Saved native reply" },
  ]);
  assert.equal(runtime.isDisabled, false);
  const [projected] = projectTranscript(run.getSnapshot().rows, latestWindow());
  assert.equal(runtime.messages[0].id, projected.key);
  assert.equal(projected.key, "row:entry");
  assert.equal(
    "row" in projected ? projected.row : null,
    run.getSnapshot().rows[0],
    "the projected block carries the unmodified native row",
  );
  assert.equal(runtime.messages[0].content[0].type, "text");
  await runtime.append({ ...input, parentId: "row:entry" });
  assert.deepEqual(calls, [
    { id: "conversation", submission_key: "submission", text: "Native input" },
  ]);
  assert.equal(
    runtime.messages.length,
    1,
    "no assistant-ui optimistic turn or second transcript",
  );
});

test("installed runtime upcoming assistant placeholder is not a native transcript row", () => {
  const state: CodingRunState = {
    connection: "connected",
    older: false,
    viewingEarlier: false,
    newer: false,
    loadingEarlier: false,
    activityVersion: 0,
    submitting: false,
    configuring: false,
    configurationUncertain: false,
    stopping: null,
    error: null,
    completion: null,
    uncertainSubmission: null,
    storageError: null,
    unsentDraft: null,
    deliveryRecovered: false,
    disconnected: false,
    reopenRequired: false,
    reconcilingAction: null,
    retryStop: null,
    continuationRequested: null,
    planControl: null,
    planControlReconciling: false,
    planControlUncertain: false,
    planControlNotice: null,
    planControlError: null,
    goalChanging: null,
    reconcilingGoal: null,
    goalNotice: null,
    answerTarget: null,
    answerForms: [],
    commands: null,
    discoveringCommands: false,
    commandBusy: false,
    commandOutcome: null,
    commandError: null,
    uncertainCommand: null,
    reconcilingCommand: false,
    overlapWarning: null,
    native: {
      info: { id: "conversation", cwd: "/project", title: null },
      configuration: {
        provider: "external",
        model: "model",
        reasoning: null,
        mode: "build",
      },
      running_configuration: {
        provider: "external",
        model: "model",
        reasoning: null,
        mode: "build",
      },
      active_request: "request",
      pending_user_request: false,
      plan: null,
      action_disabled_reason: null,
      user_request: null,
      requests: [
        { id: "request", status: "running", submission_key: "submission" },
      ],
    },
    rows: [{ id: "native-user", kind: "user", text: "Accepted native input" }],
  };
  const runtime = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    codingRunAdapter(state, null),
  );
  assert.equal(runtime.isRunning, true);
  assert.equal(
    runtime.messages.length,
    2,
    "shipped artifact creates an upcoming assistant placeholder",
  );
  const projected = projectTranscript(state.rows, latestWindow("request"));
  assert.deepEqual(
    projected.map((block) => [block.kind, block.key]),
    [["user", "row:native-user"]],
  );
  assert.equal(runtime.messages[0].id, "row:native-user");
  // The transcript renders projected blocks, never runtime messages, so the
  // shipped placeholder matches no native block and renders nothing.
  assert.ok(
    !projected.some((block) => block.key === runtime.messages[1].id),
    "the placeholder is not a native transcript row",
  );
  assert.deepEqual(
    state.rows.map((row) => row.id),
    ["native-user"],
  );
});

test("coding route stays authenticated and excludes general-chat execution and transcript persistence", () => {
  assert.match(
    source("../src/app/routes/coding.tsx"),
    /beforeLoad: \(\) => requireAuth\(\)/,
  );
  assert.match(source("../src/app/router.tsx"), /codingRoute,/);
  for (const name of [
    "coding-page.tsx",
    "coding-surface.tsx",
    "api.ts",
    "session.ts",
    "run-session.ts",
    "run-runtime.ts",
    "project-folder-dialog.tsx",
    "model-selection.ts",
    "events.ts",
    "transcript-model.ts",
    "transcript.tsx",
    "tool-report.tsx",
    "coding-composer.tsx",
    "mention-menu.ts",
    "mention-list.tsx",
    "input.ts",
  ]) {
    const contents = source(`../src/features/coding/${name}`);
    assert.doesNotMatch(
      contents,
      /from ["'][^"']*(?:features\/chat|app-sidebar|assistant-ui\/thread|chat-history|sandbox|model-picker)/,
    );
    assert.doesNotMatch(
      contents,
      /localStorage|indexedDB|EventSource|ChatModelAdapter/,
    );
  }
});

test("selection disclosure remains non-persisting trust and not a sandbox", () => {
  const dialog = source(
    "../src/features/coding/project-folder-dialog.tsx",
  ).replace(/\s+/g, " ");
  assert.match(dialog, /works directly in this folder.*isn't a sandbox/);
  assert.match(
    dialog,
    /project settings and extensions are trusted for that conversation only/,
  );
  // Only where and with which model new work starts is kept in the browser.
  const memory = source("../src/features/coding/new-conversation-memory.ts");
  assert.deepEqual(
    [...memory.matchAll(/KEY = "([^"]+)"/g)].map((match) => match[1]),
    ["unsloth_coding_project", "unsloth_coding_model"],
  );
});

test("installed composer.send retains a recoverable unsent draft when submission storage hits quota", async (t) => {
  const storage = memorySubmissionStorage();
  storage.setItem = () => {
    throw new Error("Storage quota exceeded");
  };
  const { run, runtime, calls } = await installedRuntime(t, [], storage);
  const draft = "  Keep this unsent prompt\nincluding its second line  ";
  runtime.composer.setText(draft);
  const sending = runtime.composer.send();
  assert.equal(
    runtime.composer.text,
    "",
    "shipped composer eagerly clears input before adapter.onNew",
  );
  await sending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls,
    [],
    "storage failure must never reach prompt HTTP delivery",
  );
  assert.match(
    run.getSnapshot().storageError ?? "",
    /No prompt was sent.*quota/,
  );
  assert.equal(
    run.getSnapshot().uncertainSubmission,
    null,
    "an unsent draft is not unconfirmed HTTP delivery",
  );
  assert.partialDeepStrictEqual(run.getSnapshot(), { unsentDraft: draft });
  runtime.__internal_setAdapter(codingRunAdapter(run.getSnapshot(), run));
  assert.equal(
    runtime.isDisabled,
    true,
    "sending remains fail-closed after failed persistence",
  );
  assert.deepEqual(
    runtime.messages,
    [],
    "the unsent draft must not become a transcript row",
  );
  const { CodingUnsentDraft } = loadWithStubs<{
    CodingUnsentDraft: (props: { text: string }) => StubElement;
  }>(new URL("../src/features/coding/unsent-draft.tsx", import.meta.url), {
    "react/jsx-runtime": stubJsxRuntime(),
  });
  const recovery = CodingUnsentDraft({
    text: run.getSnapshot().unsentDraft!,
  });
  const textarea = (recovery.props.children as StubElement[]).find(
    (child) => child.type === "textarea",
  );
  assert.ok(textarea, "the recovered draft has a visible selectable field");
  assert.equal(textarea.props.value, draft);
  assert.equal(textarea.props.readOnly, true);
  assert.notEqual(
    textarea.props.disabled,
    true,
    "disabled composer must not prevent selecting/copying the unsent draft",
  );
  assert.equal(textarea.props["data-testid"], "coding-unsent-draft");
  assert.match(
    source("../src/features/coding/coding-surface.tsx"),
    /CodingUnsentDraft text=\{state.unsentDraft\}/,
  );
});
