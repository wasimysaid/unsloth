// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Preview height: a screenful of plan above the decision, never the whole page. */
export function planPreviewLimit(viewportHeight: number): number {
  return Math.round(Math.max(200, Math.min(380, viewportHeight * 0.45)));
}
/** Don't fold away less than a few lines; show those plans whole. */
export const planPreviewSlack = 96;
export const planOverflows = (contentHeight: number, limit: number) =>
  contentHeight > limit + planPreviewSlack;
