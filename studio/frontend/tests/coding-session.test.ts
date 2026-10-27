// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import { createCodingSession } from "../src/features/coding/session.ts";
import type {
  CodingApi,
  CodingConversation,
  CodingProjectDirectory,
} from "../src/features/coding/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Choose a folder, then Send from the landing: the only way to create. */
function create(session: ReturnType<typeof createCodingSession>, cwd: string) {
  session.selectProject(cwd);
  return session.startConversation();
}
function nativeApi(overrides: Partial<CodingApi> = {}): CodingApi {
  return {
    listConversations: async () => [],
    createConversation: async () => ({ id: "native-new", cwd: "/canonical" }),
    openConversation: async (id) => ({ id, cwd: "/saved" }),
    browseProjects: async () => ({
      path: "/host",
      parent: "/",
      entries: [],
      truncated: false,
    }),
    ...overrides,
  };
}

test("every confirmed folder creates a distinct native conversation; only native cwd is displayed", async () => {
  const calls: string[] = [];
  const records: CodingConversation[] = [];
  const session = createCodingSession(
    nativeApi({
      createConversation: async (cwd) => {
        calls.push(cwd);
        const row = { id: `native-${calls.length}`, cwd: "/canonical/project" };
        records.push(row);
        return row;
      },
      listConversations: async () => [...records],
    }),
  );
  await create(session, "/host/link");
  assert.deepEqual(session.getSnapshot().active, {
    id: "native-1",
    cwd: "/canonical/project",
  });
  await create(session, "/host/link");
  assert.deepEqual(calls, ["/host/link", "/host/link"]);
  assert.equal(session.getSnapshot().active?.id, "native-2");
  assert.deepEqual(
    session.getSnapshot().conversations.map((row) => row.id),
    ["native-1", "native-2"],
  );
});

test("history loading does not implicitly reopen; explicit reopening uses the native ID", async () => {
  const opened: string[] = [];
  const session = createCodingSession(
    nativeApi({
      listConversations: async () => [
        { id: "saved-native", cwd: "/host/project" },
      ],
      openConversation: async (id) => {
        opened.push(id);
        return { id, cwd: "/native/revalidated" };
      },
    }),
  );
  await session.refreshConversations();
  assert.equal(session.getSnapshot().active, null);
  assert.equal(session.getSnapshot().reopened, false);
  assert.deepEqual(opened, []);
  await session.openConversation("saved-native");
  assert.deepEqual(opened, ["saved-native"]);
  assert.equal(session.getSnapshot().active?.cwd, "/native/revalidated");
  assert.equal(session.getSnapshot().reopened, true);
  await create(session, "/another-project");
  assert.equal(session.getSnapshot().reopened, false);
});

test("successful same-ID reopening advances the view incarnation, but failed reopening preserves it", async () => {
  let fail = false;
  const session = createCodingSession(
    nativeApi({
      openConversation: async (id) => {
        if (fail) throw new Error("Cannot reopen");
        return { id, cwd: "/saved" };
      },
    }),
  );
  assert.equal(session.getSnapshot().openingGeneration, 0);
  await session.openConversation("same-native-id");
  assert.equal(session.getSnapshot().openingGeneration, 1);
  await session.openConversation("same-native-id");
  assert.equal(session.getSnapshot().openingGeneration, 2);
  fail = true;
  assert.equal(await session.openConversation("same-native-id"), false);
  assert.equal(session.getSnapshot().openingGeneration, 2);
  assert.equal(session.getSnapshot().active?.id, "same-native-id");
});

