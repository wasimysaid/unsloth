// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Viewport geometry/focus only. No transcript copies or inferred unread counts. */
interface Anchor {
  key: string;
  top: number;
}
export interface ReadingState {
  away: boolean;
  newActivity: boolean;
}
const BOTTOM_SLOP = 48;

export function atTranscriptBottom(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    BOTTOM_SLOP
  );
}

export function createTranscriptReader(
  viewport: HTMLElement,
  content: HTMLElement,
  changed: (state: ReadingState) => void,
) {
  let following = true;
  let historicalWindow = false;
  let newActivity = false;
  let activityVersion: number | null = null;
  let anchors: Anchor[] = [];
  let scrollTop = viewport.scrollTop;
  let writtenTop: number | null = null;
  let readerScrollIntent = false;
  let focusKey: string | null = null;
  let lostFocus: Element | null = null;
  let restoringFocus = false;
  let frame = 0;
  let disposed = false;

  function elements() {
    const result = new Map<string, HTMLElement>();
    for (const row of content.querySelectorAll<HTMLElement>(
      "[data-reading-key]",
    )) {
      const key = row.dataset.readingKey;
      if (!key) continue;
      result.set(key, row);
      for (const [index, node] of Array.from(
        row.querySelectorAll<HTMLElement>(
          "summary, pre[tabindex], [data-reading-control]",
        ),
      ).entries()) {
        const owner =
          node.closest<HTMLElement>("[data-reading-owner]")?.dataset
            .readingOwner ?? "message";
        const path =
          node.closest<HTMLElement>("[data-path]")?.dataset.path ?? "";
        const identity =
          node.getAttribute("aria-label") ??
          node.dataset.readingControl ??
          (path || (owner !== "message" ? "control" : index));
        result.set(`${key}/${owner}/${path}/${node.tagName}:${identity}`, node);
      }
    }
    // Stable navigation controls may be outside a message row.
    for (const node of content.querySelectorAll<HTMLElement>(
      "[data-reading-control]",
    ))
      if (!node.closest("[data-reading-key]"))
        result.set(`navigation:${node.dataset.readingControl}`, node);
    return result;
  }
  const topOf = (element: HTMLElement) =>
    element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  const emit = () => changed({ away: !following, newActivity });
  function capture(preferred?: HTMLElement) {
    if (lostFocus?.isConnected && document.activeElement !== lostFocus) {
      focusKey = null;
      lostFocus = null;
    }
    if (!content.querySelector("[data-reading-key]")) return;
    const nodes = elements();
    const visible: Anchor[] = [];
    let preferredAnchor: Anchor | null = null;
    for (const [key, node] of nodes) {
      const top = topOf(node);
      if (node === preferred) preferredAnchor = { key, top };
      if (
        node.getClientRects().length &&
        top < viewport.clientHeight &&
        top + node.getBoundingClientRect().height > 0
      )
        visible.push({ key, top });
      if (node === document.activeElement) {
        focusKey = key;
        lostFocus = node;
      }
    }
    // Empty reconstruction must not erase the previous reading anchor/focus.
    if (visible.length) {
      const above = visible.filter((anchor) => anchor.top < 0);
      anchors = preferredAnchor
        ? [preferredAnchor, ...visible]
        : [...visible.filter((anchor) => anchor.top >= 0), ...above.reverse()];
      scrollTop = viewport.scrollTop;
    }
  }
  function write(top: number) {
    viewport.scrollTop = Math.max(0, top);
    writtenTop = viewport.scrollTop;
  }
  function restore() {
    if (disposed) return;
    const nodes = elements();
    if (!content.querySelector("[data-reading-key]")) return;
    let anchorRestored = true;
    if (following) write(viewport.scrollHeight);
    else {
      const anchor = anchors.find((anchor) => nodes.has(anchor.key));
      const target = anchor ? nodes.get(anchor.key) : null;
      write(
        anchor && target
          ? viewport.scrollTop + topOf(target) - anchor.top
          : scrollTop,
      );
      // Controls and assistant-ui rows can commit separately. Removing an
      // exhausted paging control can temporarily clamp scrollTop before the
      // prepended rows mount; do not checkpoint that intermediate geometry.
      anchorRestored =
        !anchor || !target || Math.abs(topOf(target) - anchor.top) < 1;
    }
    // Restore only focus that was actually lost with its row, not focus the user
    // moved to the composer, picker, inspector, Settings or another control.
    if (
      focusKey &&
      lostFocus &&
      !lostFocus.isConnected &&
      document.activeElement === document.body
    ) {
      const target = nodes.get(focusKey) ?? viewport;
      restoringFocus = true;
      try {
        target.focus({ preventScroll: true });
      } finally {
        restoringFocus = false;
      }
      lostFocus = target;
    }
    if (anchorRestored) capture();
  }
  function schedule() {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        restore();
      });
  }
  function onScroll(event: Event) {
    // Nested tool/diff scrolling does not change main transcript intent.
    if (event.target !== viewport) return;
    // Empty/temporarily short reconstruction causes browser scroll clamping,
    // not a reader request to resume bottom-follow or clear activity.
    const busy = viewport.getAttribute("aria-busy") === "true";
    if (
      !content.querySelector("[data-reading-key]") ||
      (busy && !readerScrollIntent)
    )
      return;
    if (writtenTop !== null && Math.abs(viewport.scrollTop - writtenTop) < 1) {
      writtenTop = null;
      return;
    }
    writtenTop = null;
    // Reader movement through retained busy content still updates anchors, but
    // temporary loading geometry can never admit following as a side effect.
    following = !busy && !historicalWindow && atTranscriptBottom(viewport);
    if (following) newActivity = false;
    capture();
    emit();
  }
  function onClick(event: Event) {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("summary, [data-reading-control]")
        : null;
    if (!target || !viewport.contains(target)) return;
    // Expanding/collapsing is a reading request, not a request to follow growth.
    following = false;
    capture(target);
    emit();
  }
  function onFocus(event: FocusEvent) {
    if (!restoringFocus && event.target instanceof HTMLElement)
      capture(event.target);
  }
  function onIntent(event: Event) {
    if (
      event instanceof KeyboardEvent &&
      (![
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key) ||
        (event.target instanceof Element &&
          (event.target.closest("input, textarea, [contenteditable='true']") ||
            (event.key === " " && event.target.closest("button, summary")))))
    )
      return;
    if (event.type === "pointerdown" && event.target !== viewport) return;
    // Explicit gestures remain reading intent even while a bounded page loads.
    writtenTop = null;
    readerScrollIntent = true;
  }
  function onScrollEnd() {
    readerScrollIntent = false;
  }
  viewport.addEventListener("scroll", onScroll);
  viewport.addEventListener("click", onClick, true);
  viewport.addEventListener("focusin", onFocus);
  viewport.addEventListener("wheel", onIntent, { passive: true });
  viewport.addEventListener("touchstart", onIntent, { passive: true });
  viewport.addEventListener("keydown", onIntent);
  viewport.addEventListener("pointerdown", onIntent);
  viewport.addEventListener("scrollend", onScrollEnd);
  const mutations = new MutationObserver(schedule);
  mutations.observe(content, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  const sizes = new ResizeObserver(schedule);
  sizes.observe(content);
  sizes.observe(viewport);
  capture();
  return {
    get following() {
      return following;
    },
    restore,
    pause() {
      following = false;
      capture();
      emit();
    },
    activity(version: number, viewingEarlier = false) {
      historicalWindow = viewingEarlier;
      if (historicalWindow) following = false;
      if (activityVersion !== null && version !== activityVersion && !following)
        newActivity = true;
      activityVersion = version;
      emit();
    },
    jump() {
      historicalWindow = false;
      following = true;
      newActivity = false;
      write(viewport.scrollHeight);
      viewport.focus({ preventScroll: true });
      capture();
      emit();
      schedule();
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("click", onClick, true);
      viewport.removeEventListener("focusin", onFocus);
      viewport.removeEventListener("wheel", onIntent);
      viewport.removeEventListener("touchstart", onIntent);
      viewport.removeEventListener("keydown", onIntent);
      viewport.removeEventListener("pointerdown", onIntent);
      viewport.removeEventListener("scrollend", onScrollEnd);
    },
  };
}
export type TranscriptReader = ReturnType<typeof createTranscriptReader>;
