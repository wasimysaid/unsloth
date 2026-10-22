// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { createViewNotifications } from "../src/features/coding/view-notifications.ts";

for (const delivery of ["frame", "hidden-document-timer"] as const) {
  test(`${delivery} publishes one latest snapshot and retires the other callback`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let frame: FrameRequestCallback | null = null;
    let cancelled = 0;
    const originals = ["requestAnimationFrame", "cancelAnimationFrame"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => {
        frame = null;
        cancelled++;
      },
    });
    t.after(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    });
    const notifications = createViewNotifications();
    let notificationsReceived = 0;
    const release = notifications.subscribe(() => notificationsReceived++);
    for (let n = 0; n < 5000; n++) notifications.notify(true);
    assert.equal(notificationsReceived, 0);
    if (delivery === "frame") (frame as FrameRequestCallback | null)?.(0);
    else t.mock.timers.tick(16);
    assert.equal(notificationsReceived, 1);
    assert.equal(cancelled, 1);
    assert.equal(frame, null);
    t.mock.timers.tick(16);
    assert.equal(notificationsReceived, 1);
    notifications.notify(true);
    notifications.notify();
    assert.equal(notificationsReceived, 2);
    t.mock.timers.tick(16);
    assert.equal(notificationsReceived, 2);
    notifications.notify(true);
    release();
    t.mock.timers.tick(16);
    assert.equal(notificationsReceived, 2);
    assert.equal(frame, null);
  });
}
