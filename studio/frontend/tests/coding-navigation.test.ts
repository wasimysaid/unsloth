// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  codingStopTarget,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type { EntryPage, RunApi } from "../src/features/coding/run-types.ts";
import type { DraftImage } from "../src/features/coding/input.ts";
import { createCodingSession } from "../src/features/coding/session.ts";
import type {
  CodingApi,
  CodingConversation,
} from "../src/features/coding/types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

/** Choose a folder, then Send from the landing: the only way to create. */
function create(
  session: ReturnType<typeof createCodingSession>,
  cwd: string,
) {
  session.selectProject(cwd);
  return session.startConversation();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function sessionApi(open: CodingApi["openConversation"]): CodingApi {
  return {
    listConversations: async () => [],
    createConversation: async () => ({ id: "created", cwd: "/canonical" }),
    openConversation: open,
    browseProjects: async () => ({
      path: "/",
      parent: null,
      entries: [],
      truncated: false,
    }),
  };
}

test("a newer open supersedes a pending one; its late reply never replaces the newer conversation", async () => {
  const slow = deferred<CodingConversation>();
  const signals: AbortSignal[] = [];
  const session = createCodingSession(
    sessionApi(async (id, signal) => {
      if (signal) signals.push(signal);
      return id === "stuck" ? slow.promise : { id, cwd: "/saved" };
    }),
  );
  const first = session.openConversation("stuck");
  assert.deepEqual(session.getSnapshot().pending, {
    operation: "open",
    id: "stuck",
  });
  assert.equal(await session.openConversation("other"), true);
  assert.equal(session.getSnapshot().active?.id, "other");
  assert.equal(signals[0]?.aborted, true, "the stale open request is aborted");
  slow.resolve({ id: "stuck", cwd: "/saved" });
  assert.equal(await first, false);
  assert.equal(session.getSnapshot().active?.id, "other");
  assert.equal(session.getSnapshot().pending, null);
  assert.equal(session.getSnapshot().openingError, null);
});

test("New coding conversation returns to a blank landing at once and abandons a pending open", async () => {
  const slow = deferred<CodingConversation>();
  const session = createCodingSession(
    sessionApi(async (id) =>
      id === "stuck" ? slow.promise : { id, cwd: "/saved" },
    ),
  );
  await session.openConversation("current");
  const generation = session.getSnapshot().openingGeneration;
  const pending = session.openConversation("stuck");
  session.startNew();
  const landing = session.getSnapshot();
  assert.equal(landing.active, null);
  assert.equal(landing.pending, null);
  assert.ok(landing.openingGeneration > generation, "a fresh landing surface");
  slow.resolve({ id: "stuck", cwd: "/saved" });
  assert.equal(await pending, false);
  assert.equal(session.getSnapshot().active, null);
});

test("New during a pending create neither orphans nor doubles it", async () => {
  const slow = deferred<CodingConversation>();
  let creates = 0;
  const session = createCodingSession({
    ...sessionApi(async (id) => ({ id, cwd: "/saved" })),
    createConversation: () => {
      creates++;
      return slow.promise;
    },
  });
  await session.openConversation("current");
  const creating = create(session, "/project");
  const accepted = session.startNew();
  assert.deepEqual(
    session.getSnapshot().pending,
    { operation: "create", id: null },
    "the native create gate stays closed",
  );
  assert.equal(session.getSnapshot().active?.id, "current");
  assert.equal(accepted, false, "a pending create cannot be withdrawn");
  assert.equal(await create(session, "/project"), false);
  assert.equal(await session.openConversation("other"), false);
  assert.equal(creates, 1, "never a second native create");
  slow.resolve({ id: "created", cwd: "/project" });
  assert.equal(await creating, true);
  assert.equal(
    session.getSnapshot().active?.id,
    "created",
    "the created conversation is opened, not orphaned",
  );
  assert.equal(session.startNew(), true);
  assert.equal(session.getSnapshot().active, null);
});

test("New keeps an uncertain create's reconciliation; the landing cannot create another copy", async () => {
  let creates = 0;
  const session = createCodingSession({
    ...sessionApi(async (id) => ({ id, cwd: "/saved" })),
    createConversation: () => {
      creates++;
      return Promise.reject(new Error("Lost reply"));
    },
  });
  assert.equal(await create(session, "/project"), false);
  assert.equal(session.startNew(), true);
  assert.deepEqual(session.getSnapshot().openingUncertainty, {
    operation: "create",
    id: null,
    inspected: true,
  });
  assert.equal(await create(session, "/project"), false);
  assert.equal(creates, 1);
  assert.equal(await session.openConversation("saved"), true);
  assert.equal(session.getSnapshot().openingUncertainty, null);
});

const pixel: DraftImage = {
  id: "pixel",
  filename: "pixel.png",
  mime_type: "image/png",
  data: "iVBORw0KGgo=",
  bytes: 8,
};

test("a create from the landing takes over its complete current draft, including edits and images added while pending", async () => {
  const slow = deferred<CodingConversation>();
  const session = createCodingSession({
    ...sessionApi(async (id) => ({ id, cwd: "/saved" })),
    createConversation: () => slow.promise,
  });
  const landing = session.getSnapshot().draft;
  landing.syncText("A first idea");
  const creating = create(session, "/project");
  // The landing stays editable while the create is pending.
  landing.syncText("B newer idea");
  landing.addImages([pixel]);
  slow.resolve({ id: "created", cwd: "/project" });
  assert.equal(await creating, true);
  const created = session.getSnapshot();
  assert.equal(created.active?.id, "created");
  assert.equal(created.draft, landing, "the same draft object, not a copy");
  assert.equal(created.draft.getSnapshot().text, "B newer idea");
  assert.deepEqual(
    created.draft.getSnapshot().images.map((image) => image.filename),
    ["pixel.png"],
  );
});

test("opening another conversation, New, or a create from an open conversation never inherits a draft", async () => {
  const session = createCodingSession(
    sessionApi(async (id) => ({ id, cwd: "/saved" })),
  );
  const landing = session.getSnapshot().draft;
  landing.syncText("for the landing only");
  landing.addImages([pixel]);
  assert.equal(await session.openConversation("saved"), true);
  const opened = session.getSnapshot().draft;
  assert.notEqual(opened, landing);
  assert.deepEqual(opened.getSnapshot(), {
    text: "",
    mentions: [],
    images: [],
    reading: [],
    attachmentErrors: [],
  });
  opened.syncText("typed in saved");
  assert.equal(await create(session, "/elsewhere"), true);
  const other = session.getSnapshot().draft;
  assert.notEqual(
    other,
    opened,
    "only the landing's draft moves with a create",
  );
  assert.equal(other.getSnapshot().text, "");
  other.syncText("typed in created");
  assert.equal(session.startNew(), true);
  assert.notEqual(session.getSnapshot().draft, other);
  assert.equal(session.getSnapshot().draft.getSnapshot().text, "");
});

test("an uncertain create keeps the landing's draft on the landing", async () => {
  const session = createCodingSession({
    ...sessionApi(async (id) => ({ id, cwd: "/saved" })),
    createConversation: () => Promise.reject(new Error("Lost reply")),
  });
  const landing = session.getSnapshot().draft;
  landing.syncText("keep me");
  landing.addImages([pixel]);
  assert.equal(await create(session, "/project"), false);
  assert.equal(session.getSnapshot().active, null);
  assert.equal(session.getSnapshot().draft, landing);
  assert.equal(landing.getSnapshot().images.length, 1);
});

function runHarness(entries: () => Promise<EntryPage>) {
  const cancelled: string[] = [];
  const signals: AbortSignal[] = [];
  let deliver!: (value: unknown) => Promise<void>;
  let position = 0;
  let watches = 0;
  const api: RunApi = {
    async setMode(id, mode) {
      return { conversation_id: id, mode };
    },
    async decidePlan() {
      throw new Error("unused");
    },
    async answer() {
      throw new Error("unused");
    },
    async configure() {
      throw new Error("unused");
    },
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      throw new Error("unused");
    },
    async submit() {
      throw new Error("unused");
    },
    async cancel(id, request) {
      cancelled.push(request);
      return {
        conversation_id: id,
        request_id: request,
        cancel_requested: true,
      };
    },
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
    },
    async readEntries(_id, _cut, _anchor, signal) {
      if (signal) signals.push(signal);
      return entries();
    },
    async watch(_id, signal, _connected, onView) {
      watches++;
      deliver = onView;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  const run = createCodingRun("conversation", api, () => "key", {
    storage: () => memorySubmissionStorage(),
  });
  run.connect();
  const start = () =>
    deliver({
      subscription: `view-${watches}`,
      position: ++position,
      event: {
        type: "start",
        root: { cut: { journal: "root", leaf: "leaf" }, live_invocations: [] },
        state: {
          info: { id: "conversation", cwd: "/project" },
          configuration: {
            provider: "p",
            model: "m",
            reasoning: null,
            mode: "build",
          },
          active_request: "R",
          requests: [{ id: "R", status: "running", submission_key: "k" }],
          pending_user_request: false,
        },
      },
    });
  return { run, cancelled, signals, start };
}
const page = (): EntryPage => ({
  cut: { journal: "root", leaf: "leaf" },
  rows: [],
  older: false,
  newer: false,
  first_id: null,
  last_id: null,
});

test("Stop targets the request named by the current view while its history is still read", async () => {
  const hanging = deferred<EntryPage>();
  const h = runHarness(() => hanging.promise);
  void h.start();
  await settle();
  const state = h.run.getSnapshot();
  assert.equal(state.connection, "loading");
  assert.equal(codingStopTarget(state), "R");
  await h.run.stop();
  assert.deepEqual(h.cancelled, ["R"]);
  assert.equal(h.run.getSnapshot().stopping, "R");
  h.run.detach();
  assert.equal(
    h.signals[0]?.aborted,
    true,
    "leaving aborts the stale history read",
  );
});

test("Stop during delayed reconnect history keeps its exact target after capture completes", async () => {
  let history = Promise.resolve(page());
  const h = runHarness(() => history);
  await h.start();
  const pending = deferred<EntryPage>();
  history = pending.promise;
  h.run.connect();
  const capture = h.start();
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.equal(codingStopTarget(h.run.getSnapshot()), "R");
  await h.run.stop();
  assert.deepEqual(h.cancelled, ["R"]);
  pending.resolve(page());
  await capture;
  assert.equal(h.run.getSnapshot().connection, "connected");
  assert.equal(h.run.getSnapshot().stopping, "R");
  assert.equal(codingStopTarget(h.run.getSnapshot()), null);
  h.run.detach();
});

test("a fresh view keeps Stop on the exact request this owner last named; native judges it", async () => {
  const h = runHarness(async () => page());
  await h.start();
  assert.equal(codingStopTarget(h.run.getSnapshot()), "R");
  h.run.connect(); // A fresh subscription is not a new owner or another request.
  assert.equal(h.run.getSnapshot().connection, "loading");
  assert.equal(codingStopTarget(h.run.getSnapshot()), "R");
  await h.run.stop();
  assert.deepEqual(h.cancelled, ["R"], "exactly the known request, once");
  assert.equal(codingStopTarget(h.run.getSnapshot()), null, "Stopping…");
  h.run.detach();
});