test("idle cleanup refusal preserves saved identity and actionable error without claiming release", async () => {
  const message =
    "Idle cleanup failed. Resources may still be owned; inspect native diagnostics before retrying.";
  const session = createCodingSession(
    nativeApi({
      openConversation: async () => {
        throw new CodingHttpError(502, message);
      },
    }),
  );
  await create(session, "/canonical");
  assert.equal(await session.openConversation("retained-history"), false);
  assert.equal(session.getSnapshot().active?.id, "native-new");
  assert.equal(
    session.getSnapshot().openingError,
    `${message} The conversation may already exist; check the sidebar before starting another.`,
  );
  assert.equal(session.getSnapshot().openingUncertainty?.operation, "open");
  assert.equal(
    session.getSnapshot().openingUncertainty?.id,
    "retained-history",
  );
  assert.equal(session.getSnapshot().reopened, false);
});

test("loading and concurrent keyboard/click activation issue just one native opening", async () => {
  const pending = deferred<CodingConversation>();
  let calls = 0;
  const session = createCodingSession(
    nativeApi({
      createConversation: () => {
        calls++;
        return pending.promise;
      },
    }),
  );
  const opening = create(session, "/a");
  assert.deepEqual(session.getSnapshot().pending, {
    operation: "create",
    id: null,
  });
  assert.equal(session.getSnapshot().active, null);
  assert.equal(await create(session, "/b"), false);
  assert.equal(await session.openConversation("saved"), false);
  assert.equal(calls, 1);
  pending.resolve({ id: "native", cwd: "/a" });
  assert.equal(await opening, true);
  assert.equal(session.getSnapshot().pending, null);
});

test("native validation/open failures preserve the open conversation and expose a retryable error", async () => {
  let fail = false;
  const session = createCodingSession(
    nativeApi({
      createConversation: async () => {
        if (fail)
          throw new CodingHttpError(422, "Project folder is not a directory");
        return { id: "native", cwd: "/good" };
      },
      openConversation: async () => {
        throw new CodingHttpError(404, "Saved project was removed");
      },
    }),
  );
  await create(session, "/good");
  fail = true;
  assert.equal(await create(session, "/file"), false);
  assert.equal(session.getSnapshot().active?.id, "native");
  assert.equal(
    session.getSnapshot().openingError,
    "Project folder is not a directory",
  );
  assert.equal(await session.openConversation("missing"), false);
  assert.equal(session.getSnapshot().active?.cwd, "/good");
  assert.equal(session.getSnapshot().openingError, "Saved project was removed");
  session.clearOpeningError();
  assert.equal(session.getSnapshot().openingError, null);
});

test("directory navigation clears stale selection and ignores late responses/errors", async () => {
  const first = deferred<CodingProjectDirectory>();
  const second = deferred<CodingProjectDirectory>();
  const signals: AbortSignal[] = [];
  const session = createCodingSession(
    nativeApi({
      browseProjects: (path, signal) => {
        signals.push(signal);
        return path === "/old" ? first.promise : second.promise;
      },
    }),
  );
  const oldRead = session.browse("/old");
  assert.equal(session.getSnapshot().browsing, true);
  const newRead = session.browse("/new");
  assert.equal(signals[0].aborted, true);
  assert.equal(session.getSnapshot().directory, null);
  second.resolve({
    path: "/canonical/new",
    parent: "/canonical",
    entries: [],
    truncated: false,
  });
  await newRead;
  first.reject(new Error("stale denied folder"));
  await oldRead;
  assert.equal(session.getSnapshot().directory?.path, "/canonical/new");
  assert.equal(session.getSnapshot().browseError, null);
});

test("closing the folder picker aborts browsing without creating any conversation", async () => {
  const read = deferred<CodingProjectDirectory>();
  let signal: AbortSignal | undefined;
  let creations = 0;
  const session = createCodingSession(
    nativeApi({
      browseProjects: (_path, current) => {
        signal = current;
        return read.promise;
      },
      createConversation: async () => {
        creations++;
        return { id: "never", cwd: "/never" };
      },
    }),
  );
  const pending = session.browse("/host");
  session.cancelBrowse();
  assert.equal(signal?.aborted, true);
  read.resolve({ path: "/late", parent: null, entries: [], truncated: false });
  await pending;
  assert.equal(session.getSnapshot().directory, null);
  assert.equal(session.getSnapshot().browsing, false);
  assert.equal(creations, 0);
});

