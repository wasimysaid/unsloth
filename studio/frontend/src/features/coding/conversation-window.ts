// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { type Range, defaultRangeExtractor } from "@tanstack/react-virtual";

/** Saved-conversation rows mounted past each edge of the visible ones. */
export const CONVERSATION_OVERSCAN = 8;

/**
 * The row a navigation key moves focus to, across every saved conversation
 * rather than only the mounted ones, or null for keys the list leaves alone.
 */
export function conversationKeyTarget(
  key: string,
  index: number,
  count: number,
  page: number,
): number | null {
  if (count === 0) return null;
  const last = count - 1;
  const step = Math.max(1, page);
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, last);
    case "ArrowUp":
      return Math.max(index - 1, 0);
    case "PageDown":
      return Math.min(index + step, last);
    case "PageUp":
      return Math.max(index - step, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * The virtualizer's window plus the focused row, in index order. Keeping the
 * focused row mounted while it is scrolled away keeps focus out of <body>.
 */
export function windowWithPinned(
  range: Range,
  pinned: number | undefined,
): number[] {
  const indexes = defaultRangeExtractor(range);
  if (pinned === undefined || pinned < 0 || pinned >= range.count) {
    return indexes;
  }
  const first = indexes[0];
  const last = indexes.at(-1);
  if (first === undefined || last === undefined) return [pinned];
  if (pinned < first) return [pinned, ...indexes];
  if (pinned > last) return [...indexes, pinned];
  return indexes;
}
