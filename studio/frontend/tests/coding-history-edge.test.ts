// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import * as lucide from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import type * as HistoryEdge from "../src/features/coding/history-edge.tsx";
import { loadWithStubs } from "./helpers/module-stubs.ts";

const { HistoryEdge: Edge } = loadWithStubs<typeof HistoryEdge>(
  new URL("../src/features/coding/history-edge.tsx", import.meta.url),
  {
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": lucide,
    "@/components/ui/button": {
      Button: (props: Record<string, unknown>) =>
        createElement("button", { ...props, type: "button" }),
    },
  },
);

test("idle history has no routine paging control, while loading has an accessible quiet status", () => {
  const props = {
    direction: "before" as const,
    loading: false,
    error: false,
    disabled: false,
    onRetry() {},
  };
  assert.equal(renderToStaticMarkup(createElement(Edge, props)), "");
  const loading = renderToStaticMarkup(
    createElement(Edge, { ...props, loading: true }),
  );
  assert.match(loading, /<output/);
  assert.match(loading, /Loading earlier messages/);
  assert.doesNotMatch(loading, /<button/);
});

test("only errors expose explicit labelled retry controls", () => {
  for (const [direction, label] of [
    ["before", "earlier"],
    ["after", "newer"],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(Edge, {
        direction,
        loading: false,
        error: true,
        disabled: true,
        onRetry() {},
      }),
    );
    assert.match(html, /<button/);
    assert.match(html, /aria-disabled="true"/);
    assert.ok(html.includes(`Retry ${label} messages`));
  }
});
