// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  type CodingDiagnostic,
  type CommandOutcome,
  commandOutcomeLabel,
  contextUsageLabel,
  parseCodingCommand,
} from "../src/features/coding/command-types.ts";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import type { NativeState, RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

function harness(storage = memorySubmissionStorage()) {
  let deliver!: (value: unknown) => Promise<void>;
  let position = 0;
  let views = 0;
  const prompts: string[] = [];
  const invocations: { name: string; tail: string }[] = [];
  const diagnosticRequests: string[] = [];
  let outcome: CommandOutcome = {
    conversation_id: "session",
    operation_id: "key",
    outcome: "handled",
  };
  let failure: Error | null = null;
  let largeDiagnostic = false;
  const api: RunApi = {
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      return { child: null, outcome: null };
    },
    async commands(id) {
      return {
        conversation_id: id,
        commands: [
          {
            name: "project:inspect",
            aliases: ["inspect"],
            description: "Project-contributed inspection",
            argument: "path",
            availability: "any",
          },
        ],
      };
    },
    async command(_id, name, tail) {
      invocations.push({ name, tail });
      if (failure) throw failure;
      return outcome;
    },
    async diagnostics(id, kind) {
      diagnosticRequests.push(kind);
      return {
        conversation_id: id,
        kind,
        data: largeDiagnostic
          ? "x".repeat(70000)
          : { messages_shown: 2, omitted_messages: 10, bytes_bound: 4096 },
      };
    },
    async submit(id, key, text) {
      prompts.push(text);
      return { conversation_id: id, submission_key: key, request_id: "prompt" };
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
        rows: [{ id: "saved", kind: "user", text: "Public history" }],
        older: false,
        newer: false,
        first_id: "saved",
        last_id: "saved",
      };
    },
    async watch(_id, _signal, _connected, onView) {
      deliver = onView;
      views++;
      await new Promise(() => {});
    },
  };
  const run = createCodingRun("session", api, () => "key", {
    storage: () => storage,
  });
  run.connect();
  const start = async (active: string | null = null) => {
    const state: NativeState = {
      info: { id: "session", cwd: "/project" },
      configuration: {
        provider: "fixture",
        model: "fixture",
        reasoning: null,
        mode: "build",
      },
      active_request: active,
      requests: active
        ? [{ id: active, status: "running", submission_key: null }]
        : [],
      pending_user_request: false,
    };
    await deliver({
      subscription: `view-${views}`,
      position: ++position,
      event: {
        type: "start",
        state,
        recovering: false,
        root: { cut: { journal: "root", leaf: "saved" }, live_invocations: [] },
      },
    });
  };
  return {
    run,
    api,
    storage,
    start,
    event: (event: unknown) =>
      deliver({ subscription: `view-${views}`, position: ++position, event }),
    prompts,
    invocations,
    diagnosticRequests,
    setOutcome(value: CommandOutcome) {
      outcome = value;
    },
    setFailure(value: Error | null) {
      failure = value;
    },
    makeLargeDiagnostic() {
      largeDiagnostic = true;
    },
    views: () => views,
  };
}

test("all leading slash attempts parse for native dispatch, not model input", () => {
  assert.deepEqual(
    parseCodingCommand("  /project:inspect   path with spaces  "),
    { name: "project:inspect", tail: "path with spaces" },
  );
  assert.deepEqual(parseCodingCommand("/unknown"), {
    name: "unknown",
    tail: "",
  });
  assert.deepEqual(parseCodingCommand("/"), { name: "", tail: "" });
  assert.equal(parseCodingCommand("Please inspect /path"), null);
});

test("effective discovery retains contributed names, aliases, arguments and native availability", async () => {
  const h = harness();
  await h.start();
  await h.run.discoverCommands();
  assert.deepEqual(h.run.getSnapshot().commands, [
    {
      name: "project:inspect",
      aliases: ["inspect"],
      description: "Project-contributed inspection",
      argument: "path",
      availability: "any",
    },
  ]);
  await h.run.send("/inspect path");
  assert.deepEqual(h.invocations, [{ name: "inspect", tail: "path" }]);
  assert.deepEqual(h.prompts, []);
  h.run.detach();
});

