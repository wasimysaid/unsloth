// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import { createMcpSettings } from "../src/features/coding/mcp-settings.ts";
import type {
  McpInventory,
  McpOperation,
  McpSettingsApi,
} from "../src/features/coding/mcp-types.ts";

const inventory: McpInventory = {
  saved_revision: "desired-r2",
  applied_revision: "applied-r1",
  configured_tools: 1,
  documents: [],
  entries: [],
  effective: [],
  diagnostics: [],
  live_available: true,
  live: [
    {
      name: "configured",
      ownership: "configured",
      status: { connected: true, tools: 1, error: null },
      pending_apply: true,
      diagnostics: [],
    },
  ],
};
const result = (
  kind: McpOperation["kind"] = "apply",
  status: McpOperation["status"] = "completed",
  id = "op-1",
  session = "one",
): McpOperation => ({
  operation_id: id,
  session_id: session,
  kind,
  name: null,
  status,
  error:
    status === "failed"
      ? "Native MCP connection failed; saved configuration retained"
      : null,
  saved_revision: "desired-r2",
  applied_revision: "desired-r2",
  configured_tools: 2,
  live_available: true,
});
function fixture(overrides: Partial<McpSettingsApi> = {}) {
  const sent: Array<[string, string, string]> = [];
  const reads: Array<[string, string]> = [];
  const api: McpSettingsApi = {
    inventory: async () => inventory,
    edit: async () => ({
      edit_id: "editor",
      source: "native",
      name: "configured",
      revision: "edit-r1",
      json: "saved definition",
    }),
    save: async (_id, draft, json) => ({
      draft: { ...draft, json, revision: "edit-r2" },
      configured_state: "enabled",
      inventory,
      inventory_error: null,
    }),
    release: async () => {},
    apply: async (id, operationId) => {
      sent.push([id, "apply", operationId]);
      return result("apply", "completed", operationId, id);
    },
    reconnect: async (id, operationId) => {
      sent.push([id, "reconnect", operationId]);
      return result("reconnect", "completed", operationId, id);
    },
    inspectOperation: async (id, operationId) => {
      reads.push([id, operationId]);
      return {
        operation: result("apply", "completed", operationId, id),
        inventory,
      };
    },
    ...overrides,
  };
  return { settings: createMcpSettings(api), sent, reads };
}

for (const kind of ["apply", "reconnect"] as const) {
  test(`${kind} is distinct from save and preserves unsaved text/editor revision`, async () => {
    const { settings, sent } = fixture();
    await settings.begin("one", "native", "configured");
    settings.change("one", "unsaved private draft\n");
    await settings[kind]("one", "op-1");
    const state = settings.getSnapshot("one");
    assert.deepEqual(sent, [["one", kind, "op-1"]]);
    assert.equal(state.text, "unsaved private draft\n");
    assert.equal(state.draft?.revision, "edit-r1");
    assert.equal(state.savedRevision, null);
    assert.equal(state.runtimeOperation?.status, "completed");
    // Runtime evidence comes from native reads, never inferred from accepted POST.
    assert.equal(state.inventory?.applied_revision, "applied-r1");
    assert.equal(state.pendingMcp, null);
  });

  for (const status of [400, 403, 409, 422]) {
    test(`${kind} native ${status} refusal retains saved state and draft without cancellation/retry`, async () => {
      let attempts = 0;
      const { settings } = fixture({
        [kind]: async () => {
          attempts++;
          throw new CodingHttpError(
            status,
            "Native queued/tool/child/MCP work is active; wait until idle",
          );
        },
      });
      await settings.begin("one", "native", "configured");
      await settings.save("one");
      settings.change("one", "retain draft");
      await settings[kind]("one", "op-1");
      const state = settings.getSnapshot("one");
      assert.equal(state.text, "retain draft");
      assert.equal(state.draft?.revision, "edit-r2");
      assert.equal(state.savedRevision, "edit-r2");
      assert.match(state.runtimeError ?? "", /work is active/);
      assert.equal(state.pendingMcp, null);
      assert.equal(state.runtimeOperation, null);
      assert.equal(attempts, 1);
    });
  }

  test(`${kind} lost response is reconciled by exact native identity before any retry`, async () => {
    let posts = 0;
    const inspected: string[] = [];
    const { settings } = fixture({
      [kind]: async () => {
        posts++;
        throw new CodingHttpError(504, "Native result unconfirmed");
      },
      inspectOperation: async (_id, operationId) => {
        inspected.push(operationId);
        return { operation: result(kind), inventory };
      },
    });
    await settings[kind]("one", "op-1");
    assert.equal(posts, 1);
    assert.deepEqual(inspected, ["op-1"]);
    assert.equal(
      settings.getSnapshot("one").runtimeOperation?.status,
      "completed",
    );
    assert.equal(settings.getSnapshot("one").pendingMcp, null);
    assert.equal(settings.getSnapshot("one").runtimeError, null);
  });

  test(`${kind} native failure remains failed with actual applied evidence and draft intact`, async () => {
    const { settings } = fixture({
      [kind]: async () => result(kind, "failed"),
    });
    await settings.begin("one", "native", "configured");
    settings.change("one", "retain error draft");
    await settings[kind]("one", "op-1");
    assert.equal(
      settings.getSnapshot("one").runtimeOperation?.status,
      "failed",
    );
    assert.match(
      settings.getSnapshot("one").runtimeError ?? "",
      /connection failed/,
    );
    assert.equal(settings.getSnapshot("one").text, "retain error draft");
    assert.equal(settings.getSnapshot("one").inventory, inventory);
    assert.equal(settings.getSnapshot("one").pendingMcp, null);
  });
}

