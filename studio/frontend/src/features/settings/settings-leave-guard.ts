// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * Asked before Settings closes or shows another page. The guard calls `leave` once leaving is safe
 * (at once, or after the user confirms discarding an edit), or never while a write is in flight.
 */
export type SettingsLeaveGuard = (leave: () => void) => void;

/**
 * Filled by the open panel, through the same `closeGuardRef` prop the Chat dialogs pass their
 * managers. One panel is mounted at a time, so one slot is enough.
 */
export const settingsLeaveGuardRef: { current: SettingsLeaveGuard | null } = { current: null };

export function leaveSettingsPanel(leave: () => void): void {
  const guard = settingsLeaveGuardRef.current;
  if (guard) guard(leave);
  else leave();
}
