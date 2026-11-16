// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type * as Selector from "../src/features/coding/coding-model-selector.tsx";
import type { ComposerModelPickerSource } from "../src/components/assistant-ui/composer-model-picker/context.ts";
import * as selection from "../src/features/coding/model-selection.ts";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
} from "./helpers/module-stubs.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function mount(inventoryVersion = 0) {
  const states: unknown[] = [];
  let cursor = 0;
  let effect: (() => void | (() => void)) | undefined;
  let mounted = false;
  let inventoryChanged: (() => void) | undefined;
  const { CodingModelSelector } = loadWithStubs<typeof Selector>(
    new URL(
      "../src/features/coding/coding-model-selector.tsx",
      import.meta.url,
    ),
    {
      "@/features/hub/stores/inventory-events": {
        getInventoryVersion: () => inventoryVersion,
        subscribeInventory(callback: () => void) {
          inventoryChanged = callback;
          return () => {
            inventoryChanged = undefined;
          };
        },
      },
      react: {
        useRef(initial: unknown) {
          const index = cursor++;
          if (states.length <= index) states.push({ current: initial });
          return states[index];
        },
        useState(initial: unknown) {
          const index = cursor++;
          if (states.length <= index) states.push(initial);
          return [
            states[index],
            (next: unknown) => {
              states[index] =
                typeof next === "function" ? next(states[index]) : next;
            },
          ];
        },
        useEffect: (callback: () => void) => {
          if (!mounted) effect = callback;
        },
        useEffectEvent: (callback: unknown) => callback,
        useMemo: (callback: () => unknown) => callback(),
      },
      "react/jsx-runtime": stubJsxRuntime(),
      "@/components/assistant-ui/composer-model-picker/composer-model-picker": {
        ComposerModelPicker: "picker",
      },
      "@/components/assistant-ui/composer-model-picker/context": {
        ComposerModelPickerContext: { Provider: "provider" },
      },
      "@/components/ui/button": { Button: "button" },
      "lucide-react": { RefreshCw: "icon" },
      "./model-selection": selection,
    },
  );
  return {
    render(props: Parameters<typeof CodingModelSelector>[0]) {
      cursor = 0;
      const tree = CodingModelSelector(props) as unknown as StubElement;
      const children = tree.props.children as StubElement[];
      return {
        source: children[0].props.value as ComposerModelPickerSource,
        notice: children.at(-1),
      };
    },
    inventoryChanged() {
      inventoryChanged?.();
    },
    start() {
      mounted = true;
      return effect?.();
    },
  };
}

test("shared composer selection keeps exact native IDs, default effort, and failed selection", async () => {
  const view = mount();
  const calls: selection.CodingConfigurationChange[] = [];
  const props = {
    readCatalog: async () =>
      ["first", "second"].map((id) => ({
        id,
        name: id,
        models: [
          {
            id: "same",
            name: "Friendly model",
            api_model: "unrelated:api",
            reasoning: { levels: ["low", "high"] },
            default_reasoning: "low",
          },
        ],
      })),
    configuration: { provider: "first", model: "same", reasoning: "high" },
    disabled: false,
    configuring: false,
    configure: async (change: selection.CodingConfigurationChange) => {
      calls.push(change);
      throw new Error("Native refused selection");
    },
  };
  assert.equal(view.render(props).source.runtimeCatalog?.disabled, true);
  const cleanup = view.start();
  await tick();
  const source = view.render(props).source;
  assert.equal(source.runtimeCatalog?.models[0].name, "Friendly model");
  assert.deepEqual(source.runtimeCatalog?.reasoning.levels, ["low", "high"]);
  source.onPick(selection.modelIdentity("second", "same"), {
    source: "external",
    isLora: false,
  });
  await tick();
  assert.deepEqual(calls, [{ provider: "second", model: "same" }]);
  const after = view.render(props);
  assert.equal(
    after.source.selection?.id,
    selection.modelIdentity("first", "same"),
  );
  assert.ok(
    JSON.stringify(after.notice?.props.children).includes(
      "Native refused selection",
    ),
  );
  const blocked = view.render({ ...props, configuring: true }).source;
  blocked.runtimeCatalog?.reasoning.onChange("low");
  blocked.onPick(selection.modelIdentity("second", "same"), {
    source: "external",
    isLora: false,
  });
  assert.equal(calls.length, 1);
  if (typeof cleanup === "function") cleanup();
});