test("unknown operation stays blocked across refresh, draft discard/save and target navigation, without replay", async () => {
  let posts = 0;
  let reads = 0;
  const { settings } = fixture({
    apply: async () => {
      posts++;
      throw new Error("Network disconnected after delivery");
    },
    inspectOperation: async () => {
      reads++;
      return { operation: null, inventory };
    },
  });
  await settings.begin("one", "native", "configured");
  settings.change("one", "unsaved");
  await settings.apply("one", "op-1");
  await settings.refresh("one");
  await settings.begin("two", "native", "configured");
  await settings.apply("one", "op-2");
  await settings.reconnect("one", "op-3");
  assert.equal(settings.getSnapshot("one").text, "unsaved");
  await settings.save("one");
  await settings.discard("one");
  await settings.reconnect("one", "op-4");
  assert.equal(settings.getSnapshot("one").pendingMcp?.id, "op-1");
  assert.match(settings.getSnapshot("one").runtimeError ?? "", /unconfirmed/);
  assert.equal(posts, 1);
  assert.equal(reads, 2);
});

test("running acknowledgment cannot be presented as completion; later exact inspection settles it", async () => {
  let settle = false;
  const { settings } = fixture({
    apply: async () => result("apply", "running"),
    inspectOperation: async () => ({
      operation: result("apply", settle ? "completed" : "running"),
      inventory,
    }),
  });
  await settings.apply("one", "op-1");
  assert.equal(settings.getSnapshot("one").runtimeOperation?.status, "running");
  await settings.reconnect("one", "op-2");
  await settings.inspectOperation("one");
  assert.equal(settings.getSnapshot("one").pendingMcp?.id, "op-1");
  settle = true;
  await settings.inspectOperation("one");
  assert.equal(
    settings.getSnapshot("one").runtimeOperation?.status,
    "completed",
  );
  assert.equal(settings.getSnapshot("one").pendingMcp, null);
});

for (const changed of [
  { operation_id: "different" },
  { session_id: "two" },
  { kind: "reconnect" as const },
  { name: "wrong-target" },
]) {
  test(`mismatched native identity ${JSON.stringify(changed)} cannot settle pending action`, async () => {
    const { settings } = fixture({
      apply: async () => ({ ...result(), ...changed }),
      inspectOperation: async () => ({
        operation: { ...result(), ...changed },
        inventory,
      }),
    });
    await settings.apply("one", "op-1");
    assert.equal(settings.getSnapshot("one").pendingMcp?.id, "op-1");
    assert.equal(settings.getSnapshot("one").runtimeOperation, null);
    assert.match(settings.getSnapshot("one").runtimeError ?? "", /unconfirmed/);
  });
}

