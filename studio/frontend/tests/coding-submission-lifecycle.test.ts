// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type * as Composer from "../src/features/coding/coding-composer.tsx";
import * as codingInput from "../src/features/coding/input.ts";
import {
  type CodingInputDraft,
  type CodingSubagent,
  type DraftImage,
  createInputDraft,
} from "../src/features/coding/input.ts";
import * as mentionMenu from "../src/features/coding/mention-menu.ts";
import * as pendingSubmission from "../src/features/coding/pending-submission.ts";
import * as runSession from "../src/features/coding/run-session.ts";
import {
  type PendingImageStore,
  pendingSubmissionStorageKey,
} from "../src/features/coding/pending-submission.ts";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import {
  type CodingRunState,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type { RunApi } from "../src/features/coding/run-types.ts";
import { createCodingSession } from "../src/features/coding/session.ts";
import type { CodingApi } from "../src/features/coding/types.ts";
import {
  memoryImageStorage,
  memorySubmissionStorage,
} from "./coding-storage-fixture.ts";
import {
  type StubElement,
  loadWithStubs,
  stubJsxRuntime,
} from "./helpers/module-stubs.ts";

const explorer: CodingSubagent = {
  name: "explorer",
  description: "Read-only exploration",
  plan_eligible: true,
};
const image = (id: string): DraftImage => ({
  id,
  filename: `${id}.png`,
  mime_type: "image/png",
  data: btoa(id),
  bytes: id.length,
});
const message = (text: string) => ({
  parentId: null,
  sourceId: null,
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  attachments: [],
  createdAt: new Date(),
  metadata: { custom: {} },
  runConfig: {},
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  // Digests resolve on the threadpool, not in event-loop turns: wait by time.
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(check(), "condition was never reached");
}
const native = (
  requests: { id: string; status: string; submission_key: string }[] = [],
) => ({
  info: { id: "conversation", cwd: "/project" },
  configuration: { provider: "p", model: "m", mode: "build", reasoning: null },
  active_request: null,
  requests,
  pending_user_request: false,
});

async function harness(
  options: { images?: PendingImageStore; keys?: string[] } = {},
) {
  const calls: { key: string; text: string; images?: unknown }[] = [];
  let deliver!: (value: unknown) => Promise<void>;
  let position = 0;
  let subscription = 0;
  let release: ((accepted: boolean) => void) | null = null;
  let hold = false;
  const keys = [...(options.keys ?? ["key-a", "key-b", "key-c"])];
  const api: RunApi = {
    async setMode(id, mode) {
      return { conversation_id: id, mode };
    },
    async decidePlan() {
      throw new Error("No plan decisions here");
    },
    async answer() {
      throw new Error("No answers here");
    },
    async configure() {
      throw new Error("No configuration here");
    },
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      throw new Error("No child reads here");
    },
    async submit(id, key, text, extras) {
      calls.push(structuredClone({ key, text, ...extras }));
      if (hold) {
        const accepted = await new Promise<boolean>((resolve) => {
          release = resolve;
        });
        if (!accepted) throw new Error("Lost response");
      }
      return {
        conversation_id: id,
        submission_key: key,
        request_id: `r-${key}`,
      };
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
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
      };
    },
    async watch(_id, signal, _connected, onView) {
      subscription++;
      deliver = onView;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  const storage = memorySubmissionStorage();
  const run = createCodingRun(
    "conversation",
    api,
    () => keys.shift() ?? "key-z",
    {
      storage: () => storage,
      ...(options.images ? { imageStorage: () => options.images! } : {}),
    },
  );
  const start = (requests: Parameters<typeof native>[0] = []) =>
    deliver({
      subscription: `view-${subscription}`,
      position: ++position,
      event: {
        type: "start",
        recovering: false,
        root: { cut: { journal: "root", leaf: null }, live_invocations: [] },
        state: native(requests),
      },
    });
  run.connect();
  await start();
  return {
    run,
    api,
    calls,
    storage,
    start,
    state: (requests: Parameters<typeof native>[0]) =>
      deliver({
        subscription: `view-${subscription}`,
        position: ++position,
        event: { type: "state", state: native(requests) },
      }),
    holdSubmissions() {
      hold = true;
    },
    release(accepted = true) {
      release?.(accepted);
    },
  };
}
const draftB = (draft: CodingInputDraft) => {
  draft.syncText("");
  draft.syncText("B uses ", { start: 0, end: 0 });
  const next = draft.selectMention(
    { kind: "subagent", subagent: explorer },
    7,
    7,
  );
  draft.addImages([image("image-b")]);
  return next.text;
};

test("a delayed HTTP acceptance of A never clears the newer draft B", async () => {
  const h = await harness({ images: memoryImageStorage() });
  h.holdSubmissions();
  const draft = createInputDraft();
  draft.syncText("A ", { start: 0, end: 0 });
  draft.addImages([image("image-a")]);
  const sending = codingRunAdapter(h.run.getSnapshot(), h.run, draft).onNew?.(
    message("A "),
  );
  await until(() => h.calls.length === 1);
  const textB = draftB(draft);
  h.release(true);
  await sending;
  assert.deepEqual(h.calls[0].images, [
    { mime_type: "image/png", data: btoa("image-a") },
  ]);
  assert.equal(draft.getSnapshot().text, textB);
  assert.deepEqual(
    draft.getSnapshot().images.map((item) => item.id),
    ["image-b"],
    "A's images were consumed by A; B keeps exactly its own",
  );
  assert.deepEqual(draft.input(textB).subagent_mentions, [
    { name: "explorer", start: 7, end: 16 },
  ]);
  h.run.detach();
});

/** The real composer with effects run on every render, as a rerender would. */
function loadComposer(
  runtime: object = { getState: () => ({ text: "" }), setText: () => {} },
) {
  return loadWithStubs<typeof Composer>(
    new URL("../src/features/coding/coding-composer.tsx", import.meta.url),
    {
      "react/jsx-runtime": stubJsxRuntime(),
      "@/components/ui/button": { Button: "button" },
      "@/components/ui/dialog": {
        Dialog: "dialog",
        DialogContent: "dialog-content",
        DialogDescription: "dialog-description",
        DialogTitle: "dialog-title",
      },
      "@/components/ui/dropdown-menu": {
        DropdownMenu: "menu",
        DropdownMenuContent: "menu-content",
        DropdownMenuItem: "menu-item",
        DropdownMenuTrigger: "menu-trigger",
      },
      "@assistant-ui/react": {
        ComposerPrimitive: { Root: "root", Input: "input", Send: "send" },
        useComposerRuntime: () => runtime,
      },
      "@assistant-ui/tap": { flushResourcesSync: (run: () => void) => run() },
      "react-dom": { flushSync: (run: () => void) => run() },
      "lucide-react": {},
      react: {
        useEffect: (effect: () => void) => effect(),
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ],
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
          snapshot(),
      },
      "./api": {
        discoverCodingSkills: async () => ({ skills: [] }),
        discoverCodingSubagents: async () => ({ subagents: [] }),
        discoverCodingFiles: async () => ({ files: [], truncated: false }),
      },
      "./input": codingInput,
      "./mention-list": {
        MentionList: "mention-list",
        mentionOptionId: () => "",
      },
      "./mention-menu": mentionMenu,
      "./pending-submission": pendingSubmission,
      "./run-session": runSession,
    },
  );
}

test("acceptance confirmed by ordered native state never clears the newer draft B", async () => {
  // The composer is the owner of that reaction; run its effects for real.
  const composer = loadComposer();
  const h = await harness({ images: memoryImageStorage() });
  h.holdSubmissions();
  const draft = createInputDraft();
  draft.syncText("A ", { start: 0, end: 0 });
  const sending = codingRunAdapter(h.run.getSnapshot(), h.run, draft).onNew?.(
    message("A "),
  );
  await until(() => h.calls.length === 1);
  const textB = draftB(draft);
  h.release(false); // The HTTP reply is lost: delivery is uncertain.
  await sending;
  await h.state([
    { id: "r-key-a", status: "completed", submission_key: "key-a" },
  ]);
  const accepted: CodingRunState = h.run.getSnapshot();
  assert.equal(accepted.acceptedSubmissionKey, "key-a");
  composer.CodingComposer({
    conversationId: "conversation",
    run: h.run,
    state: accepted,
    draft,
    canEdit: true,
    sendBlocked: null,
    inputRef: { current: null },
  });
  assert.equal(draft.getSnapshot().text, textB);
  assert.deepEqual(
    draft.getSnapshot().images.map((item) => item.id),
    ["image-b"],
  );
  assert.equal(draft.getSnapshot().mentions.length, 1);
  h.run.detach();
});

test("a new composer shows the text of a draft it takes over; rerenders never reset later edits", async () => {
  const typed = "Fix the é bug ";
  const runtime = {
    text: "",
    sets: [] as string[],
    getState() {
      return { text: this.text };
    },
    setText(text: string) {
      this.sets.push(text);
      this.text = text;
    },
  };
  const h = await harness();
  // The landing's draft, as the created conversation receives it.
  const draft = createInputDraft();
  draft.syncText(typed);
  draft.addImages([image("image-a")]);
  const props = {
    conversationId: "conversation",
    run: h.run,
    state: h.run.getSnapshot(),
    draft,
    canEdit: true,
    sendBlocked: null,
    inputRef: { current: null },
  };
  loadComposer(runtime).CodingComposer(props);
  assert.deepEqual(runtime.sets, [typed]);
  // The user keeps typing; the page then rerenders the same conversation.
  runtime.text = `${typed}now`;
  draft.syncText(runtime.text, { start: typed.length, end: typed.length });
  const composer = loadComposer(runtime);
  composer.CodingComposer(props);
  composer.CodingComposer({ ...props, state: h.run.getSnapshot() });
  assert.deepEqual(runtime.sets, [typed], "an edited composer is never reset");
  // Clearing the field entirely is also the user's edit.
  runtime.text = "";
  draft.syncText("");
  composer.CodingComposer(props);
  assert.deepEqual(runtime.sets, [typed]);
  assert.deepEqual(
    draft.getSnapshot().images.map((item) => item.id),
    ["image-a"],
    "the draft's images stay with it",
  );
  h.run.detach();
});

// Real image reads in node: the browser decoder is the only seam, held open
// until released, and object URLs are counted while they are alive.
function browserImages() {
  const live = new Set<string>();
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const holds: (() => void)[] = [];
  let started = 0;
  URL.createObjectURL = (blob: Blob) => {
    const url = create(blob);
    live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    live.delete(url);
    revoke(url);
  };
  (globalThis as { Image?: unknown }).Image = class {
    src = "";
    naturalWidth = 1;
    naturalHeight = 1;
    decode() {
      started++;
      return new Promise<void>((resolve) => holds.push(resolve));
    }
  };
  return {
    live,
    started: () => started,
    release() {
      for (const resolve of holds.splice(0)) resolve();
    },
    restore() {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
      delete (globalThis as { Image?: unknown }).Image;
    },
  };
}
const png = (name: string) =>
  new File(
    [
      Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        ),
        (c) => c.charCodeAt(0),
      ),
    ],
    name,
    { type: "image/png" },
  );
