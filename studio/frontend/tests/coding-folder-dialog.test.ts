// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectFolderBrowser,
  displayedDirectory,
} from "../src/features/coding/project-folder-browser.ts";
import type { CodingProjectDirectory } from "../src/features/coding/types.ts";

const directory = (path: string, filter = ""): CodingProjectDirectory => ({
  path,
  parent: "/",
  entries: [],
  truncated: false,
  filter,
  is_git: false,
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("late replies and errors cannot replace a newer typed path", async () => {
  const old = deferred<CodingProjectDirectory>();
  const current = deferred<CodingProjectDirectory>();
  const signals: AbortSignal[] = [];
  const browser = createProjectFolderBrowser((path, signal) => {
    signals.push(signal);
    return path === "/old" ? old.promise : current.promise;
  });
  browser.browse("/old");
  browser.browse("/new");
  assert.equal(signals[0].aborted, true);
  current.resolve(directory("/canonical/new"));
  await settle();
  old.reject(new Error("old request failed"));
  await settle();
  assert.deepEqual(browser.getSnapshot(), {
    status: "ready",
    query: "/new",
    hidden: false,
    directory: directory("/canonical/new"),
  });
  browser.close();
});

test("editing immediately invalidates selection but retains the previous listing while loading", async () => {
  const browser = createProjectFolderBrowser(async (path) => directory(path));
  browser.browse("/first");
  await settle();
  browser.browse("/second", { debounce: true });
  assert.equal(browser.getSnapshot().status, "loading");
  assert.equal(displayedDirectory(browser.getSnapshot())?.path, "/first");
  browser.close();
});

test("rapid typing sends only the final query and closing cancels a scheduled lookup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: string[] = [];
  const browser = createProjectFolderBrowser(async (path) => {
    requests.push(path);
    return directory("/parent", "partial");
  });
  browser.browse("/pa", { debounce: true });
  browser.browse("/parent/par", { debounce: true });
  t.mock.timers.tick(120);
  await settle();
  assert.deepEqual(requests, ["/parent/par"]);
  assert.equal(browser.getSnapshot().query, "/parent/par");
  assert.equal(displayedDirectory(browser.getSnapshot())?.filter, "partial");
  browser.browse("/never", { debounce: true });
  browser.close();
  t.mock.timers.tick(120);
  await settle();
  assert.deepEqual(requests, ["/parent/par"]);
  assert.equal(browser.getSnapshot().status, "idle");
});

test("closing aborts active reads and ignores a late successful reply", async () => {
  const read = deferred<CodingProjectDirectory>();
  let signal: AbortSignal | undefined;
  const browser = createProjectFolderBrowser((_path, current) => {
    signal = current;
    return read.promise;
  });
  browser.browse("/host");
  browser.close();
  assert.equal(signal?.aborted, true);
  read.resolve(directory("/late"));
  await settle();
  assert.equal(browser.getSnapshot().status, "idle");
});

test("hidden-folder preferences follow subsequent navigation and errors allow retry", async () => {
  const requests: boolean[] = [];
  const browser = createProjectFolderBrowser(async (_path, _signal, hidden) => {
    requests.push(Boolean(hidden));
    if (requests.length === 1) throw new Error("Permission denied");
    return directory("/home");
  });
  browser.browse("/denied", { hidden: true });
  await settle();
  assert.equal(browser.getSnapshot().status, "error");
  browser.browse("~");
  await settle();
  assert.deepEqual(requests, [true, true]);
  assert.equal(browser.getSnapshot().status, "ready");
  browser.close();
});
