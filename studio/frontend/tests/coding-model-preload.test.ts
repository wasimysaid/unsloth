// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { createModelPreloader } from "../src/features/coding/local-model-preload.ts";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("preload coalesces A to B to A without cancelling a load a prompt can join", async () => {
  const calls: string[] = [];
  let finish = () => {};
  const loader = createModelPreloader((id) => {
    calls.push(id);
    return new Promise<void>((resolve) => { finish = resolve; });
  }, () => {});
  loader.select("A"); loader.select("B"); loader.select("A");
  assert.deepEqual(calls, ["A"]);
  finish(); await tick();
  assert.deepEqual(calls, ["A"]);
});

test("preload waits for the current load, then submits the latest selection", async () => {
  const calls: string[] = [];
  let finish = () => {};
  const loader = createModelPreloader((id) => {
    calls.push(id);
    return new Promise<void>((resolve) => { finish = resolve; });
  }, () => {});
  loader.select("A"); loader.select("B"); loader.select("C");
  assert.deepEqual(calls, ["A"]);
  finish(); await tick();
  assert.deepEqual(calls, ["A", "C"]);
  loader.close(); finish(); await tick();
});

test("navigation drops only unsent intents and leaves the submitted load alive", async () => {
  const calls: string[] = [];
  const changes: unknown[] = [];
  let finish = () => {};
  const loader = createModelPreloader((id) => {
    calls.push(id);
    return new Promise<void>((resolve) => { finish = resolve; });
  }, (...change) => changes.push(change));
  loader.select("A"); loader.select("B");
  assert.equal(loader.isLoading("B"), true);
  const beforeClose = [...changes];
  loader.close(); finish(); await tick();
  assert.deepEqual(calls, ["A"]);
  assert.deepEqual(changes, beforeClose);
});

test("unloading a queued selection removes its unsent preload", async () => {
  const calls: string[] = [];
  let finish = () => {};
  const loader = createModelPreloader((id) => {
    calls.push(id);
    return new Promise<void>((resolve) => { finish = resolve; });
  }, () => {});
  loader.select("A"); loader.select("B"); loader.removePending("B");
  assert.equal(loader.isLoading("B"), false);
  finish(); await tick();
  assert.deepEqual(calls, ["A"]);
});

test("successful explicit unload dismisses only that load's later cancellation response", async () => {
  let reject = (_error: Error) => {};
  const changes: unknown[] = [];
  const loader = createModelPreloader(() => new Promise<void>((_resolve, fail) => { reject = fail; }), (...change) => changes.push(change));
  loader.select("A");
  const attempt = loader.active();
  assert.ok(attempt);
  loader.dismissCompletion(attempt.requestId);
  const before = [...changes];
  reject(new Error("Load cancelled by explicit unload")); await tick();
  assert.deepEqual(changes, before);
  assert.equal(loader.active(), null);
});

test("selecting an explicitly unloaded model starts a fresh preload after the dismissed response", async () => {
  const calls: string[] = [];
  let finish = () => {};
  const loader = createModelPreloader((id) => {
    calls.push(id);
    return new Promise<void>((resolve) => { finish = resolve; });
  }, () => {});
  loader.select("A");
  const attempt = loader.active(); assert.ok(attempt);
  loader.dismissCompletion(attempt.requestId); loader.select("A");
  finish(); await tick();
  assert.deepEqual(calls, ["A", "A"]);
  loader.close(); finish(); await tick();
});

test("same-model settings and reload intents are not lost behind an existing preload", async () => {
  const calls: { id: string; options: unknown }[] = [];
  const finish: (() => void)[] = [];
  const loader = createModelPreloader((id, _requestId, options) => {
    calls.push({ id, options });
    return new Promise<void>((resolve) => finish.push(resolve));
  }, () => {});
  loader.select("A");
  loader.select("A", { forceReload: true });
  assert.equal(calls.length, 1);
  finish[0](); await tick();
  assert.deepEqual(calls, [{ id: "A", options: {} }, { id: "A", options: { forceReload: true } }]);
  finish[1](); await tick();
  assert.equal(loader.isLoading("A"), false);
});

test("a rejected reload reports the failure and drains the newer intent", async () => {
  const calls: string[] = [];
  const failures: unknown[] = [];
  let reject = (_reason: Error) => {};
  const loader = createModelPreloader((id) => {
    calls.push(id);
    return calls.length === 1 ? new Promise<void>((_resolve, fail) => { reject = fail; }) : Promise.resolve();
  }, (_id, error) => { if (error) failures.push(error); });
  loader.select("A", { forceReload: true }); loader.select("B");
  const busy = new Error("An active request protects this model.");
  reject(busy); await tick();
  assert.deepEqual(calls, ["A", "B"]);
  assert.deepEqual(failures, [busy]);
  assert.equal(loader.isLoading("B"), false);
});
