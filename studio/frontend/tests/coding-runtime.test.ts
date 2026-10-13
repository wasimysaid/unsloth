// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExternalStoreThreadRuntimeCore } from "../node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-thread-runtime-core.js";
import { nativeMessageRow } from "../src/features/coding/presentation.ts";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import {
  type CodingRunState,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type { RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
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

test("installed external runtime projects native state and forwards exact submission without local turns", async () => {
  const calls: unknown[] = [];
  let deliver!: (view: unknown) => Promise<void>;
  const api: RunApi = {
    async configure() {
      return {
        provider: "provider",
        model: "model",
        reasoning: null,
        mode: "build",
      };
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
    async readEntries(_id, cut) {
      return {
        cut,
        rows: [{ id: "entry", kind: "assistant", text: "Saved native reply" }],
        older: false,
        newer: false,
        first_id: "entry",
        last_id: "entry",
      };
    },
    async watch(_id, _signal, _connected, onView) {
      deliver = onView;
      await new Promise(() => {});
    },
  };
  const storage = memorySubmissionStorage();
  const run = createCodingRun("conversation", api, () => "submission", {
    storage: () => storage,
  });
  run.connect();
  await deliver({
    subscription: "view",
    position: 1,
    event: {
      type: "start",
      recovering: false,
      state: {
        info: { id: "conversation", cwd: "/project" },
        configuration: { provider: "provider", model: "model", mode: "build" },
        active_request: null,
        requests: [],
        pending_user_request: false,
      },
      root: { cut: { journal: "root", leaf: "leaf" }, live_invocations: [] },
    },
  });
  const runtime = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    codingRunAdapter(run.getSnapshot(), run),
  );
  assert.equal(runtime.isDisabled, false);
  assert.equal(runtime.messages[0].id, "entry");
  assert.equal(runtime.messages[0].content[0].type, "text");
  await runtime.append({ ...input, parentId: "entry" });
  assert.deepEqual(calls, [
    { id: "conversation", submission_key: "submission", text: "Native input" },
  ]);
  assert.equal(
    runtime.messages.length,
    1,
    "no assistant-ui optimistic turn or second transcript",
  );
  run.detach();
});

test("installed runtime upcoming assistant placeholder is not a native transcript row", () => {
  const state: CodingRunState = {
    connection: "connected",
    recovering: false,
    older: false,
    viewingEarlier: false,
    loadingEarlier: false,
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
  const user = nativeMessageRow(runtime.messages[0]);
  assert.equal(user?.id, "native-user");
  // Same guard as NativeMessage: null is intentionally invisible, while a
  // missing undefined row used to crash when the renderer accessed row.tool.
  assert.doesNotThrow(() =>
    runtime.messages.map((message) => {
      const row = nativeMessageRow(message);
      return row === null ? null : (row.tool ?? row.text);
    }),
  );
  assert.equal(nativeMessageRow(runtime.messages[1]), null);
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
  const page = source("../src/features/coding/coding-page.tsx").replace(
    /\s+/g,
    " ",
  );
  const dialog = source(
    "../src/features/coding/project-folder-dialog.tsx",
  ).replace(/\s+/g, " ");
  assert.match(
    page,
    /Opening or reopening trusts project configuration and extensions for this native controller only/,
  );
  assert.match(page, /no shared trust decision is saved/);
  assert.match(page, /aria-describedby="coding-project-disclosure"/);
  assert.match(dialog, /working directory.*not an upload or a sandbox/);
  assert.match(dialog, /no shared trust decision is saved/);
});

test("installed composer.send retains a recoverable unsent draft when submission storage hits quota", async () => {
  const calls: unknown[] = [];
  let deliver!: (view: unknown) => Promise<void>;
  const storage = memorySubmissionStorage();
  storage.setItem = () => {
    throw new Error("Storage quota exceeded");
  };
  const api: RunApi = {
    async configure() {
      throw new Error("Unexpected configuration change in composer test");
    },
    async submit(id, key, text) {
      calls.push({ id, key, text });
      return {
        conversation_id: id,
        submission_key: key,
        request_id: "request",
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
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
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
  run.connect();
  try {
    await deliver({
      subscription: "view",
      position: 1,
      event: {
        type: "start",
        recovering: false,
        state: {
          info: { id: "conversation", cwd: "/project" },
          configuration: {
            provider: "provider",
            model: "model",
            mode: "build",
          },
          active_request: null,
          requests: [],
          pending_user_request: false,
        },
        root: { cut: { journal: "root", leaf: null }, live_invocations: [] },
      },
    });
    const runtime = new ExternalStoreThreadRuntimeCore(
      { getModelContext: () => ({}) },
      codingRunAdapter(run.getSnapshot(), run),
    );
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
  } finally {
    run.detach();
  }
});