test("a late catalog response after disposal cannot populate the next folder", async () => {
  const view = mount();
  let resolve!: (value: selection.CodingProviderChoice[]) => void;
  const props = {
    readCatalog: () =>
      new Promise<selection.CodingProviderChoice[]>((done) => {
        resolve = done;
      }),
    configuration: null,
    disabled: false,
    configuring: false,
    configure: async () => {},
  };
  view.render(props);
  const cleanup = view.start();
  if (typeof cleanup === "function") cleanup();
  resolve([
    {
      id: "old",
      name: "Old",
      models: [
        {
          id: "model",
          name: "Old model",
          api_model: "old",
          reasoning: "unsupported",
          default_reasoning: null,
        },
      ],
    },
  ]);
  await tick();
  assert.deepEqual(view.render(props).source.runtimeCatalog?.models, []);
});

test("inventory changes coalesce behind reads and keep the prior choices usable", async () => {
  const view = mount();
  const requests: {
    refresh: boolean;
    resolve: (catalog: selection.CodingProviderChoice[]) => void;
  }[] = [];
  const catalog: selection.CodingProviderChoice[] = [
    {
      id: "studio-local",
      name: "On Device",
      models: [
        {
          id: "local-hash",
          name: "Friendly model",
          api_model: "repo:Q4",
          reasoning: "unsupported",
          default_reasoning: null,
        },
      ],
    },
  ];
  const props = {
    readCatalog: (refresh: boolean) =>
      new Promise<selection.CodingProviderChoice[]>((resolve) =>
        requests.push({ refresh, resolve }),
      ),
    configuration: {
      provider: "studio-local",
      model: "local-hash",
      reasoning: null,
    },
    disabled: false,
    configuring: false,
    configure: async () => {
      throw new Error("Inventory must not configure a model");
    },
  };
  const initial = view.render(props);
  assert.equal(initial.source.selection?.placeholder, "Select model");
  assert.equal(initial.notice, null);
  const cleanup = view.start();
  assert.equal(requests.length, 1);
  requests[0].resolve(catalog);
  await tick();
  view.inventoryChanged();
  view.inventoryChanged();
  view.inventoryChanged();
  assert.deepEqual(
    requests.map((request) => request.refresh),
    [false, true],
  );
  const refreshing = view.render(props);
  assert.equal(refreshing.source.runtimeCatalog?.disabled, false);
  assert.equal(
    refreshing.source.runtimeCatalog?.models[0].name,
    "Friendly model",
  );
  assert.equal(refreshing.notice, null);
  requests[1].resolve(catalog);
  await tick();
  assert.deepEqual(
    requests.map((request) => request.refresh),
    [false, true, true],
  );
  requests[2].resolve([]);
  await tick();
  assert.deepEqual(view.render(props).source.runtimeCatalog?.models, []);
  assert.equal(
    view.render(props).source.selection?.id,
    selection.modelIdentity("studio-local", "local-hash"),
  );
  if (typeof cleanup === "function") cleanup();
  view.inventoryChanged();
  assert.equal(requests.length, 3);
});

test("opening Coding after an inventory change reconciles retained native choices", async () => {
  const view = mount(1);
  const requests: boolean[] = [];
  const props = {
    readCatalog: async (refresh: boolean) => {
      requests.push(refresh);
      return [];
    },
    configuration: null,
    disabled: false,
    configuring: false,
    configure: async () => {
      throw new Error("Inventory must not configure a model");
    },
  };
  view.render(props);
  const cleanup = view.start();
  await tick();
  assert.deepEqual(requests, [true]);
  assert.equal(view.render(props).source.runtimeCatalog?.disabled, false);
  if (typeof cleanup === "function") cleanup();
});