function find(
  node: unknown,
  match: (element: StubElement) => boolean,
): StubElement | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = find(item, match);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as StubElement;
  return match(element) ? element : find(element.props.children, match);
}
const paste = (tree: unknown, file: File) =>
  (
    find(tree, (element) => typeof element.props.onPaste === "function")?.props
      .onPaste as (event: unknown) => void
  )({ clipboardData: { files: [file] }, preventDefault() {} });
const sendButton = (tree: unknown) => {
  const send = find(tree, (element) => element.props["aria-label"] === "Send");
  assert.ok(send, "the Send control is rendered");
  return send;
};
const composerRuntime = () => ({
  text: "",
  getState() {
    return { text: this.text };
  },
  setText(text: string) {
    this.text = text;
  },
});
function sessionApi(
  createConversation: CodingApi["createConversation"],
): CodingApi {
  return {
    listConversations: async () => [],
    createConversation,
    openConversation: async (id) => ({ id, cwd: "/saved" }),
    browseProjects: async () => ({
      path: "/",
      parent: null,
      entries: [],
      truncated: false,
    }),
  };
}
const landingProps = (draft: CodingInputDraft) => ({
  conversationId: null,
  run: null,
  state: null,
  draft,
  canEdit: true,
  sendBlocked: "Choose a project to start.",
  inputRef: { current: null },
  projectChooser: "project-chooser",
});

