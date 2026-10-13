// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { createMcpSettings } from "../src/features/coding/mcp-settings.ts";
import type {
  McpDraft,
  McpInventory,
  McpSettingsApi,
} from "../src/features/coding/mcp-types.ts";

const inventory: McpInventory = {
  saved_revision: "native-saved-r1",
  applied_revision: "native-applied-r0",
  configured_tools: 0,
  documents: [],
  entries: [],
  effective: [],
  live: [],
  live_available: true,
  diagnostics: [],
};
const draft = (revision = "native-r1"): McpDraft => ({
  source: "native-source",
  name: "server",
  edit_id: `edit-${revision}`,
  revision,
  json: '{"enabled": false}',
});
function fixture(overrides: Partial<McpSettingsApi> = {}) {
  const writes: { id: string; draft: McpDraft; text: string }[] = [];
  const api: McpSettingsApi = {
    apply: async () => {
      throw new Error("Not used in persistence tests");
    },
    reconnect: async () => {
      throw new Error("Not used in persistence tests");
    },
    inspectOperation: async () => ({ operation: null, inventory }),
    inventory: async () => inventory,
    edit: async () => draft(),
    save: async (id, selected, text) => {
      writes.push({ id, draft: selected, text });
      return {
        draft: { ...draft("native-r2"), json: text },
        inventory,
        configured_state: "disabled",
        inventory_error: null,
      };
    },
    release: async () => {},
    ...overrides,
  };
  return { settings: createMcpSettings(api), writes };
}

test("successful persistence reports the native revision and never fabricates applied state", async () => {
  const { settings, writes } = fixture();
  await settings.begin("conversation", "native-source", "server");
  settings.change("conversation", '{"enabled":false,"timeout":12}');
  await settings.save("conversation");
  assert.equal(writes[0].draft.revision, "native-r1");
  assert.equal(settings.getSnapshot("conversation").savedRevision, "native-r2");
  assert.deepEqual(settings.getSnapshot("conversation").inventory?.live, []);
  settings.change("conversation", "newer draft");
  assert.equal(
    settings.getSnapshot("conversation").draft?.json,
    writes[0].text,
  );
  assert.equal(settings.getSnapshot("conversation").text, "newer draft");
});

for (const error of [
  "MCP configuration changed; refresh before saving",
  "Invalid MCP JSON",
  "Permission denied",
  "Native MCP configuration is busy",
  "Persistence failed",
  "Mimir has not confirmed this operation",
]) {
  test(`draft survives ${error} without a hidden rebase or automatic retry`, async () => {
    let attempts = 0;
    const { settings } = fixture({
      save: async () => {
        attempts++;
        throw new Error(error);
      },
    });
    await settings.begin("one", "native-source", "server");
    settings.change("one", "retain every byte\nsecret-value");
    await settings.save("one");
    assert.equal(
      settings.getSnapshot("one").text,
      "retain every byte\nsecret-value",
    );
    assert.equal(settings.getSnapshot("one").draft?.revision, "native-r1");
    assert.equal(settings.getSnapshot("one").error, error);
    assert.equal(settings.getSnapshot("one").savedRevision, null);
    await settings.refresh("one");
    assert.equal(settings.getSnapshot("one").draft?.revision, "native-r1");
    assert.equal(
      settings.getSnapshot("one").text,
      "retain every byte\nsecret-value",
    );
    assert.equal(attempts, 1);
    await settings.begin("one", "different", "different");
    assert.equal(settings.getSnapshot("one").draft?.name, "server");
  });
}

test("comparison is read-only until deliberately adopting the latest revision", async () => {
  let reads = 0;
  const { settings } = fixture({
    edit: async () => draft(++reads === 1 ? "native-r1" : "native-r3"),
  });
  await settings.begin("one", "native-source", "server");
  settings.change("one", "my draft");
  await settings.compare("one");
  assert.equal(settings.getSnapshot("one").draft?.revision, "native-r1");
  assert.equal(settings.getSnapshot("one").latest?.revision, "native-r3");
  settings.reconcile("one", false);
  assert.equal(settings.getSnapshot("one").draft?.revision, "native-r3");
  assert.equal(settings.getSnapshot("one").text, "my draft");
  await settings.compare("one");
  settings.reconcile("one", true);
  assert.equal(settings.getSnapshot("one").text, draft().json);
});

