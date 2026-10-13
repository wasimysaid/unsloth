// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  restoreAnswerFocus,
  watchAnswerFocus,
} from "../src/features/coding/answer-focus.ts";

function setup() {
  const document = Object.assign(new EventTarget(), {
    body: new EventTarget(),
  });
  const window = new EventTarget();
  const intent = { current: "pending-question" as string | null };
  let focused = 0;
  const row = { focus: () => ++focused };
  const cleanup = watchAnswerFocus(intent, document, window);
  const mount = () =>
    restoreAnswerFocus(
      intent,
      "pending-question",
      row,
      document.body,
      document.body,
    );
  return { document, window, intent, cleanup, mount, focused: () => focused };
}

for (const interaction of ["pointer", "focus", "window-blur"] as const) {
  test(`outside ${interaction} revokes handoff before a delayed matching row mounts`, () => {
    const scene = setup();
    if (interaction === "window-blur")
      scene.window.dispatchEvent(new Event("blur"));
    else
      scene.document.dispatchEvent(
        new Event(interaction === "pointer" ? "pointerdown" : "focusin"),
      );
    assert.equal(scene.mount(), false);
    assert.equal(scene.focused(), 0);
    assert.equal(scene.intent.current, null);
    scene.cleanup();
  });
}

test("body focus from removed controls preserves handoff; matching row claims it once", () => {
  const scene = setup();
  scene.document.body = scene.document;
  scene.document.dispatchEvent(new Event("focusin"));
  assert.equal(scene.mount(), true);
  assert.equal(scene.mount(), false);
  assert.equal(scene.focused(), 1);
  scene.cleanup();
});

test("an unrelated row or another focused control never receives the handoff", () => {
  const scene = setup();
  const row = { focus: () => assert.fail("focus stolen") };
  assert.equal(
    restoreAnswerFocus(
      scene.intent,
      "another-question",
      row,
      scene.document.body,
      scene.document.body,
    ),
    false,
  );
  assert.equal(scene.intent.current, "pending-question");
  assert.equal(
    restoreAnswerFocus(
      scene.intent,
      "pending-question",
      row,
      new EventTarget(),
      scene.document.body,
    ),
    false,
  );
  assert.equal(scene.intent.current, null);
  scene.cleanup();
});

test("surface teardown revokes any deferred focus ownership", () => {
  const scene = setup();
  scene.cleanup();
  assert.equal(scene.mount(), false);
  assert.equal(scene.focused(), 0);
});
