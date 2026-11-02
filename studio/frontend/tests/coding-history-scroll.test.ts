// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  type HistoryDirection,
  type HistoryScrollState,
  createHistoryScroll,
} from "../src/features/coding/history-scroll.ts";

class Viewport extends EventTarget {
  scrollTop = 400;
  scrollHeight = 2000;
  clientHeight = 500;
  parentElement: Viewport | null = null;
  overflowY = "visible";
  editable = false;
  control = false;
  closest(selector: string) {
    return (this.editable && selector.includes("textarea")) ||
      (this.control && selector.includes("button"))
      ? this
      : null;
  }
  send(
    type: string,
    values: Record<string, unknown> = {},
    target: Viewport = this,
  ) {
    const event = new Event(type);
    Object.assign(event, values);
    Object.defineProperty(event, "target", { value: target });
    this.dispatchEvent(event);
  }
}

async function exercise(
  run: (h: {
    viewport: Viewport;
    state: HistoryScrollState;
    shown: string[];
    directions: HistoryDirection[];
    flush: () => void;
    retry: (direction: HistoryDirection) => Promise<void>;
    dispose: () => void;
    delay: (next: Promise<void>) => void;
  }) => Promise<void>,
) {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    HTMLElement: Viewport,
    Element: Viewport,
    getComputedStyle: (node: Viewport) => ({ overflowY: node.overflowY }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const viewport = new Viewport();
  const state: HistoryScrollState = {
    before: true,
    after: true,
    ready: true,
    busy: false,
    error: false,
  };
  const shown = ["current"];
  const directions: HistoryDirection[] = [];
  let delayed: Promise<void> | null = null;
  const controller = createHistoryScroll(
    viewport as unknown as HTMLElement,
    () => state,
    async (direction) => {
      directions.push(direction);
      const next = delayed;
      delayed = null;
      if (next) await next;
      if (direction === "before") shown.unshift("earlier");
      else shown.push("newer");
      state.error = false;
    },
  );
  try {
    await run({
      viewport,
      state,
      shown,
      directions,
      flush() {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      },
      retry: controller.retry,
      dispose: controller.dispose,
      delay: (next) => {
        delayed = next;
      },
    });
  } finally {
    controller.dispose();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only intentional movement near the matching edge loads history, not mounts or restored anchors", async () => {
  await exercise(async ({ viewport, shown, directions, flush }) => {
    viewport.scrollTop = 0;
    viewport.send("scroll");
    flush();
    assert.deepEqual(shown, ["current"]);
    viewport.scrollTop = 600;
    viewport.send("wheel", { deltaY: -50 });
    viewport.send("scroll");
    flush();
    assert.deepEqual(shown, ["current"]);
    viewport.scrollTop = 80;
    viewport.send("scroll");
    await settle();
    assert.deepEqual(shown, ["earlier", "current"]);
    assert.deepEqual(directions, ["before"]);
    viewport.scrollTop = 1500;
    viewport.send("scroll");
    flush();
    await settle();
    assert.deepEqual(shown, ["earlier", "current"]);
    viewport.send("wheel", { deltaY: 50 });
    flush();
    await settle();
    assert.deepEqual(shown, ["earlier", "current", "newer"]);
    assert.deepEqual(directions, ["before", "after"]);
  });
});

test("Control+Home, Control+End and gestures on short windows load at most one page without another gesture", async () => {
  await exercise(async ({ viewport, shown, directions, flush }) => {
    viewport.scrollHeight = 200;
    viewport.scrollTop = 0;
    viewport.send("keydown", { key: "Home", ctrlKey: true });
    flush();
    await settle();
    for (let index = 0; index < 20; index++) {
      viewport.send("scroll");
      flush();
    }
    assert.deepEqual(shown, ["earlier", "current"]);
    viewport.send("keydown", { key: "End", ctrlKey: true });
    flush();
    await settle();
    assert.deepEqual(shown, ["earlier", "current", "newer"]);
    assert.deepEqual(directions, ["before", "after"]);
  });
});

test("smooth keyboard scrolling checks final geometry when scrollend precedes the last scroll event", async () => {
  await exercise(async ({ viewport, shown, directions, flush }) => {
    viewport.scrollTop = 4128;
    viewport.send("scroll");
    viewport.send("keydown", { key: "Home", ctrlKey: true });
    flush();
    assert.deepEqual(shown, ["current"]);
    viewport.scrollTop = 108;
    viewport.send("scroll");
    viewport.scrollTop = 0;
    viewport.send("scrollend");
    viewport.send("scroll");
    await settle();
    assert.deepEqual(shown, ["earlier", "current"]);

    viewport.scrollTop = 400;
    viewport.send("scroll");
    viewport.send("keydown", { key: "End", ctrlKey: true });
    flush();
    viewport.scrollTop = 1392;
    viewport.send("scroll");
    viewport.scrollTop = 1500;
    viewport.send("scrollend");
    viewport.send("scroll");
    await settle();
    assert.deepEqual(shown, ["earlier", "current", "newer"]);
    viewport.send("scrollend");
    viewport.send("scroll");
    flush();
    await settle();
    assert.deepEqual(directions, ["before", "after"]);
  });
});

test("late scrollend events cannot erase queued edge gestures across repeated history pages", async () => {
  await exercise(async ({ viewport, shown, directions, flush }) => {
    for (let page = 0; page < 17; page++) {
      viewport.scrollTop = 400;
      viewport.send("scroll");
      viewport.send("keydown", { key: "Home", ctrlKey: true });
      viewport.send("scrollend");
      viewport.scrollTop = 0;
      viewport.send("scroll");
      viewport.send("scrollend");
      flush();
      await settle();
      assert.deepEqual(shown, [
        ...Array<string>(page + 1).fill("earlier"),
        "current",
      ]);
      viewport.send("scrollend");
      viewport.send("scroll");
      flush();
      await settle();
      assert.equal(
        directions.length,
        page + 1,
        "Restoration events cannot drain another page",
      );
    }
    viewport.scrollTop = 1500;
    viewport.send("scroll");
    viewport.send("wheel", { deltaY: 10 });
    viewport.send("scrollend");
    flush();
    await settle();
    assert.deepEqual(shown, [
      ...Array<string>(17).fill("earlier"),
      "current",
      "newer",
    ]);
  });
});

test("the newest gesture wins a queued check and nested scrollend cannot end outer movement", async () => {
  await exercise(async ({ viewport, shown, directions, flush }) => {
    viewport.scrollHeight = 200;
    viewport.scrollTop = 0;
    viewport.send("keydown", { key: "Home" });
    viewport.send("keydown", { key: "End" });
    viewport.send("scrollend");
    flush();
    await settle();
    assert.deepEqual(shown, ["current", "newer"]);
    assert.deepEqual(directions, ["after"]);

    viewport.scrollHeight = 2000;
    viewport.scrollTop = 600;
    viewport.send("scroll");
    viewport.send("wheel", { deltaY: -40 });
    flush();
    const tool = new Viewport();
    viewport.send("scrollend", {}, tool);
    viewport.scrollTop = 80;
    viewport.send("scroll");
    await settle();
    assert.deepEqual(shown, ["earlier", "current", "newer"]);
    assert.deepEqual(directions, ["after", "before"]);
  });
});

test("pending, disconnected, busy and exhausted edges cannot duplicate or start reads", async () => {
  await exercise(
    async ({ viewport, state, shown, directions, flush, delay }) => {
      let release!: () => void;
      delay(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      viewport.scrollTop = 0;
      viewport.send("wheel", { deltaY: -10 });
      flush();
      for (let index = 0; index < 10; index++) {
        viewport.send("keydown", { key: "Home" });
        viewport.send("scroll");
        flush();
      }
      assert.deepEqual(directions, ["before"]);
      release();
      await settle();
      assert.deepEqual(shown, ["earlier", "current"]);
      for (const patch of [
        { ready: false },
        { busy: true },
        { before: false },
      ]) {
        Object.assign(state, { ready: true, busy: false, before: true }, patch);
        viewport.send("wheel", { deltaY: -10 });
        flush();
        await settle();
      }
      assert.deepEqual(shown, ["earlier", "current"]);
      assert.deepEqual(directions, ["before"]);
    },
  );
});

test("errors stop edge loading until an explicit retry succeeds", async () => {
  await exercise(
    async ({ viewport, state, shown, directions, flush, delay, retry }) => {
      delay(Promise.reject(new Error("History unavailable")));
      viewport.scrollTop = 0;
      viewport.send("keydown", { key: "Home" });
      flush();
      await settle();
      state.error = true;
      for (let index = 0; index < 10; index++) {
        viewport.send("wheel", { deltaY: -10 });
        flush();
      }
      assert.deepEqual(shown, ["current"]);
      assert.deepEqual(directions, ["before"]);
      await retry("before");
      assert.deepEqual(shown, ["earlier", "current"]);
      assert.equal(state.error, false);
      viewport.send("keydown", { key: "Home" });
      flush();
      await settle();
      assert.deepEqual(shown, ["earlier", "earlier", "current"]);
    },
  );
});

test("nested tool scrolling, editable keys and button Space do not page the outer transcript", async () => {
  await exercise(async ({ viewport, shown, flush }) => {
    viewport.scrollTop = 0;
    const tool = new Viewport();
    tool.parentElement = viewport;
    tool.overflowY = "auto";
    viewport.send("wheel", { deltaY: -40 }, tool);
    viewport.send("keydown", { key: "Home" }, tool);
    viewport.send("touchstart", { touches: [{ clientY: 100 }] }, tool);
    viewport.send("touchmove", { touches: [{ clientY: 140 }] }, tool);
    viewport.send("touchmove", { touches: [{ clientY: 180 }] }, tool);
    viewport.send("scroll", {}, tool);
    const input = new Viewport();
    input.scrollHeight = 0;
    input.editable = true;
    viewport.send("keydown", { key: "Home" }, input);
    input.editable = false;
    input.control = true;
    viewport.send("keydown", { key: " ", shiftKey: true }, input);
    flush();
    assert.deepEqual(shown, ["current"]);
    viewport.send("touchstart", { touches: [{ clientY: 100 }] });
    viewport.send("touchmove", { touches: [{ clientY: 140 }] });
    flush();
    await settle();
    assert.deepEqual(shown, ["earlier", "current"]);
  });
});

test("scrollbar movement loads the reached edge and disposal cancels queued reads", async () => {
  await exercise(async ({ viewport, shown, flush, dispose }) => {
    viewport.send("pointerdown");
    viewport.scrollTop = 10;
    viewport.send("scroll");
    await settle();
    assert.deepEqual(shown, ["earlier", "current"]);
    viewport.send("wheel", { deltaY: -10 });
    dispose();
    flush();
    viewport.send("keydown", { key: "Home" });
    await settle();
    assert.deepEqual(shown, ["earlier", "current"]);
  });
});
