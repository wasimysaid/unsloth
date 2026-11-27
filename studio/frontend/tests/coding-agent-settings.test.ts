// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  mcpCodingReach,
  mcpTransportLimit,
  skillCodingReach,
  summarizeCodingReach,
} from "../src/features/settings/coding-agent/coding-reach.ts";
import {
  loadExpandedCategories,
  navItems,
  saveExpandedCategories,
} from "../src/features/settings/settings-nav-items.ts";
import { SETTINGS_SEARCH_INDEX } from "../src/features/settings/settings-search.ts";
import {
  OWNER_ONLY_SETTINGS_TABS,
  resolveSettingsTab,
} from "../src/features/settings/settings-tab-visibility.ts";
import { SETTINGS_TABS } from "../src/features/settings/stores/settings-dialog-store.ts";
import { en } from "../src/i18n/locales/en.ts";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

function message(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], en);
}

const skill = (patch: Partial<{ valid: boolean; shadowed: boolean; enabled: boolean }> = {}) => ({
  valid: true,
  shadowed: false,
  enabled: true,
  ...patch,
});

const server = (
  patch: Partial<{
    url: string;
    use_oauth: boolean;
    is_enabled: boolean;
    coding_limit: "local-command" | "oauth" | "studio-internal" | null | undefined;
  }> = {},
) => ({
  url: "https://mcp.example.com/mcp",
  use_oauth: false,
  is_enabled: true,
  coding_limit: null,
  ...patch,
});

test("a skill reaches Coding exactly when Chat can load it", () => {
  assert.deepEqual(skillCodingReach(skill()), { state: "available" });
  assert.deepEqual(skillCodingReach(skill({ enabled: false })), { state: "off" });
  assert.deepEqual(skillCodingReach(skill({ valid: false })), {
    state: "limited",
    reason: "invalid",
  });
  assert.deepEqual(skillCodingReach(skill({ shadowed: true })), {
    state: "limited",
    reason: "shadowed",
  });
  // The cause outranks the switch: turning a broken skill on would still not load it.
  assert.equal(skillCodingReach(skill({ valid: false, enabled: true })).state, "limited");
});

test("a saved server's Coding limit comes from the host, even when it looks like plain HTTP", () => {
  // Studio's own tools endpoint is ordinary HTTP to the browser.
  assert.deepEqual(
    mcpCodingReach(server({ url: "http://127.0.0.1:8888/api/mcp", coding_limit: "studio-internal" })),
    { state: "limited", reason: "studio-internal" },
  );
  // And the host clearing a limit wins over the browser's guess.
  assert.deepEqual(mcpCodingReach(server({ url: "stdio:npx", coding_limit: null })), {
    state: "available",
  });
  assert.deepEqual(mcpCodingReach(server({ is_enabled: false })), { state: "off" });
  // A limit outranks the switch, so a Chat-only server reads as Chat only even when off.
  assert.deepEqual(mcpCodingReach(server({ is_enabled: false, coding_limit: "oauth" })), {
    state: "limited",
    reason: "oauth",
  });
});

test("without the host's field, the transport stands in for it", () => {
  assert.deepEqual(mcpCodingReach(server({ url: "npx -y server", coding_limit: undefined })), {
    state: "limited",
    reason: "local-command",
  });
  assert.deepEqual(mcpCodingReach(server({ use_oauth: true, coding_limit: undefined })), {
    state: "limited",
    reason: "oauth",
  });
  assert.deepEqual(mcpCodingReach(server({ url: " HTTPS://x.dev/mcp", coding_limit: undefined })), {
    state: "available",
  });
});

test("an unsaved form previews only what its transport decides", () => {
  assert.equal(mcpTransportLimit({ http: false, useOauth: false }), "local-command");
  assert.equal(mcpTransportLimit({ http: false, useOauth: true }), "local-command");
  assert.equal(mcpTransportLimit({ http: true, useOauth: true }), "oauth");
  assert.equal(mcpTransportLimit({ http: true, useOauth: false }), null);
});

test("the summary line counts every state", () => {
  const reaches = [
    skillCodingReach(skill()),
    skillCodingReach(skill()),
    skillCodingReach(skill({ enabled: false })),
    skillCodingReach(skill({ valid: false })),
  ];
  assert.deepEqual(summarizeCodingReach(reaches), { total: 4, available: 2, off: 1, limited: 1 });
  assert.deepEqual(summarizeCodingReach([]), { total: 0, available: 0, off: 0, limited: 0 });
});