test("an image still being read on the landing keeps Send blocked in the created conversation until that read settles", async () => {
  const browser = browserImages();
  try {
    let land!: (conversation: { id: string; cwd: string }) => void;
    const session = createCodingSession(
      sessionApi(() => new Promise((resolve) => (land = resolve))),
    );
    const runtime = composerRuntime();
    paste(
      loadComposer(runtime).CodingComposer(
        landingProps(session.getSnapshot().draft),
      ),
      png("late.png"),
    );
    await until(() => browser.started() === 1);
    const creating = session.createConversation("/project");
    land({ id: "conversation", cwd: "/project" });
    assert.equal(await creating, true);
    const h = await harness();
    const props = {
      conversationId: "conversation",
      run: h.run,
      state: h.run.getSnapshot(),
      draft: session.getSnapshot().draft,
      canEdit: true,
      sendBlocked: null,
      inputRef: { current: null },
    };
    // A fresh composer for the created conversation: its gate comes from the draft.
    let send = sendButton(loadComposer(runtime).CodingComposer(props));
    assert.equal(send.props.disabled, true, "Send waits for the read");
    assert.match(String(send.props.title), /finish reading/);
    browser.release();
    await until(() => props.draft.getSnapshot().images.length === 1);
    send = sendButton(loadComposer(runtime).CodingComposer(props));
    assert.equal(send.props.disabled, undefined);
    assert.equal(props.draft.getSnapshot().images[0].filename, "late.png");
    h.run.detach();
  } finally {
    browser.restore();
  }
});

