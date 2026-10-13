// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type MaintenanceApi,
  createMaintenanceInspection,
} from "../src/features/coding/maintenance.ts";
import { loadWithStubs, stubJsxRuntime } from "./helpers/module-stubs.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Settings request cleanup does not clear the inspected target or unresolved reload on tab/modal remount", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const unmounts: Array<() => void> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval, clearInterval },
  });
  t.after(() => {
    for (const unmount of unmounts) unmount();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let requested: string | null = "a";
  const queries: Array<[string, string | undefined]> = [];
  let reloads = 0;
  const rowKeys: unknown[] = [];
  let view!: ReturnType<typeof createMaintenanceInspection>;
  const api: MaintenanceApi = {
    inspect(id, operationId) {
      queries.push([id, operationId]);
      return Promise.resolve({
        conversation_id: id,
        inventory: {
          session_id: id,
          frontend: "headless",
          session_live_available: true,
          runtime_live_available: true,
          plugins: (["session", "runtime"] as const).map((lifetime) => ({
            id: "changed-lifetime",
            name: "Changed lifetime",
            version: "1",
            lifetime,
            installed: lifetime === "session",
            selected: false,
            enabled: true,
            eligible: true,
            live: lifetime === "runtime",
            selected_frontend: lifetime === "runtime",
            mounted: lifetime === "runtime",
            pending: false,
            retained: false,
            load_failed: false,
            runtime_failed: false,
            missing_requirements: [],
            mount_id: lifetime === "runtime" ? "retained-mount" : null,
          })),
          omitted_plugins: 0,
          diagnostics: { catalog: 0, selection: 0, load: 0, runtime: 0 },
          reload: null,
        },
        skills: [],
        omitted_skills: 0,
      });
    },
    reload() {
      reloads++;
      return Promise.reject(new Error("lost acknowledgment"));
    },
  };
  let effects: Array<() => (() => void) | undefined> = [];
  const { MimirTab } = loadWithStubs<{ MimirTab: () => unknown }>(
    new URL("../src/features/settings/tabs/mimir-tab.tsx", import.meta.url),
    {
      "@/components/ui/button": { Button: "Button" },
      "@/features/coding/api": {
        codingApi: { listConversations: async () => [] },
        codingMaintenanceApi: api,
        readCodingDiagnostics: async () => null,
      },
      "@/features/coding/maintenance": {
        createMaintenanceInspection(value: MaintenanceApi) {
          view = createMaintenanceInspection(value);
          return view;
        },
      },
      "@/i18n": { useT: () => (key: string) => key },
      react: {
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => (() => void) | undefined) =>
          effects.push(effect),
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [initial, () => {}],
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
          snapshot(),
      },
      "../components/settings-section": { SettingsSection: "SettingsSection" },
      "../stores/settings-dialog-store": {
        useSettingsDialogStore: (selector: (state: unknown) => unknown) =>
          selector({ mimirConversationRequested: requested }),
      },
      "react/jsx-runtime": {
        ...stubJsxRuntime(),
        jsx(type: unknown, props: Record<string, unknown>, key: unknown) {
          if (type === "li") rowKeys.push(key);
          return { type, props };
        },
        jsxs(type: unknown, props: Record<string, unknown>, key: unknown) {
          if (type === "li") rowKeys.push(key);
          return { type, props };
        },
      },
    },
  );
  function mount() {
    effects = [];
    MimirTab();
    const cleanups = effects.map((effect) => effect());
    const unmount = () => {
      for (const cleanup of cleanups) cleanup?.();
    };
    unmounts.push(unmount);
    return unmount;
  }
  let unmount = mount();
  await tick();
  MimirTab();
  assert.deepEqual(
    rowKeys,
    ["changed-lifetime:session", "changed-lifetime:runtime"],
    "desired package and retained live owner must have separate React identities",
  );
  await view.reload("original-op");
  unmount();
  // The shared Settings store clears deep-open requests on tab change/close.
  requested = null;
  for (let remount = 0; remount < 2; remount++) {
    unmount = mount();
    await tick();
    assert.equal(view.getSnapshot().target, "a");
    assert.equal(view.getSnapshot().uncertainOperation, "original-op");
    assert.deepEqual(queries.at(-1), ["a", "original-op"]);
    await view.reload("unsafe-retry");
    assert.equal(reloads, 1);
    unmount();
  }
});