test("late runtime response settles only its original conversation and never overwrites drafts", async () => {
  let resolve!: (value: McpOperation) => void;
  const { settings } = fixture({
    apply: async () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  await settings.begin("one", "native", "configured");
  settings.change("one", "first");
  const pending = settings.apply("one", "op-1");
  await settings.begin("two", "native", "configured");
  settings.change("two", "second");
  resolve(result());
  await pending;
  assert.equal(settings.getSnapshot("one").text, "first");
  assert.equal(settings.getSnapshot("two").text, "second");
  assert.equal(settings.getSnapshot("two").runtimeOperation, null);
});

test("failed post-outcome inventory read cannot change confirmed operation into failure", async () => {
  const { settings } = fixture({
    inventory: async () => {
      throw new Error("Applied inventory unavailable");
    },
  });
  await settings.apply("one", "op-1");
  assert.equal(
    settings.getSnapshot("one").runtimeOperation?.status,
    "completed",
  );
  assert.equal(settings.getSnapshot("one").pendingMcp, null);
  assert.equal(settings.getSnapshot("one").inventory, null);
  assert.match(settings.getSnapshot("one").inventoryError ?? "", /unavailable/);
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("reload restores only unresolved operation identity, never a draft/secret or runtime replay", async () => {
  const storage = memoryStorage();
  let posts = 0;
  let terminal = false;
  const api: McpSettingsApi = {
    inventory: async () => inventory,
    edit: async () => ({
      edit_id: "edit",
      source: "source",
      name: "configured",
      revision: "edit-r1",
      json: "private draft secret",
    }),
    save: async () => {
      throw new Error("Not used");
    },
    release: async () => {},
    apply: async () => {
      posts++;
      throw new Error("Lost reply");
    },
    reconnect: async () => {
      posts++;
      return result("reconnect");
    },
    inspectOperation: async () => ({
      operation: terminal ? result() : null,
      inventory,
    }),
  };
  const first = createMcpSettings(api, () => storage);
  await first.begin("one", "source", "configured");
  first.change("one", "unsaved private draft secret");
  await first.apply("one", "op-1");
  assert.equal(storage.values.size, 1);
  assert.doesNotMatch(
    [...storage.values.values()].join(""),
    /draft|secret|definition/,
  );
  const reopened = createMcpSettings(api, () => storage);
  assert.equal(reopened.getSnapshot("one").pendingMcp?.id, "op-1");
  assert.equal(reopened.getSnapshot("one").draft, null);
  await reopened.reconnect("one", "op-2");
  assert.equal(posts, 1);
  terminal = true;
  await reopened.refresh("one");
  assert.equal(
    reopened.getSnapshot("one").runtimeOperation?.status,
    "completed",
  );
  assert.equal(storage.values.size, 0);
  assert.equal(posts, 1);
});

test("unavailable or corrupt correlation storage refuses sending instead of losing an uncertain identity", async () => {
  for (const storage of [
    { getItem: () => "malformed", setItem: () => {}, removeItem: () => {} },
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage denied");
      },
      removeItem: () => {},
    },
  ]) {
    let posts = 0;
    const settings = createMcpSettings(
      {
        inventory: async () => inventory,
        edit: async () => {
          throw new Error("Not used");
        },
        save: async () => {
          throw new Error("Not used");
        },
        release: async () => {},
        apply: async () => {
          posts++;
          return result();
        },
        reconnect: async () => {
          posts++;
          return result("reconnect");
        },
        inspectOperation: async () => ({ operation: null, inventory }),
      },
      () => storage,
    );
    await settings.apply("one", "op-1");
    await settings.reconnect("one", "op-2");
    assert.equal(posts, 0);
    assert.equal(settings.getSnapshot("one").recoveryBlocked, true);
    assert.match(settings.getSnapshot("one").runtimeError ?? "", /storage/i);
  }
});

test("post-delivery bridge protocol failure remains uncertain until exact reconciliation", async () => {
  let posts = 0;
  const { settings } = fixture({
    apply: async () => {
      posts++;
      throw new CodingHttpError(502, "Invalid native response envelope");
    },
    inspectOperation: async () => ({ operation: null, inventory }),
  });
  await settings.apply("one", "op-1");
  assert.equal(settings.getSnapshot("one").pendingMcp?.id, "op-1");
  await settings.apply("one", "op-2");
  assert.equal(posts, 1);
});

test("per-tab recovery identity cannot be overwritten or cleared by another tab's busy refusal", async () => {
  const tabA = memoryStorage();
  const tabB = memoryStorage();
  let api!: McpSettingsApi;
  let posts = 0;
  api = {
    inventory: async () => inventory,
    edit: async () => {
      throw new Error("Not used");
    },
    save: async () => {
      throw new Error("Not used");
    },
    release: async () => {},
    apply: async () => {
      posts++;
      throw new Error("Delivered, reply lost");
    },
    reconnect: async () => {
      posts++;
      throw new CodingHttpError(409, "Native operation active");
    },
    inspectOperation: async () => ({ operation: null, inventory }),
  };
  const a = createMcpSettings(api, () => tabA);
  const b = createMcpSettings(api, () => tabB);
  // Both views initialize before either sends, as in the old shared-store race.
  a.getSnapshot("one");
  b.getSnapshot("one");
  await Promise.all([a.apply("one", "op-a"), b.reconnect("one", "op-b")]);
  assert.equal(tabA.values.size, 1);
  assert.equal(tabB.values.size, 0);
  const reloadedA = createMcpSettings(api, () => tabA);
  assert.equal(reloadedA.getSnapshot("one").pendingMcp?.id, "op-a");
  await reloadedA.apply("one", "op-c");
  assert.equal(posts, 2);
});

test("background reconciliation retains save errors and leaves editor admission and typing untouched", async () => {
  let slow = false;
  let resolve!: (value: {
    operation: McpOperation | null;
    inventory: McpInventory;
  }) => void;
  const { settings } = fixture({
    apply: async () => result("apply", "running"),
    save: async () => {
      throw new CodingHttpError(
        409,
        "MCP configuration changed; compare before saving",
      );
    },
    inspectOperation: async () =>
      slow
        ? new Promise((done) => {
            resolve = done;
          })
        : { operation: result("apply", "running"), inventory },
  });
  await settings.begin("one", "native", "configured");
  await settings.apply("one", "op-1");
  settings.change("one", "retained draft");
  await settings.save("one");
  const error = settings.getSnapshot("one").error;
  slow = true;
  const poll = settings.inspectOperation("one");
  assert.equal(settings.getSnapshot("one").operation, null);
  assert.equal(settings.getSnapshot("one").observing, true);
  assert.equal(settings.getSnapshot("one").error, error);
  settings.change("one", "typing during native inspection");
  assert.equal(
    settings.getSnapshot("one").text,
    "typing during native inspection",
  );
  resolve({ operation: result("apply", "running"), inventory });
  await poll;
  assert.equal(settings.getSnapshot("one").error, error);
  assert.equal(settings.getSnapshot("one").observing, false);
  assert.equal(settings.getSnapshot("one").draft?.revision, "edit-r1");
});

test("late background read cannot overwrite a newer operation after explicit refresh settled its predecessor", async () => {
  let reads = 0;
  let resolve!: (value: {
    operation: McpOperation;
    inventory: McpInventory;
  }) => void;
  const { settings } = fixture({
    apply: async (id, op) => result("apply", "running", op, id),
    inspectOperation: async (id, op) =>
      ++reads === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : { operation: result("apply", "completed", op, id), inventory },
  });
  await settings.apply("one", "op-1");
  const earlier = settings.inspectOperation("one");
  await settings.refresh("one");
  await settings.apply("one", "op-2");
  resolve({
    operation: result("apply", "completed", "op-1"),
    inventory: { ...inventory, saved_revision: "older-read" },
  });
  await earlier;
  assert.equal(settings.getSnapshot("one").pendingMcp?.id, "op-2");
  assert.equal(
    settings.getSnapshot("one").runtimeOperation?.operation_id,
    "op-2",
  );
  assert.equal(settings.getSnapshot("one").runtimeOperation?.status, "running");
  assert.equal(
    settings.getSnapshot("one").inventory?.saved_revision,
    inventory.saved_revision,
  );
  assert.equal(settings.getSnapshot("one").recoveryBlocked, false);
});