test("a category takes the rail slot of its first tab and gathers the rest", () => {
  type Tab = { id: string; category?: "coding-agent" };
  const items = navItems<Tab, "coding-agent">([
    { id: "chat" },
    { id: "coding-skills", category: "coding-agent" },
    { id: "voice" },
    { id: "coding-mcp", category: "coding-agent" },
  ]);
  assert.deepEqual(
    items.map((item) =>
      item.kind === "tab" ? item.tab.id : `${item.id}[${item.tabs.map((tab) => tab.id).join(",")}]`,
    ),
    ["chat", "coding-agent[coding-skills,coding-mcp]", "voice"],
  );
});

test("the rail remembers which categories are open and survives bad storage", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.deepEqual(loadExpandedCategories(storage), []);
  saveExpandedCategories(storage, new Set(["coding-agent"]));
  assert.deepEqual(loadExpandedCategories(storage), ["coding-agent"]);
  store.set("unsloth_settings_nav_expanded", "{not json");
  assert.deepEqual(loadExpandedCategories(storage), []);
  store.set("unsloth_settings_nav_expanded", JSON.stringify(["coding-agent", 4]));
  assert.deepEqual(loadExpandedCategories(storage), ["coding-agent"]);
  assert.deepEqual(loadExpandedCategories(null), []);
  const full = {
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.doesNotThrow(() => saveExpandedCategories(full, ["coding-agent"]));
});

test("Coding's pages are owner-only Settings tabs listed under one category", () => {
  for (const tab of ["coding-skills", "coding-mcp"] as const) {
    assert.ok(SETTINGS_TABS.includes(tab), `${tab} is a persisted tab id`);
    assert.ok(OWNER_ONLY_SETTINGS_TABS.has(tab), `${tab} is owner-only`);
    assert.equal(resolveSettingsTab(tab, false), "general");
    assert.equal(resolveSettingsTab(tab, true), tab);
    assert.ok(SETTINGS_SEARCH_INDEX[tab].length > 0, `${tab} is searchable`);
  }
  const dialog = source("features/settings/settings-dialog.tsx");
  for (const tab of ["coding-skills", "coding-mcp"]) {
    assert.match(
      dialog,
      new RegExp(`id: "${tab}",[^}]*category: "coding-agent"`),
      `${tab} sits under the Coding Agent category`,
    );
  }
  assert.match(dialog, /aria-expanded=\{open\}/);
  assert.match(dialog, /aria-controls=\{listId\}/);
});

test("the pages reuse the Chat managers instead of their own forms", () => {
  const skills = source("features/settings/tabs/coding-skills-tab.tsx");
  const mcp = source("features/settings/tabs/coding-mcp-tab.tsx");
  assert.match(skills, /<SkillsManager[\s\S]*layout="page"/);
  assert.match(mcp, /<McpServersManager[\s\S]*layout="page"/);
  for (const page of [skills, mcp]) {
    assert.doesNotMatch(page, /authFetch|createSkill|createMcpServer|updateMcpServer/);
  }
  // The Chat dialogs are the same managers in a dialog.
  assert.match(
    source("features/chat/components/chat-skills-dialog.tsx"),
    /<SkillsManager active=\{open\} layout="dialog" closeGuardRef=\{closeGuardRef\} \/>/,
  );
  assert.match(
    source("features/chat/chat-mcp-servers-dialog.tsx"),
    /<McpServersManager active=\{open\} layout="dialog" closeGuardRef=\{closeGuardRef\} \/>/,
  );
});

test("every Coding Agent string the pages and rail use exists in English", () => {
  const files = [
    "features/settings/tabs/coding-skills-tab.tsx",
    "features/settings/tabs/coding-mcp-tab.tsx",
    "features/settings/coding-agent/coding-reach-view.tsx",
    "features/settings/settings-dialog.tsx",
  ].map(source);
  const keys = new Set<string>();
  for (const text of files) {
    for (const match of text.matchAll(/"(settings\.(?:codingAgent|tabs\.coding)[A-Za-z.]*)"/g)) {
      keys.add(match[1]);
    }
  }
  assert.ok(keys.size >= 10);
  for (const key of keys) {
    assert.equal(typeof message(key), "string", `${key} has an English message`);
  }
  assert.match(String(message("settings.codingAgent.reachLine")), /\{available\}.*\{total\}/);
  // Saved MCP changes also cut off open chats' calls, so no copy may promise open ones keep access.
  const copy = JSON.stringify(message("settings.codingAgent"));
  assert.doesNotMatch(copy, /open (ones|chats|conversations) keep/i);
});

test("only a server Coding cannot use is marked; the switch speaks for the rest", () => {
  const mcp = source("features/settings/tabs/coding-mcp-tab.tsx");
  assert.match(mcp, /reach\.state === "limited" \?/);
  assert.match(mcp, /if \(limit === null\) return null;/);
  // Imports go through the chat feature's index.
  for (const page of [mcp, source("features/settings/tabs/coding-skills-tab.tsx")]) {
    assert.doesNotMatch(page, /@\/features\/chat\//);
  }
});
