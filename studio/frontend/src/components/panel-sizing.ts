// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export function panelDefaultSize(width: number): string {
  if (width <= 0) return "50%";
  return `${Math.min(50, Math.max(30, (540 / width) * 100))}%`;
}
