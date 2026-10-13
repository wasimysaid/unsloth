// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptReader } from "../src/features/coding/transcript-reader.ts";

test("paging-control removal cannot checkpoint clamped geometry before prepended rows mount", () => {
  // Geometry-only reproduction of the Firefox oldest-page failure. The real
  // rendered reading workload separately checks browser layout, focus and paging.
  let viewport: GeometryNode;
  let content: GeometryNode;
  let rows: GeometryNode[] = [];
  let controls: GeometryNode[] = [];
  const listeners = new Map<string, EventListener>();
  class GeometryNode {
    isConnected = true;
    tagName = "DIV";
    clientHeight = 350;
    scrollHeight = 100000;
    private top = 0;
    offset: number;
    dataset: Record<string, string>;
    constructor(offset = 0, dataset: Record<string, string> = {}) {
      this.offset = offset;
      this.dataset = dataset;
    }
    get scrollTop() {
      return this.top;
    }
    set scrollTop(value: number) {
      this.top = Math.max(
        0,
        Math.min(this.scrollHeight - this.clientHeight, value),
      );
    }
    getBoundingClientRect() {
      return {
        top: this === viewport ? 0 : this.offset - viewport.scrollTop,
        height: 80,
      };
    }
    getClientRects() {
      return this.isConnected ? [this.getBoundingClientRect()] : [];
    }
    querySelector() {
      return rows[0] ?? null;
    }
    querySelectorAll(selector: string) {
      if (this !== content) return [];
      return selector === "[data-reading-key]" ? rows : controls;
    }
    closest() {
      return null;
    }
    getAttribute() {
      return null;
    }
    addEventListener(name: string, listener: EventListener) {
      listeners.set(name, listener);
    }
    removeEventListener(name: string) {
      listeners.delete(name);
    }
    focus() {
      documentState.activeElement = this;
      listeners.get("focusin")?.({ target: this } as unknown as Event);
    }
  }
  class GeometryObserver {
    observe() {}
    disconnect() {}
  }
  viewport = new GeometryNode();
  content = new GeometryNode();
  const body = new GeometryNode();
  const documentState = { body, activeElement: body };
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    document: documentState,
    Element: GeometryNode,
    HTMLElement: GeometryNode,
    MutationObserver: GeometryObserver,
    ResizeObserver: GeometryObserver,
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  let reader: ReturnType<typeof createTranscriptReader> | undefined;
  try {
    const retained = new GeometryNode(101, { readingKey: "entry-64" });
    const earlier = new GeometryNode(28, { readingControl: "earlier" });
    earlier.tagName = "BUTTON";
    rows = [retained];
    controls = [earlier];
    viewport.scrollTop = 11;
    reader = createTranscriptReader(
      viewport as unknown as HTMLElement,
      content as unknown as HTMLElement,
      () => {},
    );
    earlier.focus();
    reader.pause();
    assert.equal(retained.getBoundingClientRect().top, 90);

    // The surface removes exhausted navigation before assistant-ui commits its
    // new rows. Restoring the old anchor requires negative scrollTop at this
    // intermediate stage; the browser clamps it to zero and focus falls to body.
    controls = [];
    earlier.isConnected = false;
    documentState.activeElement = body;
    retained.offset = 42;
    reader.restore();
    assert.equal(viewport.scrollTop, 0);
    assert.equal(documentState.activeElement, viewport);

    rows = [new GeometryNode(42, { readingKey: "entry-0" }), retained];
    retained.offset = 5876.6666667;
    reader.restore();
    assert.ok(
      Math.abs(retained.getBoundingClientRect().top - 90) < 0.01,
      "Intermediate clamping or owned focus restoration replaced the original visual anchor",
    );
    assert.equal(documentState.activeElement, viewport);
  } finally {
    reader?.dispose();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
