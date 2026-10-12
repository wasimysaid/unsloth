// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { restoreProjectPickerFocus } from "../src/features/coding/project-picker-focus.ts";

function target(
  options: {
    connected?: boolean;
    visible?: boolean;
    disabled?: boolean;
    inert?: boolean;
  } = {},
) {
  const focuses: FocusOptions[] = [];
  const element = {
    isConnected: options.connected ?? true,
    getClientRects: () => ({ length: (options.visible ?? true) ? 1 : 0 }),
    matches: () => options.disabled ?? false,
    closest: () => (options.inert ? {} : null),
    focus: (settings: FocusOptions) => focuses.push(settings),
  } as unknown as HTMLElement;
  return { element, focuses };
}

test("project picker restores the actual visible invoker without scrolling", () => {
  const invoker = target();
  const chooser = target();
  restoreProjectPickerFocus(invoker.element, chooser.element);
  assert.deepEqual(invoker.focuses, [{ preventScroll: true }]);
  assert.deepEqual(chooser.focuses, []);
});

for (const options of [
  { connected: false },
  { visible: false },
  { disabled: true },
  { inert: true },
]) {
  test(`a disappeared/mobile/inert invoker falls back to the visible project chooser: ${JSON.stringify(options)}`, () => {
    const invoker = target(options);
    const chooser = target();
    restoreProjectPickerFocus(invoker.element, chooser.element);
    assert.deepEqual(invoker.focuses, []);
    assert.deepEqual(chooser.focuses, [{ preventScroll: true }]);
  });
}

test("route teardown does not focus disconnected or absent elements", () => {
  const chooser = target({ connected: false });
  restoreProjectPickerFocus(null, chooser.element);
  restoreProjectPickerFocus(null, null);
  assert.deepEqual(chooser.focuses, []);
});
