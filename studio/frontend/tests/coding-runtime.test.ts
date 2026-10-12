// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  codingOpeningAdapter,
  CODING_SEND_UNAVAILABLE,
} from "../src/features/coding/opening-runtime.ts";
import { ExternalStoreThreadRuntimeCore } from "../node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-thread-runtime-core.js";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("the installed pinned external runtime exposes only disabled opening presentation capabilities", () => {
  const runtime = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    codingOpeningAdapter,
  );
  assert.equal(runtime.isDisabled, true);
  assert.equal(runtime.isRunning, false);
  assert.deepEqual(runtime.messages, []);
  for (const [capability, enabled] of Object.entries(runtime.capabilities)) {
    assert.equal(
      enabled,
      false,
      `${capability} must remain unavailable in the opening preview`,
    );
  }
});

test("a direct append cannot fake prompt execution or mutate native/browser history", async () => {
  const runtime = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    codingOpeningAdapter,
  );
  await assert.rejects(
    runtime.append({
      parentId: null,
      sourceId: null,
      role: "user",
      content: [{ type: "text", text: "Must not execute" }],
      attachments: [],
      createdAt: new Date(),
      metadata: { custom: {} },
      runConfig: {},
    }),
    new RegExp(CODING_SEND_UNAVAILABLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.deepEqual(runtime.messages, []);
});

test("coding route is authenticated, registered and has no general-chat imports", () => {
  const route = source("../src/app/routes/coding.tsx");
  assert.match(route, /path: "\/coding"/);
  assert.match(route, /beforeLoad: \(\) => requireAuth\(\)/);
  assert.match(source("../src/app/router.tsx"), /codingRoute,/);
  for (const name of [
    "coding-page.tsx",
    "api.ts",
    "session.ts",
    "opening-runtime.ts",
    "project-folder-dialog.tsx",
    "events.ts",
  ]) {
    const contents = source(`../src/features/coding/${name}`);
    assert.doesNotMatch(
      contents,
      /from ["'][^"']*(?:features\/chat|app-sidebar|assistant-ui\/thread|chat-history|sandbox|model-picker)/,
    );
    assert.doesNotMatch(
      contents,
      /localStorage|indexedDB|EventSource|ChatModelAdapter/,
    );
  }
});

test("composer is visibly unavailable and the host chooser is rendered beneath it with trust disclosure", () => {
  const page = source("../src/features/coding/coding-page.tsx").replace(
    /\s+/g,
    " ",
  );
  const dialog = source(
    "../src/features/coding/project-folder-dialog.tsx",
  ).replace(/\s+/g, " ");
  assert.match(page, /submitMode="none"/);
  assert.match(page, /onSubmit=\{\(event\) => event.preventDefault\(\)\}/);
  assert.match(page, /type="button" size="icon" disabled aria-label="Send"/);
  assert.ok(
    page.indexOf("<OpeningComposer key=") <
      page.indexOf('data-testid="coding-project-chooser"'),
  );
  assert.match(page, /coding-send-explanation/);
  assert.match(
    page,
    /Opening or reopening trusts project configuration and extensions for this native controller only/,
  );
  assert.match(page, /aria-describedby="coding-project-disclosure"/);
  assert.match(CODING_SEND_UNAVAILABLE, /Prompt execution is not available/);
  assert.match(dialog, /working directory.*not an upload or a sandbox/);
  assert.match(dialog, /trusts its project configuration and extensions/);
  assert.match(dialog, /no shared trust decision is saved/);
  assert.doesNotMatch(
    page,
    /ComposerPrimitive\.(?:Send|Cancel|AddAttachment|AttachmentDropzone)|tool.?pill/i,
  );
});