test("handled, transient display and submitted outcomes remain distinct from transcript and completion", async () => {
  const h = harness();
  await h.start();
  const before = h.run.getSnapshot().rows;
  const outcomes: CommandOutcome[] = [
    { conversation_id: "session", operation_id: "key", outcome: "handled" },
    {
      conversation_id: "session",
      operation_id: "key",
      outcome: "display",
      text: "Bounded native display",
    },
    {
      conversation_id: "session",
      operation_id: "key",
      outcome: "submitted",
      request_id: "native-admitted",
    },
  ];
  for (const outcome of outcomes) {
    h.setOutcome(outcome);
    await h.run.send("/inspect");
    assert.deepEqual(h.run.getSnapshot().commandOutcome, outcome);
    assert.deepEqual(h.run.getSnapshot().rows, before);
    assert.equal(h.run.getSnapshot().native?.active_request, null);
  }
  assert.match(
    commandOutcomeLabel(outcomes[2]),
    /completion is reported by the native view/,
  );
  assert.deepEqual(h.prompts, []);
  h.run.detach();
});

test("unknown/terminal-only and busy errors are authoritative native refusals with no prompt fallback", async () => {
  const h = harness();
  await h.start("active");
  for (const [name, status, message] of [
    ["terminal-only", 400, "Not supported by this frontend"],
    ["compress", 409, "Native session is busy"],
  ] as const) {
    h.setFailure(new CodingHttpError(status, message));
    await h.run.send(`/${name}`);
    assert.equal(h.run.getSnapshot().commandError, message);
    assert.equal(h.run.getSnapshot().uncertainCommand, null);
  }
  assert.equal(h.invocations.length, 2);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.run.getSnapshot().native?.active_request, "active");
  h.run.detach();
});

test("overlap continuation retains rich input while a command is pending or uncertain", async () => {
  const h = harness();
  const overlap = { cwd: "/project", conversations: [{ id: "other-native" }] };
  const input = {
    text: "@review inspect",
    skill_mentions: [
      { name: "review", path: "/project/review/SKILL.md", start: 0, end: 7 },
    ],
    images: [{ mime_type: "image/png", data: "original-base64" }],
  };
  h.api.checkOverlap = async () => overlap;
  await h.start();
  const { text, ...extras } = input;
  await h.run.send(text, extras);
  const warning = structuredClone(h.run.getSnapshot().overlapWarning);
  let rejectCommand!: (reason: Error) => void;
  h.api.command = async () =>
    await new Promise((_resolve, reject) => {
      rejectCommand = reject;
    });
  const command = h.run.executeCommand("inspect");
  try {
    assert.equal(await h.run.continueOverlap(), false);
    assert.deepEqual(h.run.getSnapshot().overlapWarning, warning);
    rejectCommand(new Error("Command reply lost"));
    await command;
    await h.start();
    assert.ok(h.run.getSnapshot().uncertainCommand);
    assert.equal(await h.run.continueOverlap(), false);
    assert.deepEqual(h.run.getSnapshot().overlapWarning, warning);
    assert.deepEqual(h.prompts, []);
    h.api.commandReceipt = async () => ({
      conversation_id: "session",
      operation_id: "key",
      status: "completed",
      result: {
        conversation_id: "session",
        operation_id: "key",
        outcome: "handled",
      },
    });
    await h.run.reconcileCommand();
    assert.equal(await h.run.continueOverlap(), true);
    assert.deepEqual(h.prompts, [text]);
  } finally {
    rejectCommand(new Error("Command reply lost"));
    await command;
    h.run.detach();
  }
});