test("failed history refresh is visible, can recover, and cannot overwrite a newer read", async () => {
  const oldRead = deferred<CodingConversation[]>();
  let count = 0;
  const session = createCodingSession(
    nativeApi({
      listConversations: async () => {
        count++;
        if (count === 1) throw new Error("Native frontend unavailable");
        if (count === 2) return oldRead.promise;
        return [{ id: "newer", cwd: "/newer" }];
      },
    }),
  );
  await session.refreshConversations();
  assert.equal(
    session.getSnapshot().historyError,
    "Native frontend unavailable",
  );
  const pending = session.refreshConversations();
  await session.refreshConversations();
  oldRead.resolve([{ id: "older", cwd: "/older" }]);
  await pending;
  assert.equal(session.getSnapshot().historyError, null);
  assert.equal(session.getSnapshot().conversations[0].id, "newer");
});

test("lost create acknowledgement inspects shared history before deliberate reopen, never fresh create replay", async () => {
  const catalog = deferred<CodingConversation[]>();
  let creates = 0;
  const opens: string[] = [];
  const session = createCodingSession(
    nativeApi({
      createConversation: async () => {
        creates++;
        throw new Error("Create ACK lost");
      },
      listConversations: () => catalog.promise,
      openConversation: async (id) => {
        opens.push(id);
        return { id, cwd: "/canonical/saved" };
      },
    }),
  );
  const opening = create(session, "/requested");
  await new Promise((resolve) => setImmediate(resolve));
  // No longer pending: the unconfirmed create is held by catalog inspection.
  assert.equal(session.getSnapshot().pending, null);
  assert.equal(session.getSnapshot().openingUncertainty?.inspected, false);
  assert.match(
    session.getSnapshot().openingError ?? "",
    /may already exist/,
  );
  assert.equal(await create(session, "/requested"), false);
  assert.equal(await session.openConversation("native-accepted"), false);
  assert.equal(creates, 1);
  assert.deepEqual(opens, []);
  catalog.resolve([{ id: "native-accepted", cwd: "/canonical/saved" }]);
  assert.equal(
    await opening,
    false,
    "catalog visibility is not an acknowledgement",
  );
  assert.equal(session.getSnapshot().openingUncertainty?.inspected, true);
  assert.equal(
    session.getSnapshot().active,
    null,
    "catalog inspection does not implicitly reopen or infer identity by cwd",
  );
  assert.equal(await create(session, "/requested"), false);
  assert.equal(creates, 1);
  assert.equal(await session.openConversation("native-accepted"), true);
  assert.deepEqual(opens, ["native-accepted"]);
  assert.equal(session.getSnapshot().openingUncertainty, null);
  assert.equal(session.getSnapshot().active?.cwd, "/canonical/saved");
});

test("failed uncertainty inspection blocks mutation until explicit history refresh succeeds", async () => {
  let offline = true;
  let creates = 0;
  let opens = 0;
  const session = createCodingSession(
    nativeApi({
      createConversation: async () => {
        creates++;
        throw new Error("Lost ACK");
      },
      listConversations: async () => {
        if (offline) throw new Error("Catalog offline");
        return [{ id: "accepted", cwd: "/saved" }];
      },
      openConversation: async (id) => {
        opens++;
        return { id, cwd: "/saved" };
      },
    }),
  );
  await create(session, "/project");
  assert.equal(session.getSnapshot().pending, null);
  assert.equal(session.getSnapshot().openingUncertainty?.inspected, false);
  assert.equal(session.getSnapshot().historyError, "Catalog offline");
  assert.equal(await create(session, "/project"), false);
  assert.equal(await session.openConversation("accepted"), false);
  assert.equal(creates, 1);
  assert.equal(opens, 0);
  offline = false;
  await session.refreshConversations();
  assert.equal(session.getSnapshot().openingUncertainty?.inspected, true);
  assert.equal(await session.openConversation("accepted"), true);
  assert.equal(opens, 1);
});

