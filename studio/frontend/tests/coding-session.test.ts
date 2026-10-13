// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
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
  await session.createConversation("/host/link");
  assert.deepEqual(session.getSnapshot().active, {
    id: "native-1",
    cwd: "/canonical/project",
  });
  await session.createConversation("/host/link");
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
  assert.deepEqual(opened, []);
  await session.openConversation("saved-native");
  assert.deepEqual(opened, ["saved-native"]);
  assert.equal(session.getSnapshot().active?.cwd, "/native/revalidated");
});

test("successful same-ID reopening advances the view incarnation, but failed reopening preserves it", async () => {
  let fail = false;
  const session = createCodingSession(nativeApi({
    openConversation: async (id) => {
      if (fail) throw new Error("Cannot reopen");
      return { id, cwd: "/saved" };
    },
  }));
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
  const opening = session.createConversation("/a");
  assert.equal(session.getSnapshot().opening, true);
  assert.equal(session.getSnapshot().active, null);
  assert.equal(await session.createConversation("/b"), false);
  assert.equal(await session.openConversation("saved"), false);
  assert.equal(calls, 1);
  pending.resolve({ id: "native", cwd: "/a" });
  assert.equal(await opening, true);
  assert.equal(session.getSnapshot().opening, false);
});

test("native validation/open failures preserve the open conversation and expose a retryable error", async () => {
  let fail = false;
  const session = createCodingSession(
    nativeApi({
      createConversation: async () => {
        if (fail) throw new Error("Project folder is not a directory");
        return { id: "native", cwd: "/good" };
      },
      openConversation: async () => {
        throw new Error("Saved project was removed");
      },
    }),
  );
  await session.createConversation("/good");
  fail = true;
  assert.equal(await session.createConversation("/file"), false);
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