test("lost command reply reconstructs a fresh view and never blindly retries or fabricates outcome", async () => {
  const h = harness();
  await h.start();
  h.setFailure(new Error("Transport response lost"));
  await h.run.executeCommand("compress");
  assert.equal(h.views(), 2);
  assert.deepEqual(h.run.getSnapshot().uncertainCommand, {
    name: "compress",
    operation_id: "key",
    reconciled: false,
  });
  await assert.rejects(
    h.run.executeCommand("compress"),
    /No command was replayed/,
  );
  await h.start();
  assert.deepEqual(h.run.getSnapshot().uncertainCommand, {
    name: "compress",
    operation_id: "key",
    reconciled: true,
  });
  // A state capture cannot prove arbitrary contributed command effects. Keep unknown explicit.
  await assert.rejects(
    h.run.executeCommand("compress"),
    /No command was replayed/,
  );
  assert.equal(h.invocations.length, 1);
  assert.equal(h.run.getSnapshot().commandOutcome, null);
  h.run.detach();
});

test("diagnostics are intentionally requested, bounded, ephemeral, and never appended to public rows", async () => {
  const h = harness();
  await h.start();
  assert.deepEqual(h.diagnosticRequests, []);
  const before = h.run.getSnapshot().rows;
  for (const kind of ["context", "tokens", "retry", "execution"] as const) {
    await h.run.inspectDiagnostic(kind);
    assert.equal(h.run.getSnapshot().diagnostic?.kind, kind);
  }
  assert.deepEqual(h.diagnosticRequests, [
    "context",
    "tokens",
    "retry",
    "execution",
  ]);
  assert.deepEqual(h.run.getSnapshot().rows, before);
  h.run.clearDiagnostic();
  assert.equal(h.run.getSnapshot().diagnostic, null);
  h.makeLargeDiagnostic();
  await h.run.inspectDiagnostic("context");
  assert.equal(h.run.getSnapshot().diagnostic, null);
  const error = h.run.getSnapshot().commandError;
  assert.ok(error);
  assert.match(error, /exceeded their bound/);
  h.run.detach();
});

