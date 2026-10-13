// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadWithStubs } from "./helpers/module-stubs.ts";
import type * as Applied from "../src/features/coding/mcp-applied-state.tsx";
import type { McpInventory } from "../src/features/coding/mcp-types.ts";

// The source is transpiled for Node's TSX limitation; real React/JSX/DOM rendering,
// not the record-only JSX test double. Inputs are deterministic native-state fixtures.
const { McpAppliedState } = loadWithStubs<typeof Applied>(
  new URL("../src/features/coding/mcp-applied-state.tsx", import.meta.url),
  { "react/jsx-runtime": jsxRuntime },
);
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
const render = (state: McpInventory) =>
  renderToStaticMarkup(createElement(McpAppliedState, { inventory: state }));

test("rendered unknown applied status cannot falsely claim there are no applied connections", () => {
  const html = render({
    ...inventory,
    live_available: false,
    diagnostics: ["Native applied status is unavailable"],
  });
  assert.match(html, /Applied status unavailable/);
  assert.match(html, /refresh inventory/);
  assert.doesNotMatch(html, /No configured connections currently applied/);
  assert.doesNotMatch(html, /Native runtime configuration is current/);
});

test("rendered known-empty state is distinct from unavailable observation", () => {
  const html = render(inventory);
  assert.match(html, /No configured connections currently applied/);
  assert.doesNotMatch(html, /Applied status unavailable/);
});

test("rendered saved pending apply does not change connected status or transient ownership", () => {
  const html = render({
    ...inventory,
    live: [
      {
        name: "persistent",
        ownership: "configured",
        pending_apply: true,
        status: { connected: true, tools: 2, error: null },
        diagnostics: [],
      },
      {
        name: "temporary",
        ownership: "attachment",
        pending_apply: false,
        status: { connected: true, tools: 1, error: null },
        diagnostics: [],
      },
    ],
  });
  assert.match(html, /Connected/);
  assert.match(html, /Saved configuration pending apply/);
  assert.match(html, /Transient connection \(not a Settings entry\)/);
  assert.match(html, /Saving does not apply or reconnect/);
  assert.doesNotMatch(html, /No configured connections currently applied/);
});
