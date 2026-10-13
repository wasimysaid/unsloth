// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { KeyboardEvent } from "react";

/** Keep keyboard navigation inside a focused output, including at its edges.
 * Browser defaults otherwise chain Home/End and short-output scrolling to the
 * surrounding transcript. Links/controls inside semantic content keep their keys. */
export function boundedContentKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.target !== event.currentTarget ||
    event.altKey ||
    ((event.ctrlKey || event.metaKey) && !["Home", "End"].includes(event.key))
  ) {
    return;
  }
  const node = event.currentTarget;
  const vertical = Math.max(0, node.scrollHeight - node.clientHeight);
  const horizontal = Math.max(0, node.scrollWidth - node.clientWidth);
  const page = Math.max(24, node.clientHeight * 0.9);
  let top = node.scrollTop;
  let left = node.scrollLeft;
  switch (event.key) {
    case "ArrowUp":
      top -= 24;
      break;
    case "ArrowDown":
      top += 24;
      break;
    case "ArrowLeft":
      left -= 24;
      break;
    case "ArrowRight":
      left += 24;
      break;
    case "PageUp":
      top -= page;
      break;
    case "PageDown":
      top += page;
      break;
    case " ":
      top += event.shiftKey ? -page : page;
      break;
    case "Home":
      top = 0;
      break;
    case "End":
      top = vertical;
      break;
    default:
      return;
  }
  event.preventDefault();
  node.scrollTop = Math.max(0, Math.min(vertical, top));
  node.scrollLeft = Math.max(0, Math.min(horizontal, left));
}
