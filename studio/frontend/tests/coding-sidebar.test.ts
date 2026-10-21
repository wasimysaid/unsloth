// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as reactVirtual from "@tanstack/react-virtual";
import * as lucide from "lucide-react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import type * as ConversationListModule from "../src/features/coding/conversation-list.tsx";
import * as conversationWindow from "../src/features/coding/conversation-window.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

const { CONVERSATION_OVERSCAN, conversationKeyTarget, windowWithPinned } =
  conversationWindow;

const { ConversationList, projectName } = loadWithStubs<
  typeof ConversationListModule
>(new URL("../src/features/coding/conversation-list.tsx", import.meta.url), {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "lucide-react": lucide,
  "@tanstack/react-virtual": reactVirtual,
  "@/hooks/use-ui-space-scale": { useUiSpaceScale: () => 1 },
  "@/components/ui/sidebar": {
    SidebarMenu: (props: Record<string, unknown>) =>
      React.createElement("ul", props),
    SidebarMenuItem: (props: Record<string, unknown>) =>
      React.createElement("li", props),
    SidebarMenuButton: ({ isActive, ...props }: Record<string, unknown>) =>
      React.createElement("button", {
        type: "button",
        ...props,
        "data-active": isActive,
      }),
  },
  "./conversation-window": conversationWindow,
});

const saved = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `conv-${index}`,
    cwd: `/work/project-${index}/`,
    title: index % 2 ? `Task ${index}` : null,
  }));

const render = (
  props: Partial<Parameters<typeof ConversationList>[0]> & {
    conversations: ReturnType<typeof saved>;
  },
) =>
  renderToStaticMarkup(
    React.createElement(ConversationList, {
      scrollElement: null,
      activeId: undefined,
      pendingId: undefined,
      disabled: false,
      onOpen: () => {},
      ...props,
    }),
  );

const rows = (markup: string) => markup.match(/<li\b[^>]*>/g) ?? [];

test("keyboard targets span the whole saved list, not only the mounted rows", () => {
  const count = 5000;
  assert.equal(conversationKeyTarget("End", 3, count, 12), 4999);
  assert.equal(conversationKeyTarget("Home", 4321, count, 12), 0);
  assert.equal(conversationKeyTarget("ArrowDown", 4998, count, 12), 4999);
  assert.equal(conversationKeyTarget("ArrowDown", 4999, count, 12), 4999);
  assert.equal(conversationKeyTarget("ArrowUp", 0, count, 12), 0);
  assert.equal(conversationKeyTarget("PageDown", 4990, count, 12), 4999);
  assert.equal(conversationKeyTarget("PageUp", 5, count, 12), 0);
  assert.equal(conversationKeyTarget("PageDown", 100, count, 12), 112);
  // An unmeasured viewport still pages by one row instead of standing still.
  assert.equal(conversationKeyTarget("PageDown", 100, count, 0), 101);
  assert.equal(conversationKeyTarget("Tab", 100, count, 12), null);
  assert.equal(conversationKeyTarget("Enter", 100, count, 12), null);
  assert.equal(conversationKeyTarget("End", 0, 0, 12), null);

  let index = 0;
  let steps = 0;
  for (;;) {
    const next = conversationKeyTarget("ArrowDown", index, count, 12);
    if (next === null || next === index) break;
    index = next;
    steps += 1;
  }
  assert.deepEqual([index, steps], [4999, 4999]);
});

test("the focused row stays mounted beside the window without widening it", () => {
  const range = { startIndex: 3000, endIndex: 3015, overscan: 8, count: 5000 };
  const window = windowWithPinned(range, undefined);
  assert.equal(window.length, 16 + 2 * 8);
  assert.deepEqual([window[0], window.at(-1)], [2992, 3023]);
  assert.deepEqual(windowWithPinned(range, 3010), window);
  assert.deepEqual(windowWithPinned(range, 12), [12, ...window]);
  assert.deepEqual(windowWithPinned(range, 4999), [...window, 4999]);
  assert.deepEqual(windowWithPinned(range, 5000), window);
  assert.deepEqual(windowWithPinned(range, -1), window);
  const edge = { startIndex: 0, endIndex: 3, overscan: 8, count: 5 };
  assert.deepEqual(windowWithPinned(edge, 4), [0, 1, 2, 3, 4]);
});

test("5000 saved conversations mount a bounded window inside a full-height list", () => {
  const conversations = saved(5000);
  const markup = render({ conversations });
  const mounted = rows(markup);
  // 16 unmeasured rows plus the overscan below them.
  assert.equal(mounted.length, 16 + CONVERSATION_OVERSCAN);
  assert.match(markup, /<ul aria-label="Saved coding conversations"/);
  assert.match(markup, /height:265000px/);
  assert.match(mounted[0] ?? "", /aria-posinset="1"/);
  assert.match(mounted[0] ?? "", /aria-setsize="5000"/);
  assert.match(mounted.at(-1) ?? "", /aria-posinset="24"/);
  assert.match(mounted.at(-1) ?? "", /transform:translateY\(1219px\)/);
  assert.doesNotMatch(markup, /data-conversation-id="conv-24"/);
  assert.equal(
    new Set(markup.match(/data-conversation-id="[^"]+"/g)).size,
    mounted.length,
  );
});

test("mounted rows keep titles, project names, cwd, active and pending semantics", () => {
  const conversations = saved(5000);
  const markup = render({
    conversations,
    activeId: "conv-1",
    pendingId: "conv-2",
  });
  const button = (id: string) =>
    markup.match(
      new RegExp(`<button[^>]*data-conversation-id="${id}"[^>]*>.*?</button>`),
    )?.[0] ?? "";
  const active = button("conv-1");
  assert.match(active, /aria-current="true"/);
  assert.match(active, /data-active="true"/);
  assert.match(active, /aria-busy="false"/);
  assert.match(active, /title="\/work\/project-1\/"/);
  assert.match(active, /aria-describedby="coding-project-disclosure"/);
  assert.match(active, />Task 1</);
  assert.match(active, />project-1</);
  const pending = button("conv-2");
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /animate-spin/);
  assert.doesNotMatch(pending, /aria-current/);
  assert.match(pending, />Coding conversation</);
  assert.doesNotMatch(markup, /disabled=""/);
  assert.equal(
    rows(render({ conversations, disabled: true })).length,
    16 + CONVERSATION_OVERSCAN,
  );
  assert.match(render({ conversations, disabled: true }), /disabled=""/);
  assert.equal(projectName("C:\\work\\repo\\"), "repo");
  assert.equal(projectName("/"), "/");
});

test("a short saved list mounts every row and an empty one mounts none", () => {
  assert.equal(rows(render({ conversations: saved(3) })).length, 3);
  const empty = render({ conversations: [] });
  assert.equal(rows(empty).length, 0);
  assert.match(empty, /height:0;/);
});

test("the coding sidebar windows saved rows inside its own scroll container", () => {
  const page = readFileSync(
    new URL("../src/features/coding/coding-page.tsx", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(page, /<SidebarContent ref=\{setScrollElement\}>/);
  assert.match(
    page,
    /<ConversationList conversations=\{state\.conversations\} scrollElement=\{scrollElement\}/,
  );
  assert.doesNotMatch(page, /state\.conversations\.map/);
  // The mobile sheet still closes before the open starts.
  assert.match(
    page,
    /onOpen=\{\(id\) => \{ if \(isMobile\) setOpenMobile\(false\); onOpen\(id\); \}\}/,
  );
});
