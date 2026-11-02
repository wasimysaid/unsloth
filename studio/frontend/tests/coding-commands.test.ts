// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type * as Composer from "../src/features/coding/coding-composer.tsx";
import * as commandTypes from "../src/features/coding/command-types.ts";
import * as codingInput from "../src/features/coding/input.ts";
import * as mentionMenu from "../src/features/coding/mention-menu.ts";
import * as pendingSubmission from "../src/features/coding/pending-submission.ts";
import * as runRuntime from "../src/features/coding/run-runtime.ts";
import * as runSession from "../src/features/coding/run-session.ts";
import {
  type CommandOutcome,
  parseCodingCommand,
} from "../src/features/coding/command-types.ts";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import type { NativeState, RunApi } from "../src/features/coding/run-types.ts";
import {
  memoryImageStorage,
  memorySubmissionStorage,
} from "./coding-storage-fixture.ts";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
} from "./helpers/module-stubs.ts";

function harness(storage = memorySubmissionStorage()) {
  let deliver!: (value: unknown) => Promise<void>;
  let position = 0;
  let views = 0;
  const prompts: string[] = [];
  const invocations: { name: string; tail: string }[] = [];
  let outcome: CommandOutcome = {
    conversation_id: "session",
    operation_id: "key",
    outcome: "handled",
  };
  let failure: Error | null = null;
  const api: RunApi = {
    async setMode() {
      throw new Error(
        "Command dispatch must not change coding mode through Studio",
      );
    },
    async decidePlan() {
      throw new Error("Command dispatch must not decide plans through Studio");
    },
    async answer() {
      throw new Error("Command tests must not answer a question");
    },
    async configure() {
      return {
        provider: "fixture",
        model: "fixture",
        reasoning: null,
        mode: "build",
      };
    },
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
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
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
  const images = memoryImageStorage();
  const run = createCodingRun("session", api, () => "key", {
    storage: () => storage,
    imageStorage: () => images,
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
      running_configuration: null,
      active_request: active,
      requests: active
        ? [{ id: active, status: "running", submission_key: null }]
        : [],
      pending_user_request: false,
      plan: null,
      action_disabled_reason: null,
      user_request: null,
    };
    await deliver({
      subscription: `view-${views}`,
      position: ++position,
      event: {
        type: "start",
        state,
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
    setOutcome(value: CommandOutcome) {
      outcome = value;
    },
    setFailure(value: Error | null) {
      failure = value;
    },
    views: () => views,
  };
}

function commandComposer(run: ReturnType<typeof createCodingRun>) {
  let text = "";
  let hook = 0;
  const hooks: unknown[] = [];
  const draft = codingInput.createInputDraft();
  const node = {
    get value() {
      return text;
    },
    selectionStart: 0,
    focus() {},
    setSelectionRange(start: number) {
      this.selectionStart = start;
    },
  };
  const composer = loadWithStubs<typeof Composer>(
    new URL("../src/features/coding/coding-composer.tsx", import.meta.url),
    {
      "react/jsx-runtime": stubJsxRuntime(),
      "@/components/ui/button": { Button: "button" },
      "@/components/ui/dialog": {},
      "@assistant-ui/react": {
        ComposerPrimitive: { Root: "root", Input: "input", Send: "send" },
        useComposerRuntime: () => ({
          getState: () => ({ text }),
          setText: (next: string) => {
            text = next;
          },
        }),
      },
      "@assistant-ui/tap": {
        flushResourcesSync: (apply: () => void) => apply(),
      },
      "@/features/native-intents": {
        useNativeFileDrop: () => ({ dragging: false, dragHandlers: {} }),
      },
      "react-dom": { flushSync: (apply: () => void) => apply() },
      "lucide-react": {},
      react: {
        useEffect: () => {},
        useRef: (current: unknown) => {
          const index = hook++;
          return (hooks[index] ??= { current });
        },
        useState: (initial: unknown) => {
          const index = hook++;
          if (!(index in hooks)) hooks[index] = initial;
          return [
            hooks[index],
            (next: unknown) => {
              hooks[index] =
                typeof next === "function" ? next(hooks[index]) : next;
            },
          ];
        },
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
          snapshot(),
      },
      "./api": {},
      "./command-types": commandTypes,
      "./input": codingInput,
      "./mention-list": {
        CompletionList: "completion-list",
        mentionOptionId: () => "",
      },
      "./mention-menu": mentionMenu,
      "./pending-submission": pendingSubmission,
      "./run-runtime": runRuntime,
      "./run-session": runSession,
    },
  );
  const nodes = (value: unknown): StubElement[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const element = value as StubElement;
    return [element, ...nodes(element.props.children)];
  };
  const render = () => {
    hook = 0;
    return nodes(
      composer.CodingComposer({
        conversationId: "session",
        run,
        state: run.getSnapshot(),
        draft,
        canEdit: true,
        sendBlocked: null,
        inputRef: { current: node as unknown as HTMLTextAreaElement },
      }),
    );
  };
  const input = () => {
    const element = render().find((element) => element.type === "input");
    assert.ok(element, "The coding prompt is rendered");
    return element;
  };
  return {
    type(value: string, cursor = value.length) {
      const element = input();
      text = value;
      node.selectionStart = cursor;
      (element.props.onChange as (event: unknown) => void)({
        currentTarget: node,
        nativeEvent: { isComposing: false },
      });
    },
    options() {
      const list = render().find(
        (element) => element.type === "completion-list",
      );
      return (list?.props.items as { label: string }[] | undefined)?.map(
        (item) => item.label,
      );
    },
    async press(key: string, shiftKey = false) {
      let prevented = false;
      (input().props.onKeyDown as (event: unknown) => void)({
        key,
        shiftKey,
        nativeEvent: { isComposing: false },
        currentTarget: node,
        preventDefault() {
          prevented = true;
        },
      });
      // The primitive sends only when the production handler leaves Enter alone.
      if (key === "Enter" && !shiftKey && !prevented) await run.send(text);
      return { prevented, text };
    },
  };
}

test("cold Enter preserves /plan while native command discovery is pending", async () => {
  const h = harness();
  await h.start();
  let release!: () => void;
  const catalog = await h.api.commands!("session");
  const pending = new Promise<typeof catalog>((resolve) => {
    release = () => resolve(catalog);
  });
  h.api.commands = async () => await pending;
  try {
    const composer = commandComposer(h.run);
    composer.type("/plan");
    assert.equal(h.run.getSnapshot().discoveringCommands, true);
    assert.equal(h.run.getSnapshot().commands, null);
    assert.deepEqual(composer.options(), ["/build"]);
    assert.deepEqual(await composer.press("Enter"), {
      prevented: false,
      text: "/plan",
    });
    assert.deepEqual(h.invocations, [{ name: "plan", tail: "" }]);

    composer.type("  /plan preserve this tail", 7);
    assert.deepEqual(await composer.press("Enter"), {
      prevented: false,
      text: "  /plan preserve this tail",
    });
    assert.deepEqual(h.invocations, [
      { name: "plan", tail: "" },
      { name: "plan", tail: "preserve this tail" },
    ]);
    assert.deepEqual(h.prompts, []);

    composer.type("/b");
    assert.deepEqual(await composer.press("Tab"), {
      prevented: true,
      text: "/build ",
    });
  } finally {
    release();
    h.run.detach();
  }
});

test("Enter dispatches a fully typed native alias without canonicalizing it", async () => {
  const h = harness();
  await h.start();
  await h.run.discoverCommands();
  try {
    const composer = commandComposer(h.run);
    composer.type("/inspect");
    assert.deepEqual(await composer.press("Enter"), {
      prevented: false,
      text: "/inspect",
    });
    assert.deepEqual(h.invocations, [{ name: "inspect", tail: "" }]);
    assert.deepEqual(h.prompts, []);
  } finally {
    h.run.detach();
  }
});

test("Enter honors an exact command even when a longer prefix match is highlighted", async () => {
  const h = harness();
  await h.start();
  h.api.commands = async (id) => ({
    conversation_id: id,
    commands: ["planner", "plan"].map((name) => ({
      name,
      aliases: [],
      description: "Plan work",
      argument: null,
      availability: "any",
    })),
  });
  await h.run.discoverCommands();
  try {
    const composer = commandComposer(h.run);
    composer.type("/plan");
    assert.deepEqual(composer.options(), ["/planner", "/plan", "/build"]);
    assert.deepEqual(await composer.press("Enter"), {
      prevented: false,
      text: "/plan",
    });
    assert.deepEqual(h.invocations, [{ name: "plan", tail: "" }]);
  } finally {
    h.run.detach();
  }
});

for (const key of ["Enter", "Tab"]) {
  test(`${key} still completes a partial command after native discovery`, async () => {
    const h = harness();
    await h.start();
    await h.run.discoverCommands();
    try {
      const composer = commandComposer(h.run);
      composer.type("/ins");
      assert.deepEqual(await composer.press(key), {
        prevented: true,
        text: "/project:inspect ",
      });
      await composer.press("Enter");
      assert.deepEqual(h.invocations, [{ name: "project:inspect", tail: "" }]);
    } finally {
      h.run.detach();
    }
  });
}

test("failed native discovery cannot replace a typed /plan with a description match", async () => {
  const h = harness();
  await h.start();
  h.api.commands = async () => {
    throw new Error("Catalog unavailable");
  };
  await h.run.discoverCommands();
  try {
    const composer = commandComposer(h.run);
    composer.type("/plan");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.run.getSnapshot().commandError, "Catalog unavailable");
    assert.deepEqual(await composer.press("Enter"), {
      prevented: false,
      text: "/plan",
    });
    assert.deepEqual(h.invocations, [{ name: "plan", tail: "" }]);
  } finally {
    h.run.detach();
  }
});

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

test("model selection guards slash commands until the configuration settles", async () => {
  const h = harness();
  await h.start();
  let rejectConfiguration!: (reason: Error) => void;
  h.api.configure = async () =>
    await new Promise((_resolve, reject) => {
      rejectConfiguration = reject;
    });
  const configuration = h.run.configure({ reasoning: "high" });
  const failedConfiguration = assert.rejects(
    configuration,
    /Configuration reply lost/,
  );
  try {
    await assert.rejects(h.run.send("/inspect pending"), /reconstructed/);
    rejectConfiguration(new Error("Configuration reply lost"));
    await failedConfiguration;
    assert.equal(h.run.getSnapshot().configurationUncertain, true);
    await assert.rejects(h.run.send("/inspect uncertain"), /reconstructed/);
    assert.deepEqual(h.invocations, []);
    h.run.connect();
    await h.start();
    await h.run.send("/inspect reconciled");
    assert.deepEqual(h.invocations, [{ name: "inspect", tail: "reconciled" }]);
    assert.deepEqual(h.prompts, []);
  } finally {
    rejectConfiguration(new Error("Configuration reply lost"));
    await failedConfiguration;
    h.run.detach();
  }
});

test("pending and uncertain commands block model changes until their exact receipt settles", async () => {
  const h = harness();
  await h.start();
  const changes: unknown[] = [];
  const configure = h.api.configure;
  h.api.configure = async (id, change) => {
    changes.push({ id, change });
    return await configure(id, change);
  };
  let rejectCommand!: (reason: Error) => void;
  h.api.command = async () =>
    await new Promise((_resolve, reject) => {
      rejectCommand = reject;
    });
  const command = h.run.executeCommand("inspect");
  try {
    await assert.rejects(
      h.run.configure({ reasoning: "high" }),
      /reconstructed/,
    );
    rejectCommand(new Error("Command reply lost"));
    await command;
    await h.start();
    assert.ok(h.run.getSnapshot().uncertainCommand);
    await assert.rejects(
      h.run.configure({ reasoning: "high" }),
      /reconstructed/,
    );
    assert.deepEqual(changes, []);
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
    await h.run.configure({ reasoning: "high" });
    assert.deepEqual(changes, [
      { id: "session", change: { reasoning: "high" } },
    ]);
  } finally {
    rejectCommand(new Error("Command reply lost"));
    await command;
    h.run.detach();
  }
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
