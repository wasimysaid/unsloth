// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return (
    element !== null &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.matches(":disabled") &&
    element.closest("[inert]") === null
  );
}

/** The mobile sidebar invoker disappears when its sheet closes; use the page chooser then. */
export function restoreProjectPickerFocus(
  invoker: HTMLElement | null,
  chooser: HTMLElement | null,
): void {
  const target = canRestoreFocus(invoker)
    ? invoker
    : canRestoreFocus(chooser)
      ? chooser
      : null;
  target?.focus({ preventScroll: true });
}
