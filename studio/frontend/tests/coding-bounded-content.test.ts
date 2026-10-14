// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent } from "react";
import { boundedContentKeyDown } from "../src/features/coding/bounded-content.ts";

function viewport(scrollHeight = 1000, scrollWidth = 600) {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight,
    scrollWidth,
    clientHeight: 200,
    clientWidth: 300,
  } as HTMLElement;
}
function press(
  node: HTMLElement,
  key: string,
  extra: Partial<KeyboardEvent<HTMLElement>> = {},
) {
  let prevented = false;
  boundedContentKeyDown({
    key,
    target: node,
    currentTarget: node,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...extra,
    preventDefault() {
      prevented = true;
    },
  } as KeyboardEvent<HTMLElement>);
  return prevented;
}

test("short output Home/End and page keys cannot chain into the transcript", () => {
  const node = viewport(100, 100);
  for (const key of [
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    " ",
  ]) {
    assert.equal(press(node, key, { ctrlKey: key === "End" }), true);
    assert.equal(node.scrollTop, 0);
    assert.equal(node.scrollLeft, 0);
  }
});

test("bounded output supports exact end/home and vertical/horizontal navigation", () => {
  const node = viewport();
  assert.equal(press(node, "End", { ctrlKey: true }), true);
  assert.equal(node.scrollTop, 800);
  press(node, "ArrowDown");
  assert.equal(node.scrollTop, 800);
  press(node, "PageUp");
  assert.equal(node.scrollTop, 620);
  press(node, "ArrowUp");
  assert.equal(node.scrollTop, 596);
  press(node, "Home", { metaKey: true });
  assert.equal(node.scrollTop, 0);
  press(node, "PageDown");
  assert.equal(node.scrollTop, 180);
  press(node, " ");
  assert.equal(node.scrollTop, 360);
  press(node, " ", { shiftKey: true });
  assert.equal(node.scrollTop, 180);
  for (let index = 0; index < 30; index++) press(node, "ArrowRight");
  assert.equal(node.scrollLeft, 300);
  press(node, "ArrowLeft");
  assert.equal(node.scrollLeft, 276);
});

test("nested semantic controls, browser shortcuts and already handled keys remain native", () => {
  const node = viewport();
  for (const [key, extra] of [
    ["End", { target: viewport() }],
    ["ArrowLeft", { altKey: true }],
    ["ArrowDown", { ctrlKey: true }],
    ["End", { defaultPrevented: true }],
    ["Tab", {}],
    ["Enter", {}],
    ["c", { metaKey: true }],
  ] as const) {
    assert.equal(press(node, key, extra), false);
    assert.equal(node.scrollTop, 0);
    assert.equal(node.scrollLeft, 0);
  }
});