test("lost known-open acknowledgement preserves previous identity and requires inspected deliberate native reopen", async () => {
  let lose = false;
  const opens: string[] = [];
  const session = createCodingSession(
    nativeApi({
      openConversation: async (id) => {
        opens.push(id);
        if (lose) throw new Error("Open ACK lost");
        return { id, cwd: "/native/canonical" };
      },
      listConversations: async () => [{ id: "new", cwd: "/new" }],
    }),
  );
  await session.openConversation("old");
  lose = true;
  await session.openConversation("new");
  assert.deepEqual(opens, ["old", "new"]);
  assert.equal(session.getSnapshot().active?.id, "old");
  assert.equal(session.getSnapshot().openingGeneration, 1);
  assert.deepEqual(session.getSnapshot().openingUncertainty, {
    operation: "open",
    id: "new",
    inspected: true,
  });
  assert.equal(await create(session, "/new"), false);
  lose = false;
  await session.openConversation("new");
  assert.deepEqual(opens, ["old", "new", "new"]);
  assert.equal(session.getSnapshot().openingGeneration, 2);
  assert.equal(session.getSnapshot().active?.cwd, "/native/canonical");
});

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("the new-conversation folder and model are remembered across New and reloads", async () => {
  const stored = memory();
  const created: unknown[][] = [];
  const api = nativeApi({
    createConversation: async (cwd, configuration) => {
      created.push([cwd, configuration]);
      return { id: `native:${cwd}`, cwd: `/canonical${cwd}`, runtime_generation: 1 };
    },
  });
  const first = createCodingSession(api, { memory: stored });
  assert.equal(first.getSnapshot().project, null);
  assert.equal(await first.startConversation(), false, "no folder, no create");
  first.selectProject("/a");
  first.selectModel({ provider: "p", model: "m" });
  first.selectModel({ reasoning: "high" });
  first.getSnapshot().draft.syncText("first message");
  assert.equal(await first.startConversation(), true);
  assert.deepEqual(created, [["/a", { provider: "p", model: "m", reasoning: "high" }]]);
  // The canonical folder of what was created is the next default.
  assert.equal(first.getSnapshot().project, "/canonical/a");
  assert.equal(first.getSnapshot().autoSend, true);
  first.clearAutoSend();
  assert.equal(first.startNew(), true);
  assert.equal(first.getSnapshot().active, null);
  assert.equal(first.getSnapshot().project, "/canonical/a");
  assert.equal(first.getSnapshot().autoSend, false);

  const reloaded = createCodingSession(api, { memory: stored });
  assert.equal(reloaded.getSnapshot().project, "/canonical/a");
  assert.deepEqual(reloaded.getSnapshot().selection, {
    provider: "p",
    model: "m",
    reasoning: "high",
  });
  // Picking another model drops the previous model's effort.
  reloaded.selectModel({ provider: "p", model: "other" });
  assert.deepEqual(reloaded.getSnapshot().selection, { provider: "p", model: "other" });
});

test("New from an open conversation starts in its folder; an empty draft is never auto-sent", async () => {
  const session = createCodingSession(nativeApi(), { memory: memory() });
  await session.openConversation("saved");
  assert.equal(session.startNew(), true);
  assert.equal(session.getSnapshot().project, "/saved");
  assert.equal(await session.startConversation(), true);
  assert.equal(session.getSnapshot().autoSend, false);
});

test("unusable remembered values are ignored", () => {
  const stored = memory();
  stored.setItem("unsloth_coding_project", JSON.stringify(42));
  stored.setItem("unsloth_coding_model", JSON.stringify({ provider: "p" }));
  const session = createCodingSession(nativeApi(), { memory: stored });
  assert.equal(session.getSnapshot().project, null);
  assert.equal(session.getSnapshot().selection, null);
  stored.setItem("unsloth_coding_project", "{not json");
  assert.equal(
    createCodingSession(nativeApi(), { memory: stored }).getSnapshot().project,
    null,
  );
});
