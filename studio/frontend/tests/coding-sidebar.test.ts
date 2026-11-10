// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import type * as CodingRecentsModule from "../src/features/coding/coding-recents.tsx";
import { projectName } from "../src/features/coding/project-name.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

const source = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

let state: Record<string, unknown>;
const calls: string[] = [];
const session = {
  subscribe: () => () => {},
  getSnapshot: () => state,
  refreshConversations: () => calls.push("refresh"),
  startNew: () => calls.push("new"),
  openConversation: (id: string) => calls.push(`open:${id}`),
};

const element =
  (tag: string) =>
  ({ isActive, ...props }: Record<string, unknown>) =>
    React.createElement(tag, { ...props, "data-active": isActive });

const { CodingRecents, CodingRecentsActions } = loadWithStubs<
  typeof CodingRecentsModule
>(new URL("../src/features/coding/coding-recents.tsx", import.meta.url), {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "@/components/progressive-rows": {
    ProgressiveRows: ({
      items,
      pageSize,
      renderItem,
    }: {
      items: { id: string }[];
      pageSize: number;
      renderItem: (item: { id: string }) => React.ReactNode;
    }) => items.slice(0, pageSize).map(renderItem),
  },
  "@/components/ui/sidebar": {
    SidebarMenu: element("ul"),
    SidebarMenuItem: element("li"),
    SidebarMenuButton: element("button"),
    useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
  },
  "@/components/ui/spinner": {
    Spinner: ({ label }: { label: string }) =>
      React.createElement("span", { role: "status", "aria-label": label }),
  },
  "@hugeicons/core-free-icons": { PencilEdit02Icon: {}, Refresh01Icon: {} },
  "@hugeicons/react": { HugeiconsIcon: () => null },
  "./project-name": { projectName },
  "./shared-session": { codingSession: session },
});

const saved = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `conv-${index}`,
    cwd: `/work/project-${index}/`,
    title: index % 2 ? `Task ${index}` : null,
  }));

const idle = {
  conversations: [],
  active: null,
  pending: null,
  loadingConversations: false,
  historyError: null,
  openingUncertainty: null,
};

const render = (next: Record<string, unknown>) => {
  state = { ...idle, ...next };
  return renderToStaticMarkup(React.createElement(CodingRecents));
};

test("coding conversations are drawn as the sidebar draws chats", () => {
  const markup = render({
    conversations: saved(4),
    active: { id: "conv-1" },
    pending: { operation: "open", id: "conv-2" },
  });
  assert.match(markup, /<ul aria-label="Saved coding conversations"/);
  assert.equal((markup.match(/<li\b/g) ?? []).length, 4);
  const button = (id: string) =>
    markup.match(
      new RegExp(`<button[^>]*data-conversation-id="${id}"[^>]*>.*?</button>`),
    )?.[0] ?? "";
  const active = button("conv-1");
  assert.match(active, /aria-current="true"/);
  assert.match(active, /data-active="true"/);
  assert.match(active, /title="\/work\/project-1\/"/);
  // The chat row's own shape: one line, the row height and the pill.
  assert.match(active, /sidebar-nav-btn h-\[calc\(30px\*var\(--ui-space-scale,1\)\)\]/);
  assert.match(active, /rounded-full/);
  assert.match(active, />Task 1</);
  assert.match(active, />project-1</);
  const pending = button("conv-2");
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /aria-label="Opening conversation"/);
  assert.doesNotMatch(pending, /aria-current/);
  assert.match(pending, />Coding conversation</);
  assert.doesNotMatch(markup, /disabled=""/);
});

test("a long history mounts a page of rows at a time", () => {
  assert.equal((render({ conversations: saved(5000) }).match(/<li\b/g) ?? []).length, 50);
});

test("empty, failed and blocked histories say so", () => {
  assert.match(render({}), /No conversations yet/);
  assert.doesNotMatch(render({ loadingConversations: true }), /No conversations yet/);
  const failed = render({ historyError: "Mimir is not running." });
  assert.match(failed, /role="alert"[^>]*>Mimir is not running\./);
  assert.doesNotMatch(failed, /No conversations yet/);
  // A pending create, or an uninspected uncertain opening, blocks opening another.
  for (const blocked of [
    { pending: { operation: "create", id: null } },
    { openingUncertainty: { operation: "open", id: "conv-0", inspected: false } },
  ]) {
    assert.match(render({ conversations: saved(2), ...blocked }), /disabled=""/);
  }
  assert.doesNotMatch(
    render({
      conversations: saved(2),
      openingUncertainty: { operation: "open", id: "conv-0", inspected: true },
    }),
    /disabled=""/,
  );
});

test("the Recents header offers refresh and a new conversation", () => {
  state = { ...idle };
  const markup = renderToStaticMarkup(React.createElement(CodingRecentsActions));
  assert.match(markup, /aria-label="Refresh conversations"/);
  assert.match(markup, /aria-label="New conversation"/);
  assert.equal((markup.match(/sidebar-header-action/g) ?? []).length, 2);
  state = { ...idle, pending: { operation: "create", id: null } };
  assert.match(
    renderToStaticMarkup(React.createElement(CodingRecentsActions)),
    /disabled="" aria-label="New conversation"|aria-label="New conversation"[^>]*disabled=""/,
  );
});

test("Coding renders inside the app shell, with the app sidebar", () => {
  const root = source("app/routes/__root.tsx");
  assert.doesNotMatch(root, /RootRouteLayout|parked[=}]/);
  assert.match(root, /const ownsItsShell = isChatLike \|\| pathname === "\/coding";/);
  assert.match(root, /<AppSidebar \/>/);
  const page = source("features/coding/coding-page.tsx");
  // One sidebar: the page brings none of its own.
  assert.doesNotMatch(page, /SidebarProvider|<Sidebar\b|SidebarTrigger|SidebarInset/);
  assert.match(page, /from "\.\/shared-session"/);
  const sidebar = source("components/app-sidebar.tsx");
  assert.match(sidebar, /const isCodingRoute = pathname === "\/coding";/);
  assert.match(sidebar, /label="Coding"\s+active=\{isCodingRoute\}/);
  // On its route, Coding's conversations stand where the chat sections do.
  assert.match(
    sidebar,
    /const chatSectionsReplaced = isStudioRoute \|\| showTrainingRecents \|\| isCodingRoute;/,
  );
  assert.match(sidebar, /\{isCodingRoute && \([\s\S]{0,1600}<CodingRecents \/>/);
  // The sidebar ships without the coding feature until its route is opened.
  assert.doesNotMatch(sidebar, /^import [^\n]*features\/coding/m);
  assert.equal(projectName("C:\\work\\repo\\"), "repo");
  assert.equal(projectName("/"), "/");
});
