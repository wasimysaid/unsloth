// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import * as lucide from "lucide-react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import type * as PlanCardModule from "../src/features/coding/plan-card.tsx";
import * as preview from "../src/features/coding/plan-preview.ts";
import type { NativePlan } from "../src/features/coding/plan-types.ts";
import * as replyProse from "../src/features/coding/reply-prose.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

const disclosure = { open: false };
const card = loadWithStubs<typeof PlanCardModule>(
  new URL("../src/features/coding/plan-card.tsx", import.meta.url),
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": lucide,
    "@/components/markdown/markdown-preview": {
      MarkdownPreview: ({ markdown }: { markdown: string }) =>
        React.createElement("div", { "data-markdown": true }, markdown),
    },
    "@/lib/copy-to-clipboard": { copyToClipboard: async () => true },
    "./plan-preview": preview,
    "./reply-prose": replyProse,
    "./tool-report": {
      useDisclosure: () => [disclosure.open, () => {}] as const,
    },
  },
);

const markdown = `# Word count CLI\n\n## Steps\n\n${"- step\n".repeat(120)}PLAN_TAIL`;
const plan: NativePlan = {
  id: "plan-1",
  name: "Word count CLI",
  path: "/plans/word-count.md",
  markdown,
  status: "review_pending",
  revision: "r1",
};
const render = (props: {
  plan: NativePlan;
  current?: boolean;
  actions?: React.ReactNode;
}) =>
  renderToStaticMarkup(React.createElement(card.PlanCard, props));

test("the current plan keeps its complete rendered Markdown, status and copy", () => {
  disclosure.open = false;
  const markup = render({ plan, current: true });
  assert.match(markup, /data-testid="coding-current-plan"/);
  assert.match(markup, /data-plan-id="plan-1"/);
  assert.match(markup, /data-plan-status="review_pending"/);
  // Folding is visual only: the full document is always in the DOM.
  const rendered = markup.match(/<div data-markdown="true">([\s\S]*?)<\/div>/)?.[1];
  assert.equal(rendered, markdown);
  assert.match(markup, /data-testid="coding-plan-status">Ready for review</);
  assert.match(markup, /aria-label="Copy plan"/);
  // No <details>/<summary> drop-down, and the title is labelled with its status.
  assert.doesNotMatch(markup, /<details|<summary/);
  const labelledBy = markup.match(/<section aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(labelledBy && labelledBy.split(" ").length === 2);
  // The Markdown carries the title, so the visible header doesn't repeat it.
  assert.match(markup, /<span class="sr-only">: Word count CLI<\/span>/);
});

test("the current plan is unboxed reply prose with the turn's actions beside Copy", () => {
  disclosure.open = false;
  const markup = render({
    plan,
    current: true,
    actions: React.createElement("button", { "data-turn-action": true }),
  });
  const section = markup.match(/<section [^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(section, /border|rounded|bg-/);
  assert.match(markup, /Copy plan"[^]*data-turn-action/);
});

test("historical plans are one quiet line that opens to the full plan", () => {
  const record = { ...plan, status: "completed" as const };
  disclosure.open = false;
  const closed = render({ plan: record });
  assert.match(closed, /data-testid="coding-historical-plan"/);
  assert.match(closed, /data-plan-view="collapsed"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /data-testid="coding-plan-status">Implemented</);
  assert.doesNotMatch(closed, /data-markdown/);
  assert.doesNotMatch(closed, /Copy plan/);

  disclosure.open = true;
  const open = render({ plan: record });
  assert.match(open, /data-plan-view="full"/);
  assert.match(open, /aria-expanded="true"/);
  const controls = open.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls && open.includes(`id="${controls}"`));
  assert.equal(
    open.match(/<div data-markdown="true">([\s\S]*?)<\/div>/)?.[1],
    markdown,
  );
  // Inspection only: the disclosure and copy, never plan decisions.
  assert.equal(open.match(/<button/g)?.length, 2);
  assert.doesNotMatch(open, />(Implement|Implement with fresh context|Save and stop)</);
});

test("plans without recorded text or with clipped text say so", () => {
  disclosure.open = true;
  const empty = render({ plan: { ...plan, markdown: "" }, current: true });
  assert.match(empty, /didn&#x27;t record the plan text/);
  assert.doesNotMatch(empty, /Copy plan/);
  // Without Markdown the header names the plan itself.
  assert.match(empty, /Word count CLI<\/span>/);
  assert.doesNotMatch(empty, /sr-only">: Word count CLI/);
  assert.match(render({ plan: { ...plan, clipped: true }, current: true }), /Plan clipped/);
});

test("the preview is bounded by the viewport and only folds meaningful overflow", () => {
  assert.equal(preview.planPreviewLimit(1000), 380);
  assert.equal(preview.planPreviewLimit(844), 380);
  assert.equal(preview.planPreviewLimit(600), 270);
  assert.equal(preview.planPreviewLimit(300), 200);
  const limit = preview.planPreviewLimit(844);
  assert.equal(preview.planOverflows(limit + preview.planPreviewSlack, limit), false);
  assert.equal(preview.planOverflows(limit + preview.planPreviewSlack + 1, limit), true);
});
