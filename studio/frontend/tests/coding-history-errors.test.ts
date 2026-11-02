// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type * as Surface from "../src/features/coding/coding-surface.tsx";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import type * as HistoryEdge from "../src/features/coding/history-edge.tsx";
import * as historyScroll from "../src/features/coding/history-scroll.ts";
import { createInputDraft } from "../src/features/coding/input.ts";
import * as runSession from "../src/features/coding/run-session.ts";
import type { NativeState, RunApi } from "../src/features/coding/run-types.ts";
import * as transcriptModel from "../src/features/coding/transcript-model.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";
import {
  type StubElement,
  loadWithStubs,
  stubJsxRuntime,
} from "./helpers/module-stubs.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class HistoryViewport extends EventTarget {
  scrollTop = 0;
  scrollHeight = 2000;
  clientHeight = 500;
  closest() {
    return null;
  }
  home() {
    const event = new Event("keydown");
    Object.assign(event, { key: "Home", ctrlKey: true });
    this.dispatchEvent(event);
  }
}

function nodes(value: unknown): StubElement[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as StubElement;
  return [node, ...nodes(node.props.children)];
}

test("main history ignores unrelated run errors and retains paging recovery after shared errors clear", async (t) => {
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  for (const [name, value] of Object.entries({
    Element: HistoryViewport,
    HTMLElement: HistoryViewport,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  t.after(() => {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const native: NativeState = {
    info: { id: "history", cwd: "/project" },
    configuration: {
      provider: "external",
      model: "model",
      mode: "build",
      reasoning: null,
    },
    active_request: null,
    running_configuration: null,
    requests: [],
    pending_user_request: false,
    plan: null,
    action_disabled_reason: null,
    user_request: null,
  };
  let deliver!: (event: unknown) => Promise<void>;
  let reads = 0;
  let page = 0;
  let failPaging = false;
  let failConfiguration = true;
  let delayedPage: Promise<void> | null = null;
  const api: RunApi = {
    async watch(_id, _signal, _connected, onView) {
      deliver = onView;
      await new Promise<void>(() => {});
    },
    async readEntries(_id, cut, anchor) {
      if (anchor !== "latest") {
        reads++;
        const delayed = delayedPage;
        delayedPage = null;
        if (delayed) await delayed;
        if (failPaging) throw new Error("History temporarily unavailable");
        page++;
      }
      const row = {
        id: `page-${page}`,
        entry_id: `page-${page}`,
        kind: "assistant" as const,
        text: `History page ${page}`,
      };
      return {
        cut,
        rows: [row],
        older: true,
        newer: false,
        first_id: row.id,
        last_id: row.id,
      };
    },
    async readPublicEntry() {
      throw new Error("No content references expected");
    },
    async readChild() {
      return { child: null, outcome: null };
    },
    async configure() {
      if (failConfiguration)
        throw new CodingHttpError(400, "Model change rejected");
      return native.configuration;
    },
    async checkOverlap() {
      throw new Error("No overlap preflight expected");
    },
    async submit() {
      throw new Error("No prompt expected");
    },
    async cancel() {
      throw new Error("No Stop expected");
    },
    async answer() {
      throw new Error("No answer expected");
    },
    async setMode() {
      throw new Error("No mode change expected");
    },
    async decidePlan() {
      throw new Error("No plan decision expected");
    },
  };
  const run = runSession.createCodingRun("history", api, () => "key", {
    storage: () => memorySubmissionStorage(),
  });
  run.connect();
  t.after(() => run.detach());
  await deliver({
    subscription: "view",
    position: 1,
    event: {
      type: "start",
      state: native,
      root: {
        cut: { journal: "root", leaf: "captured" },
        live_invocations: [],
      },
    },
  });
  await run.configure({ model: "rejected" }).catch(() => {});
  assert.equal(run.getSnapshot().error, "Model change rejected");

  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const layouts: (() => void | (() => void))[] = [];
  const cleanups: (() => void)[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let mounting = true;
  const edge = loadWithStubs<typeof HistoryEdge>(
    new URL("../src/features/coding/history-edge.tsx", import.meta.url),
    {
      "react/jsx-runtime": stubJsxRuntime(),
      "@/components/ui/button": { Button: "button" },
      "lucide-react": { LoaderCircle: "icon" },
    },
  );
  const surface = loadWithStubs<typeof Surface>(
    new URL("../src/features/coding/coding-surface.tsx", import.meta.url),
    {
      "react/jsx-runtime": stubJsxRuntime(),
      react: {
        useState(initial: unknown) {
          const index = stateIndex++;
          if (index >= states.length)
            states[index] =
              typeof initial === "function"
                ? (initial as () => unknown)()
                : initial;
          return [
            states[index],
            (next: unknown) => {
              states[index] =
                typeof next === "function"
                  ? (next as (prior: unknown) => unknown)(states[index])
                  : next;
            },
          ];
        },
        useRef: (current: unknown) =>
          refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
          snapshot(),
        useLayoutEffect(effect: () => void | (() => void)) {
          if (mounting) layouts.push(effect);
        },
        useEffect() {},
      },
      "@/components/ui/button": { Button: "button" },
      "@assistant-ui/react": {
        AssistantRuntimeProvider: "provider",
        ThreadPrimitive: { Root: "root" },
        useExternalStoreRuntime: () => ({}),
      },
      "lucide-react": { ArrowDown: "icon" },
      "./answer-focus": { watchAnswerFocus() {} },
      "./api": { codingModelApi: {}, createCodingRunApi: () => api },
      "./child-inspector": { ChildInspector: "child-inspector" },
      "./coding-composer": { CodingComposer: "composer" },
      "./composer-footer": {
        CommandFeedback: "command-feedback",
        ComposerFooter: "footer",
      },
      "./goal-summary": { GoalSummary: "goal" },
      "./history-edge": edge,
      "./history-scroll": historyScroll,
      "./model-configuration-popover": { CodingModelPicker: "model-picker" },
      "./plan-card": { PlanCard: "plan" },
      "./project-overlap-dialog": { ProjectOverlapDialog: "overlap" },
      "./question-card": { QuestionCard: "question" },
      "./recovery-controls": { CodingRecoveryControls: "recovery" },
      "./run-runtime": { codingRunAdapter: () => ({}) },
      "./run-session": { ...runSession, createCodingRun: () => run },
      "./subagent-card": { ChildActivityRows: "children" },
      "./tool-report": { DisclosureMemory: "disclosures" },
      "./transcript": {
        AnswerFocus: { Provider: "answer-focus" },
        TranscriptBlocks: "blocks",
        WorkingLine: "working",
      },
      "./transcript-model": transcriptModel,
      "./transcript-reader": {
        createTranscriptReader() {
          throw new Error("No DOM content mounted in this handler test");
        },
      },
      "./unsent-draft": { CodingUnsentDraft: "draft" },
    },
  );
  const render = () => {
    stateIndex = refIndex = 0;
    return surface.CodingSurface({
      conversationId: "history",
      conversationGeneration: 1,
      runtimeStatus: null,
      draft: createInputDraft(),
    });
  };
  const viewport = new HistoryViewport();
  const root = render();
  const transcript = nodes(root).find(
    (node) => node.props["data-testid"] === "coding-transcript",
  )!;
  (transcript.props.ref as { current: unknown }).current = viewport;
  for (const effect of layouts) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  mounting = false;
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
  });
  const home = async () => {
    viewport.home();
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
    await tick();
  };
  const renderedEdge = () =>
    nodes(render()).find((node) => node.type === edge.HistoryEdge);

  await home();
  assert.equal(reads, 1);
  assert.equal(run.getSnapshot().rows[0].text, "History page 1");
  assert.equal(renderedEdge(), undefined);

  failPaging = true;
  await home();
  assert.equal(reads, 2);
  assert.equal(run.getSnapshot().error, "History temporarily unavailable");
  assert.equal(renderedEdge()?.props.error, true);
  assert.equal(run.getSnapshot().rows[0].text, "History page 1");

  failConfiguration = false;
  await run.configure({ model: "accepted" });
  assert.equal(run.getSnapshot().error, null);
  await home();
  await home();
  assert.equal(
    reads,
    2,
    "A swallowed paging error must remain latched after unrelated state clears",
  );
  const retry = renderedEdge()!;
  assert.equal(
    retry.props.error,
    true,
    "Explicit recovery must survive shared-error changes",
  );
  const button = nodes(
    edge.HistoryEdge(retry.props as Parameters<typeof edge.HistoryEdge>[0]),
  ).find((node) => node.type === "button")!;
  assert.deepEqual(button.props.children, ["Retry ", "earlier", " messages"]);
  failPaging = false;
  (button.props.onClick as () => void)();
  await tick();
  assert.equal(reads, 3);
  assert.equal(run.getSnapshot().rows[0].text, "History page 2");
  assert.equal(renderedEdge(), undefined);
  await home();
  assert.equal(reads, 4);
  assert.equal(run.getSnapshot().rows[0].text, "History page 3");

  let releasePage!: () => void;
  delayedPage = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  await home();
  assert.equal(run.getSnapshot().loadingEarlier, true);
  failConfiguration = true;
  await run.configure({ model: "rejected-during-page" }).catch(() => {});
  assert.equal(run.getSnapshot().error, "Model change rejected");
  releasePage();
  await tick();
  assert.equal(run.getSnapshot().rows[0].text, "History page 4");
  assert.equal(run.getSnapshot().error, "Model change rejected");
  assert.equal(
    renderedEdge(),
    undefined,
    "An unrelated concurrent error is not a failed page",
  );
  await home();
  assert.equal(reads, 6);
  assert.equal(run.getSnapshot().rows[0].text, "History page 5");
});
