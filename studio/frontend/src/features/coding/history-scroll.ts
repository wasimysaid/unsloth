// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export type HistoryDirection = "before" | "after";

export interface HistoryScrollState {
  before: boolean;
  after: boolean;
  ready: boolean;
  busy: boolean;
  error: boolean;
}

const EDGE_DISTANCE = 96;

/** Only reader gestures can page. Mounts, resizes and restored anchors cannot. */
export function createHistoryScroll(
  viewport: HTMLElement,
  snapshot: () => HistoryScrollState,
  load: (direction: HistoryDirection) => Promise<void>,
) {
  let intent: HistoryDirection | "pointer" | null = null;
  let pending = false;
  let failed = false;
  let disposed = false;
  let frame = 0;
  let top = viewport.scrollTop;
  let touchY: number | null = null;

  async function request(direction: HistoryDirection, explicit = false) {
    const state = snapshot();
    if (
      disposed ||
      pending ||
      state.busy ||
      !state.ready ||
      !state[direction] ||
      (!explicit && (failed || state.error))
    )
      return;
    pending = true;
    intent = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    try {
      await load(direction);
      failed = false;
    } catch {
      failed = true;
    } finally {
      pending = false;
      intent = null;
      top = viewport.scrollTop;
    }
  }

  function check(direction = intent) {
    if (direction === "before" && viewport.scrollTop <= EDGE_DISTANCE)
      void request("before");
    else if (
      direction === "after" &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        EDGE_DISTANCE
    )
      void request("after");
  }

  function engage(direction: HistoryDirection) {
    if (pending || disposed) return;
    intent = direction;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      // A previous anchor restoration can emit scrollend after this input.
      check(direction);
    });
  }

  function nested(event: Event) {
    let node = event.target instanceof HTMLElement ? event.target : null;
    while (node && node !== viewport) {
      if (
        node.clientHeight > 0 &&
        node.scrollHeight > node.clientHeight &&
        /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)
      )
        return true;
      node = node.parentElement;
    }
    return false;
  }

  function onWheel(event: WheelEvent) {
    if (event.defaultPrevented || !event.deltaY || nested(event)) return;
    engage(event.deltaY < 0 ? "before" : "after");
  }

  function onKey(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.metaKey ||
      nested(event) ||
      (event.target instanceof Element &&
        event.target.closest("input, textarea, [contenteditable='true']"))
    )
      return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) engage("before");
    else if (["ArrowDown", "PageDown", "End"].includes(event.key))
      engage("after");
    else if (
      event.key === " " &&
      !(
        event.target instanceof Element &&
        event.target.closest("button, summary")
      )
    )
      engage(event.shiftKey ? "before" : "after");
  }

  function onTouchStart(event: TouchEvent) {
    touchY = nested(event) ? null : (event.touches[0]?.clientY ?? null);
  }

  function onTouchMove(event: TouchEvent) {
    if (touchY === null) return;
    const next = event.touches[0]?.clientY;
    if (next !== undefined && next !== touchY)
      engage(next > touchY ? "before" : "after");
    touchY = next ?? null;
  }

  function onPointer(event: PointerEvent) {
    if (!pending && event.target === viewport) intent = "pointer";
  }

  function onScroll(event: Event) {
    if (event.target !== viewport) return;
    const next = viewport.scrollTop;
    if (intent === "pointer" && next !== top)
      intent = next < top ? "before" : "after";
    const movingTowardEdge =
      (intent === "before" && next < top) || (intent === "after" && next > top);
    top = next;
    if (movingTowardEdge) check();
  }

  function onScrollEnd(event: Event) {
    if (event.target !== viewport) return;
    // Smooth keyboard scrolling can finish before its final scroll event.
    check();
    intent = null;
  }

  viewport.addEventListener("wheel", onWheel, { passive: true });
  viewport.addEventListener("keydown", onKey);
  viewport.addEventListener("touchstart", onTouchStart, { passive: true });
  viewport.addEventListener("touchmove", onTouchMove, { passive: true });
  viewport.addEventListener("pointerdown", onPointer);
  viewport.addEventListener("scroll", onScroll);
  viewport.addEventListener("scrollend", onScrollEnd);

  return {
    retry: (direction: HistoryDirection) => request(direction, true),
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKey);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("pointerdown", onPointer);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("scrollend", onScrollEnd);
    },
  };
}

export type HistoryScroll = ReturnType<typeof createHistoryScroll>;
