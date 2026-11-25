// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionMode } from "../src/features/chat/stores/chat-runtime-store";
import type { RunApi } from "../src/features/coding/run-types.ts";
import { createTerminalPermissions, setTerminalPermissionMode, type TerminalPermissions } from "../src/features/coding/terminal-permissions.ts";

function harness(terminalPermissions: NonNullable<RunApi["terminalPermissions"]>) {
  const history: TerminalPermissions[] = [];
  const api = { terminalPermissions };
  const client = createTerminalPermissions("this-project", api, (state) => history.push(state));
  return { history, client, api };
}

test("a missing plugin contributes no picker and cannot accept a landing choice", async () => {
  const h = harness(async (id) => ({ conversation_id: id, mode: null }));
  await h.client.refresh();
  assert.deepEqual(h.history, []);
  await assert.rejects(setTerminalPermissionMode("this-project", h.api, "ask"), /unavailable/);
});

test("a lost response reads back Full access without granting it twice", async () => {
  const calls: (PermissionMode | undefined)[] = [];
  let remote: PermissionMode = "ask";
  const h = harness(async (id, mode) => {
    calls.push(mode);
    if (mode) {
      remote = mode;
      throw new Error("connection closed after native admission");
    }
    return { conversation_id: id, mode: remote };
  });
  await h.client.refresh();
  await assert.rejects(h.client.change("full"), /connection closed/);
  assert.deepEqual(calls, [undefined, "full", undefined]);
  assert.deepEqual(h.history.at(-1), { kind: "ready", mode: "full" });
});

test("a late status read cannot conceal an acknowledged change", async () => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const h = harness(async (id, mode) => {
    if (!mode && ++reads === 2) await delayed;
    return { conversation_id: id, mode: mode ?? "auto" };
  });
  await h.client.refresh();
  const stale = h.client.refresh();
  assert.equal(stale, h.client.refresh(), "concurrent reads are coalesced");
  await h.client.change("full");
  release();
  await stale;
  assert.deepEqual(h.history.at(-1), { kind: "ready", mode: "full" });
});

test("a landing choice requires the requested mode on the intended conversation", async () => {
  const different = harness(async () => ({ conversation_id: "other-project", mode: "ask" }));
  await assert.rejects(setTerminalPermissionMode("this-project", different.api, "ask"), /different conversation/);
  const wrong = harness(async (id) => ({ conversation_id: id, mode: "full" }));
  await assert.rejects(setTerminalPermissionMode("this-project", wrong.api, "ask"), /did not take effect/);
});

test("an unseen change to Full access is shown before the next prompt can run", async () => {
  let remote: PermissionMode = "auto";
  const h = harness(async (id) => ({ conversation_id: id, mode: remote }));
  await h.client.refresh();
  remote = "full";
  await assert.rejects(h.client.verifyBeforeSend(), /changed in another view/);
  assert.deepEqual(h.history.at(-1), { kind: "ready", mode: "full" });
  await h.client.verifyBeforeSend();
});
