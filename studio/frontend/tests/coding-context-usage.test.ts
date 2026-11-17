// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { deriveContextUsageBar } from "../src/features/chat/lib/context-usage-bar-state.ts";
import { codingContextUsage } from "../src/features/coding/context-usage.ts";

const prompt = {
  used_prompt_tokens: 3000,
  confirmed_prompt_tokens: 2500,
  estimated_tail_tokens: 500,
  provider_confirmed: false,
};

test("Coding uses native prompt accounting instead of request totals", () => {
  const props = codingContextUsage({
    context_window: 10000,
    prompt_tokens: { ...prompt, provider_confirmed: true },
    request_usage: { input_tokens: 17000, output_tokens: 9000 },
  });
  const state = deriveContextUsageBar(props);
  assert.equal(state?.face, "3.0k / 10.0k");
  assert.equal(state?.percent, 30);
  assert.equal(state?.hasUsageDetails, false);
});

test("native estimates retain their qualifier and explanation", () => {
  const props = codingContextUsage({ context_window: 10000, prompt_tokens: prompt });
  assert.match(deriveContextUsageBar(props)?.label ?? "", /Estimated context usage/);
  assert.match(props.estimateDescription, /estimated by Mimir/);
});

test("stale native counts remain visible with an explicit qualifier", () => {
  const props = codingContextUsage({
    context_window: 10000,
    prompt_tokens: { ...prompt, provider_confirmed: true },
    stale: true,
  });
  assert.equal(deriveContextUsageBar(props)?.percent, 30);
  assert.match(props.usageDescription ?? "", /Last reported usage/);
  assert.equal(codingContextUsage({ stale: false }).usageDescription, undefined);
});

test("an unknown native count does not claim zero usage", () => {
  assert.equal(deriveContextUsageBar(codingContextUsage(undefined)), null);
  const state = deriveContextUsageBar(codingContextUsage({ context_window: 10000 }));
  assert.equal(state?.percent, null);
  assert.match(state?.label ?? "", /usage not counted yet/);
});

test("Coding omits local-loader advice without changing Chat advice", () => {
  const input = { used: 9000, total: 10000 };
  assert.equal(deriveContextUsageBar(input)?.advice, "stops-at-limit");
  const props = codingContextUsage({
    context_window: 10000,
    prompt_tokens: { ...prompt, used_prompt_tokens: 9000, provider_confirmed: true },
  });
  assert.equal(deriveContextUsageBar(props)?.advice, "none");
});
