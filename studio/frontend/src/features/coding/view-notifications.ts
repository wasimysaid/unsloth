// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** State is already current. Only subscribers' render work waits for a frame. */
export function createViewNotifications() {
  const listeners = new Set<() => void>();
  let pending: (() => void) | null = null;
  const cancel = () => {
    pending?.();
    pending = null;
  };
  const flush = () => {
    cancel();
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) cancel();
      };
    },
    notify(deferred = false) {
      if (!deferred) {
        flush();
        return;
      }
      if (pending || !listeners.size) return;
      const frame =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(flush)
          : null;
      // Hidden documents may suspend animation frames, but not state delivery.
      const timer = setTimeout(flush, 16);
      pending = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        clearTimeout(timer);
      };
    },
  };
}