test("compact usage distinguishes missing, estimated and provider-confirmed metrics", () => {
  assert.match(contextUsageLabel(), /not yet reported/);
  assert.match(
    contextUsageLabel({
      prompt_tokens: {
        used_prompt_tokens: 100,
        confirmed_prompt_tokens: 0,
        estimated_tail_tokens: 100,
        provider_confirmed: false,
      },
    }),
    /estimated/,
  );
  assert.match(
    contextUsageLabel({
      prompt_tokens: {
        used_prompt_tokens: 120,
        confirmed_prompt_tokens: 100,
        estimated_tail_tokens: 20,
        provider_confirmed: true,
      },
    }),
    /100 provider-confirmed.*\+20 estimated tail/,
  );
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("command identity survives remount, stores no arguments, and only exact settled receipt permits another action", async () => {
  const storage = memorySubmissionStorage();
  const h = harness(storage);
  await h.start();
  h.setFailure(new Error("lost response"));
  await h.run.executeCommand("inspect", "private argument never retained");
  const { pendingCommandStorageKey } = await import(
    "../src/features/coding/pending-command.ts"
  );
  assert.equal(
    storage
      .getItem(pendingCommandStorageKey("session"))
      ?.includes("private argument"),
    false,
  );
  h.run.detach();
  const reopened = harness(storage);
  await reopened.start();
  assert.equal(
    reopened.run.getSnapshot().uncertainCommand?.operation_id,
    "key",
  );
  await assert.rejects(
    reopened.run.executeCommand("inspect"),
    /No command was replayed/,
  );
  reopened.api.commandReceipt = async (id, operation) => ({
    conversation_id: id,
    operation_id: "wrong",
    status: "completed",
    result: {
      conversation_id: id,
      operation_id: operation,
      outcome: "handled",
    },
  });
  await reopened.run.reconcileCommand();
  assert.notEqual(reopened.run.getSnapshot().uncertainCommand, null);
  reopened.api.commandReceipt = async (id, operation) => ({
    conversation_id: id,
    operation_id: operation,
    status: "pending",
  });
  await reopened.run.reconcileCommand();
  assert.notEqual(reopened.run.getSnapshot().uncertainCommand, null);
  reopened.api.commandReceipt = async (id, operation) => ({
    conversation_id: id,
    operation_id: operation,
    status: "completed",
    result: {
      conversation_id: id,
      operation_id: operation,
      outcome: "handled",
    },
  });
  await reopened.run.reconcileCommand();
  assert.equal(reopened.run.getSnapshot().uncertainCommand, null);
  assert.equal(storage.getItem(pendingCommandStorageKey("session")), null);
  assert.equal(
    reopened.invocations.length,
    0,
    "receipt reads must never repeat delivery",
  );
  reopened.run.detach();
});

test("late failed command cannot resurrect a detached native watcher or mutate detached presentation", async () => {
  const h = harness();
  await h.start();
  let reject!: (reason: unknown) => void;
  h.api.command = () =>
    new Promise((_resolve, failure) => {
      reject = failure;
    });
  const sending = h.run.executeCommand("inspect");
  h.run.detach();
  const state = h.run.getSnapshot();
  reject(new Error("late response failure"));
  await sending;
  await tick();
  assert.equal(h.views(), 1);
  assert.equal(h.run.getSnapshot(), state);
});

test("dismissed diagnostics ignore late results and errors and release the pending control", async () => {
  const h = harness();
  await h.start();
  let resolve!: (value: CodingDiagnostic) => void;
  h.api.diagnostics = () =>
    new Promise((success) => {
      resolve = success;
    });
  const request = h.run.inspectDiagnostic("context");
  h.run.clearDiagnostic();
  resolve({
    conversation_id: "session",
    kind: "context",
    data: { roles: ["user"] },
  });
  await request;
  assert.equal(h.run.getSnapshot().diagnostic, null);
  assert.equal(h.run.getSnapshot().inspectingDiagnostic, null);
  let reject!: (reason: unknown) => void;
  h.api.diagnostics = () =>
    new Promise((_resolve, failure) => {
      reject = failure;
    });
  const failing = h.run.inspectDiagnostic("tokens");
  h.run.clearDiagnostic();
  reject(new Error("dismissed error"));
  await failing;
  assert.equal(h.run.getSnapshot().commandError, null);
  h.run.detach();
});

test("browser command storage failure fails closed before any HTTP action", async () => {
  const storage = memorySubmissionStorage();
  const h = harness(storage);
  await h.start();
  storage.setItem = () => {
    throw new Error("quota");
  };
  await h.run.executeCommand("inspect");
  assert.equal(h.invocations.length, 0);
  const error = h.run.getSnapshot().storageError;
  assert.ok(error);
  assert.match(error, /No command was sent/);
  h.run.detach();
});

test("native numeric usage and compression lifecycle update independently of public history rows", async () => {
  const h = harness();
  await h.start();
  const rows = h.run.getSnapshot().rows;
  const usage = {
    prompt_tokens: {
      used_prompt_tokens: 100,
      confirmed_prompt_tokens: 80,
      estimated_tail_tokens: 20,
      provider_confirmed: true,
    },
    request_usage: { input_tokens: 80, output_tokens: 10 },
  };
  await h.event({
    type: "usage",
    usage,
    compression: { request_id: "compression", status: "running" },
  });
  assert.deepEqual(h.run.getSnapshot().native?.usage, usage);
  assert.equal(h.run.getSnapshot().native?.compression?.status, "running");
  await h.event({
    type: "completed",
    request_id: "compression",
    stop_reason: "stop",
    error: null,
    compression: {
      request_id: "compression",
      status: "completed",
      before_tokens: 100,
      after_tokens: 40,
    },
  });
  assert.equal(h.run.getSnapshot().native?.compression?.status, "completed");
  assert.deepEqual(h.run.getSnapshot().rows, rows);
  h.run.detach();
});
