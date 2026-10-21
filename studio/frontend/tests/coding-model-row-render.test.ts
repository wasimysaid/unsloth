// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import * as cva from "class-variance-authority";
import * as lucide from "lucide-react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import type * as ButtonModule from "../src/components/ui/button.tsx";
import type * as Picker from "../src/features/coding/model-configuration-popover.tsx";
import * as modelSelection from "../src/features/coding/model-selection.ts";
import * as utils from "../src/lib/utils.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

// The real shared Button and class merging: the defect lived in their result.
const button = loadWithStubs<typeof ButtonModule>(
  new URL("../src/components/ui/button.tsx", import.meta.url),
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "class-variance-authority": cva,
    "radix-ui": { Slot: { Root: "span" } },
    "@/lib/utils": utils,
  },
);
const picker = loadWithStubs<typeof Picker>(
  new URL(
    "../src/features/coding/model-configuration-popover.tsx",
    import.meta.url,
  ),
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": lucide,
    "@/components/ui/button": button,
    "@/components/ui/input": { Input: "input" },
    "@/components/ui/popover": {
      Popover: "div",
      PopoverContent: "div",
      PopoverTrigger: "div",
    },
    "@/components/ui/slider": { Slider: "div" },
    "./api": { codingModelApi: {} },
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
  // Root cause: the shared Button is `whitespace-nowrap shrink-0`.
  const inherited = utils
    .cn(button.buttonVariants({ variant: "ghost" }))
    .split(" ");
  assert.ok(inherited.includes("whitespace-nowrap"));
  assert.ok(choice.includes("whitespace-normal"), choice.join(" "));
  assert.ok(!choice.includes("whitespace-nowrap"), choice.join(" "));
  assert.ok(choice.includes("shrink") && !choice.includes("shrink-0"));
  assert.ok(choice.includes("min-w-0") && choice.includes("flex-1"));
  assert.match(markup, new RegExp(`${name.replace(/[()]/g, "\\$&")}`));
  assert.match(markup, /overflow-wrap:anywhere/);
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