test("access failure during comparison retains both draft text and its native revision", async () => {
  let reads = 0;
  const { settings } = fixture({
    edit: async () => {
      if (++reads > 1) throw new Error("Permission denied");
      return draft();
    },
  });
  await settings.begin("one", "native-source", "server");
  settings.change("one", "my draft");
  await settings.compare("one");
  assert.equal(settings.getSnapshot("one").text, "my draft");
  assert.equal(settings.getSnapshot("one").draft?.revision, "native-r1");
  assert.equal(settings.getSnapshot("one").latest, null);
});

test("conversation changes cannot retarget an in-flight save or erase another draft", async () => {
  let resolve!: (result: Awaited<ReturnType<McpSettingsApi["save"]>>) => void;
  let attempts = 0;
  const { settings } = fixture({
    save: async () => {
      attempts++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await settings.begin("one", "native-source", "server");
  await settings.begin("two", "native-source", "server");
  settings.change("one", "first draft");
  settings.change("two", "second draft");
  const pending = settings.save("one");
  await settings.save("one");
  settings.discard("one");
  settings.change("one", "not allowed during save");
  assert.equal(settings.getSnapshot("one").text, "first draft");
  resolve({
    draft: { ...draft("confirmed"), json: "first draft" },
    inventory,
    configured_state: "disabled",
    inventory_error: null,
  });
  await pending;
  assert.equal(attempts, 1);
  assert.equal(settings.getSnapshot("two").text, "second draft");
  assert.equal(settings.getSnapshot("two").savedRevision, null);
  assert.equal(settings.getSnapshot("one").savedRevision, "confirmed");
});

test("obsolete native editors are released without releasing the retained draft or conversation", async () => {
  let reads = 0;
  const released: string[] = [];
  const { settings } = fixture({
    edit: async () => draft(`r${++reads}`),
    release: async (id, editId) => {
      released.push(`${id}:${editId}`);
    },
  });
  await settings.begin("one", "native-source", "server");
  await settings.compare("one");
  await settings.compare("one");
  assert.deepEqual(released, ["one:edit-r2"]);
  await settings.reconcile("one", false);
  assert.deepEqual(released, ["one:edit-r2", "one:edit-r1"]);
  assert.equal(settings.getSnapshot("one").draft?.edit_id, "edit-r3");
  await settings.discard("one");
  assert.deepEqual(released, ["one:edit-r2", "one:edit-r1", "one:edit-r3"]);
});

test("editor cleanup failure cannot turn a confirmed save into failed persistence", async () => {
  const { settings } = fixture({
    release: async () => {
      throw new Error("Disconnected");
    },
  });
  await settings.begin("one", "native-source", "server");
  await settings.save("one");
  assert.equal(settings.getSnapshot("one").savedRevision, "native-r2");
  assert.equal(settings.getSnapshot("one").error, null);
});

test("oversized inventory cannot turn committed persistence into a failed save or retain misleading applied metadata", async () => {
  const { settings } = fixture({
    save: async (_id, selected, json) => ({
      draft: { ...selected, json, revision: "committed-r2" },
      configured_state: "enabled",
      inventory: null,
      inventory_error:
        "Native inventory exceeds the response bound; refresh after reducing configuration metadata.",
    }),
  });
  await settings.refresh("one");
  await settings.begin("one", "native-source", "server");
  settings.change("one", '{"enabled":true}');
  await settings.save("one");
  const state = settings.getSnapshot("one");
  assert.equal(state.error, null);
  assert.equal(state.savedRevision, "committed-r2");
  assert.equal(state.savedConfiguredState, "enabled");
  assert.equal(state.inventory, null);
  assert.match(state.inventoryError ?? "", /exceeds the response bound/);
  await settings.refresh("one");
  assert.equal(settings.getSnapshot("one").inventoryError, null);
  assert.equal(settings.getSnapshot("one").savedRevision, "committed-r2");
});
