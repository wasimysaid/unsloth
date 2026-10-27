// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import * as lucide from "lucide-react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import type * as Picker from "../src/features/coding/model-configuration-popover.tsx";
import * as modelSelection from "../src/features/coding/model-selection.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

const picker = loadWithStubs<typeof Picker>(
  new URL(
    "../src/features/coding/model-configuration-popover.tsx",
    import.meta.url,
  ),
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": lucide,
    "@/components/ui/popover": {
      Popover: "div",
      PopoverContent: "div",
      PopoverTrigger: "div",
    },
    "./model-selection": modelSelection,
  },
);
const classes = (markup: string, attribute: string) =>
  new RegExp(
    `<button[^>]*${attribute}[^>]*class="([^"]*)"|<button[^>]*class="([^"]*)"[^>]*${attribute}`,
  )
    .exec(markup)
    ?.slice(1)
    .find(Boolean)
    ?.split(" ") ?? [];

test("a long native model label wraps inside its choice and never under Favorite", () => {
  const name = "Deterministic protocol (not a live model)";
  const markup = renderToStaticMarkup(
    React.createElement(picker.ModelChoiceRow, {
      provider: "coding-acceptance",
      model: {
        id: "offline",
        name,
        api_model: "offline",
        default_reasoning: null,
        reasoning: "unsupported",
      },
      selected: true,
      favorite: false,
      disabled: false,
      onSelect: () => {},
      onFavorite: () => {},
    }),
  );
  const choice = classes(markup, 'data-model="offline"');
  assert.ok(!choice.includes("whitespace-nowrap"), choice.join(" "));
  assert.ok(choice.includes("min-w-0") && choice.includes("flex-1"));
  assert.match(markup, new RegExp(`${name.replace(/[()]/g, "\\$&")}`));
  assert.match(markup, /overflow-wrap:anywhere/);
  assert.match(markup, /aria-label="Selected"/);
  // Favorite stays its own sibling control, never inside the choice.
  assert.match(
    markup,
    /<\/button><button[^>]*aria-label="Favorite coding-acceptance\/offline"/,
  );
  assert.ok(
    classes(markup, 'aria-label="Favorite coding-acceptance/offline"').includes(
      "shrink-0",
    ),
  );
});

test("effort names read as labels and the rail exposes the discrete slider", () => {
  assert.deepEqual(
    ["low", "medium", "high", "xhigh", "max", "very_high"].map(
      picker.effortLabel,
    ),
    ["Low", "Medium", "High", "X-High", "Max", "Very High"],
  );
  const markup = renderToStaticMarkup(
    React.createElement(picker.EffortSlider, {
      levels: ["low", "medium", "high", "xhigh"],
      value: 2,
      disabled: false,
      onPreview: () => {},
      onCommit: () => {},
    }),
  );
  assert.match(markup, /role="slider"/);
  assert.match(markup, /aria-valuemin="0"/);
  assert.match(markup, /aria-valuemax="3"/);
  assert.match(markup, /aria-valuenow="2"/);
  assert.match(markup, /aria-valuetext="High"/);
  // One stop per offered level; the thumb sits on the selected stop.
  assert.equal(markup.match(/size-1 /g)?.length, 4);
  assert.match(markup, /left:calc\(22px \+ \(100% - 44px\) \* 0\.6666/);
});
