// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export interface AnswerFocusIntent {
  current: string | null;
}

/** Revoke a deferred handoff even after the original controls have unmounted. */
export function watchAnswerFocus(
  intent: AnswerFocusIntent,
  document: EventTarget & { body: EventTarget },
  window: EventTarget,
) {
  const revoke = () => {
    intent.current = null;
  };
  const focus = (event: Event) => {
    // Disabled/removed controls can leave focus on body without user intent.
    if (event.target !== document.body) revoke();
  };
  document.addEventListener("pointerdown", revoke, true);
  document.addEventListener("focusin", focus, true);
  window.addEventListener("blur", revoke);
  return () => {
    document.removeEventListener("pointerdown", revoke, true);
    document.removeEventListener("focusin", focus, true);
    window.removeEventListener("blur", revoke);
    revoke();
  };
}

export function restoreAnswerFocus(
  intent: AnswerFocusIntent,
  questionId: string,
  element: Pick<HTMLElement, "focus"> | null,
  activeElement: EventTarget | null,
  body: EventTarget,
) {
  if (intent.current !== questionId) return false;
  intent.current = null;
  if (activeElement !== body || !element) return false;
  element.focus();
  return true;
}