test("leaving a draft while an image is still read keeps no object URL alive and never moves the image", async () => {
  const browser = browserImages();
  try {
    const session = createCodingSession(
      sessionApi(async (cwd) => ({ id: "created", cwd })),
    );
    const abandoned = session.getSnapshot().draft;
    const runtime = composerRuntime();
    const landing = loadComposer(runtime);
    paste(landing.CodingComposer(landingProps(abandoned)), png("read.png"));
    await until(() => browser.started() === 1);
    browser.release();
    await until(() => abandoned.getSnapshot().images.length === 1);
    paste(landing.CodingComposer(landingProps(abandoned)), png("late.png"));
    await until(() => browser.started() === 2);
    assert.equal(await session.openConversation("saved"), true);
    const next = session.getSnapshot().draft;
    browser.release();
    await until(() => abandoned.getSnapshot().images.length === 2);
    assert.deepEqual(next.getSnapshot().images, [], "never another draft's");
    assert.deepEqual([...browser.live], [], "no object URL outlives its use");
  } finally {
    browser.restore();
  }
});

test("a send consumes its rich input at once; rejection keeps that exact input restorable", async () => {
  const h = await harness({ images: memoryImageStorage() });
  h.api.submit = async () => {
    throw Object.assign(new Error("Provider refused images"), {
      admissionRejected: true,
    });
  };
  const draft = createInputDraft();
  draft.syncText("look ", { start: 0, end: 0 });
  const { text } = draft.selectMention(
    { kind: "subagent", subagent: explorer },
    5,
    5,
  );
  draft.addImages([image("image-a")]);
  await codingRunAdapter(h.run.getSnapshot(), h.run, draft).onNew?.(
    message(text),
  );
  assert.deepEqual(draft.getSnapshot().images, []);
  const rejected = h.run.getSnapshot().rejectedSubmission;
  assert.ok(rejected);
  assert.deepEqual(rejected.subagent_mentions, [
    { name: "explorer", start: 5, end: 14 },
  ]);
  assert.equal(rejected.images?.length, 1);
  const restored = createInputDraft();
  restored.restore(rejected);
  assert.deepEqual(restored.input(text), {
    subagent_mentions: rejected.subagent_mentions,
    images: rejected.images,
  });
  h.run.detach();
});

function deferredImages(): PendingImageStore & {
  started: boolean;
  release(): void;
} {
  const inner = memoryImageStorage();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const store = {
    started: false,
    release: () => open(),
    async put(name: string, value: Parameters<PendingImageStore["put"]>[1]) {
      store.started = true;
      await gate;
      await inner.put(name, value);
    },
    get: inner.get,
    delete: inner.delete,
  };
  return store;
}

for (const change of ["detach", "reconnect", "owner loss"] as const) {
  test(`${change} while image bytes are being persisted sends nothing and keeps the input`, async () => {
    const images = deferredImages();
    const h = await harness({ images });
    const extras = {
      subagent_mentions: [{ name: "explorer", start: 0, end: 9 }],
      images: [{ mime_type: "image/png", data: btoa("image-a") }],
    };
    const sending = h.run.send("@explorer look", extras);
    await until(() => images.started);
    if (change === "detach") h.run.detach();
    else if (change === "reconnect") h.run.connect();
    else h.run.requireRuntimeReopen();
    images.release();
    assert.equal(await sending, false);
    await settle();
    assert.deepEqual(h.calls, [], "zero HTTP after the view changed");
    const state = h.run.getSnapshot();
    assert.equal(
      state.uncertainSubmission,
      null,
      "known unsent, not uncertain",
    );
    assert.equal(
      h.storage.getItem(pendingSubmissionStorageKey("conversation")),
      null,
      "no stale delivery record claims an unsent prompt might be accepted",
    );
    assert.equal(state.unsentDraft, "@explorer look");
    assert.deepEqual(state.rejectedSubmission, {
      text: "@explorer look",
      ...extras,
    });
    h.run.detach();
  });
}

test("without durable image storage an image send fails closed and keeps its input; text still sends", async () => {
  // Node has no IndexedDB and no store is injected: production defaults apply.
  assert.equal(typeof indexedDB, "undefined");
  const h = await harness();
  const extras = {
    images: [{ mime_type: "image/png", data: btoa("image-a") }],
  };
  assert.equal(await h.run.send("look at this", extras), false);
  assert.equal(h.calls.length, 0);
  const state = h.run.getSnapshot();
  assert.match(
    state.error ?? "",
    /image storage is unavailable.*nothing was sent/i,
  );
  assert.equal(state.storageError, null, "text prompts are not blocked");
  assert.deepEqual(state.rejectedSubmission, {
    text: "look at this",
    ...extras,
  });
  assert.equal(
    h.storage.getItem(pendingSubmissionStorageKey("conversation")),
    null,
  );
  assert.equal(await h.run.send("text only", {}), true);
  assert.deepEqual(
    h.calls.map((call) => call.text),
    ["text only"],
  );
  h.run.detach();
});
