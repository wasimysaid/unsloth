// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import {
  type ExtensionInventory,
  type PluginReloadStatus,
  createMaintenanceInspection,
} from "../src/features/coding/maintenance.ts";

const status = (
  id: string,
  operationId: string,
  phase: PluginReloadStatus["status"],
  changed = 0,
): PluginReloadStatus => ({
  session_id: id,
  operation_id: operationId,
  status: phase,
  changed,
  generation: 1,
  diagnostic_count: 0,
  error: phase === "failed" ? "reconcile-failed" : null,
});
const inventory = (
  id: string,
  reload: PluginReloadStatus | null = null,
): ExtensionInventory => ({
  conversation_id: id,
  inventory: {
    session_id: id,
    frontend: "headless",
    session_live_available: true,
    runtime_live_available: true,
    plugins: [
      {
        id: "disabled.package",
        name: "Disabled package",
        version: "1",
        lifetime: "session",
        installed: true,
        selected: false,
        enabled: false,
        eligible: true,
        live: false,
        selected_frontend: false,
        mounted: false,
        pending: false,
        retained: false,
        load_failed: false,
        runtime_failed: false,
        missing_requirements: [],
        mount_id: null,
      },
    ],
    omitted_plugins: 0,
    diagnostics: { catalog: 0, selection: 0, load: 0, runtime: 0 },
    reload,
  },
  skills: [{ name: "native-skill", bundled: false, source: "native" }],
  omitted_skills: 0,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("inspection preserves disabled/non-live state and deferred reload never fabricates completion", async () => {
  let current = inventory("a");
  const calls: unknown[] = [];
  const view = createMaintenanceInspection({
    inspect(id) {
      calls.push(["inspect", id]);
      return Promise.resolve(current);
    },
    reload(id, operationId) {
      calls.push(["reload", id, operationId]);
      const deferred = status(id, operationId, "deferred");
      current = inventory(id, deferred);
      return Promise.resolve(deferred);
    },
  });
  view.select("a");
  await tick();
  assert.equal(view.getSnapshot().inventory?.inventory.plugins[0].live, false);
  await view.reload("op");
  assert.equal(
    view.getSnapshot().inventory?.inventory.reload?.status,
    "deferred",
  );
  await view.reload("must-not-resubmit");
  current = inventory("a", status("a", "op", "applied", 1));
  await view.refresh();
  assert.equal(
    view.getSnapshot().inventory?.inventory.reload?.status,
    "applied",
  );
  assert.deepEqual(calls, [
    ["inspect", "a"],
    ["reload", "a", "op"],
    ["inspect", "a"],
    ["inspect", "a"],
  ]);
});

test("lost reload response is reconciled by exact retained identity, never automatically retried", async () => {
  let current = inventory("a");
  const calls: unknown[] = [];
  const view = createMaintenanceInspection({
    inspect(id, operationId) {
      calls.push(["inspect", id, operationId]);
      return Promise.resolve(current);
    },
    reload(id, operationId) {
      calls.push(["reload", id, operationId]);
      return Promise.reject(new Error("connection lost"));
    },
  });
  view.select("a");
  await tick();
  await view.reload("lost-op");
  assert.equal(view.getSnapshot().uncertainOperation, "lost-op");
  await view.reload("unsafe-retry");
  // An unrelated/latest operation does not settle the one whose reply was lost.
  current = inventory("a", status("a", "another-op", "applied"));
  await view.refresh();
  assert.equal(view.getSnapshot().uncertainOperation, "lost-op");
  current = inventory("a", status("a", "lost-op", "deferred"));
  await view.refresh();
  assert.equal(view.getSnapshot().uncertainOperation, null);
  assert.equal(
    view.getSnapshot().inventory?.inventory.reload?.status,
    "deferred",
  );
  assert.equal(
    calls.filter((call) => (call as string[])[0] === "reload").length,
    1,
  );
});

test("a failed inventory is stale and disables reload until refreshed; native failure remains failed", async () => {
  let fail = false;
  let reloads = 0;
  let current = inventory("a");
  const view = createMaintenanceInspection({
    inspect() {
      return fail
        ? Promise.reject(new Error("raw credential must not be rendered"))
        : Promise.resolve(current);
    },
    reload(id, operationId) {
      reloads++;
      const failed = status(id, operationId, "failed");
      current = inventory(id, failed);
      return Promise.resolve(failed);
    },
  });
  view.select("a");
  await tick();
  fail = true;
  await view.refresh();
  await view.reload("blocked");
  assert.equal(reloads, 0);
  assert.ok(view.getSnapshot().error);
  assert.ok(!view.getSnapshot().error?.includes("credential"));
  fail = false;
  await view.refresh();
  await view.reload("failure");
  assert.equal(
    view.getSnapshot().inventory?.inventory.reload?.status,
    "failed",
  );
});

test("out-of-order inspection and reload replies cannot retarget another conversation", async () => {
  let resolve!: (value: ExtensionInventory) => void;
  let resolveReload!: (value: PluginReloadStatus) => void;
  const view = createMaintenanceInspection({
    inspect(id) {
      return id === "a"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(inventory(id));
    },
    reload() {
      return new Promise((done) => {
        resolveReload = done;
      });
    },
  });
  view.select("a");
  view.select("b");
  await tick();
  resolve(inventory("a"));
  await tick();
  assert.equal(view.getSnapshot().inventory?.conversation_id, "b");
  const pending = view.reload("b-op");
  view.select("c");
  await tick();
  resolveReload(status("b", "b-op", "applied", 3));
  await pending;
  assert.equal(view.getSnapshot().inventory?.conversation_id, "c");
  assert.equal(view.getSnapshot().inventory?.inventory.reload, null);
});

test("definite native refusal is distinct from uncertain delivery and requires a refreshed view", async () => {
  let calls = 0;
  const view = createMaintenanceInspection({
    inspect(id) {
      return Promise.resolve(inventory(id));
    },
    reload() {
      calls++;
      return Promise.reject(
        new CodingHttpError(409, "private refusal contents"),
      );
    },
  });
  view.select("a");
  await tick();
  await view.reload("refused");
  assert.equal(view.getSnapshot().uncertainOperation, null);
  assert.equal(view.getSnapshot().error, "refusedError");
  await view.reload("unsafe-immediate-retry");
  assert.equal(calls, 1);
  await view.refresh();
  assert.equal(view.getSnapshot().error, null);
});

test("an unopened live owner has a deliberate-reopen explanation, not a trust grant", async () => {
  const view = createMaintenanceInspection({
    inspect() {
      return Promise.reject(new CodingHttpError(404, "raw error"));
    },
    reload() {
      throw new Error("must not reload an unopened owner");
    },
  });
  view.select("foreign-live");
  await tick();
  assert.equal(view.getSnapshot().error, "scopeError");
  assert.equal(view.getSnapshot().inventory, null);
});

test("unconfirmed identity survives A to B to A and view detach/remount", async () => {
  const queries: unknown[] = [];
  let reloads = 0;
  const view = createMaintenanceInspection({
    inspect(id, op) {
      queries.push([id, op]);
      return Promise.resolve(inventory(id));
    },
    reload() {
      reloads++;
      return Promise.reject(new Error("lost reply"));
    },
  });
  const detach = view.subscribe(() => {});
  view.select("a");
  await tick();
  await view.reload("lost-op");
  view.select("b");
  await tick();
  view.select("a");
  await tick();
  assert.equal(view.getSnapshot().uncertainOperation, "lost-op");
  assert.deepEqual(queries.at(-1), ["a", "lost-op"]);
  detach();
  view.select(null);
  const detachAgain = view.subscribe(() => {});
  view.select("a");
  await tick();
  await view.reload("unsafe-new-op");
  assert.deepEqual(queries.at(-1), ["a", "lost-op"]);
  assert.equal(reloads, 1);
  detachAgain();
});

test("detached acknowledgment settles only its original conversation", async () => {
  let acknowledge!: (value: PluginReloadStatus) => void;
  const queries: unknown[] = [];
  const view = createMaintenanceInspection({
    inspect(id, op) {
      queries.push([id, op]);
      return Promise.resolve(inventory(id));
    },
    reload() {
      return new Promise((done) => {
        acknowledge = done;
      });
    },
  });
  view.select("a");
  await tick();
  const pending = view.reload("a-op");
  view.select("b");
  await tick();
  acknowledge(status("a", "a-op", "applied"));
  await pending;
  assert.equal(view.getSnapshot().target, "b");
  assert.equal(view.getSnapshot().inventory?.inventory.reload, null);
  view.select("a");
  await tick();
  assert.deepEqual(queries.at(-1), ["a", undefined]);
  assert.equal(view.getSnapshot().uncertainOperation, null);
});

test("immediate application refreshes actual plugin state and failed refresh marks it stale", async () => {
  let current = inventory("a");
  let fail = false;
  const view = createMaintenanceInspection({
    inspect() {
      return fail
        ? Promise.reject(new Error("read failure"))
        : Promise.resolve(current);
    },
    reload(id, op) {
      const applied = status(id, op, "applied", 1);
      current = inventory(id, applied);
      current.inventory.plugins[0] = {
        ...current.inventory.plugins[0],
        enabled: true,
        selected: true,
        live: true,
      };
      return Promise.resolve(applied);
    },
  });
  view.select("a");
  await tick();
  await view.reload("fresh");
  assert.equal(view.getSnapshot().inventory?.inventory.plugins[0].live, true);
  fail = true;
  await view.reload("read-failed");
  assert.equal(
    view.getSnapshot().inventory?.inventory.reload?.operation_id,
    "read-failed",
  );
  assert.equal(view.getSnapshot().error, "inventoryError");
});

test("wrong native scope is rejected and reconciling remains pending", async () => {
  let current = inventory("a", status("a", "op", "reconciling"));
  let reloads = 0;
  const view = createMaintenanceInspection({
    inspect() {
      return Promise.resolve(current);
    },
    reload(id, operationId) {
      reloads++;
      return Promise.resolve(status(id, operationId, "applied"));
    },
  });
  view.select("a");
  await tick();
  await view.reload("unsafe");
  assert.equal(reloads, 0);
  current = inventory("a", status("b", "other-session", "applied"));
  await view.refresh();
  assert.ok(view.getSnapshot().error);
  assert.equal(
    view.getSnapshot().inventory?.inventory.reload?.status,
    "reconciling",
  );
});
