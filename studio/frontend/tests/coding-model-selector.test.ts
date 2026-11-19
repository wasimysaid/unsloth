// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type * as Selector from "../src/features/coding/coding-model-selector.tsx";
import type { ComposerModelPickerSource } from "../src/components/assistant-ui/composer-model-picker/context.ts";
import * as downloadStaging from "../src/features/chat/utils/model-download-staging.ts";
import * as selection from "../src/features/coding/model-selection.ts";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
} from "./helpers/module-stubs.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type LocalModel = { id: string; group: string; quant: string | null; name: string };
type LocalStub = {
  models: LocalModel[];
  residency: { state: string };
  status?: Partial<import("../src/features/chat/types/api.ts").InferenceStatusResponse>;
  loadedModels?: { id: string; checkpoint?: string; quant?: string | null }[];
  unloadAll?: () => Promise<void>;
  refresh?: (signal: AbortSignal) => Promise<LocalModel[]>;
  preload: (id: string) => void;
  unload: () => Promise<void>;
};
function mount(inventoryVersion = 0, local: LocalStub = { models: [], residency: { state: "unloaded" }, preload: () => {}, unload: async () => {} }) {
  const states: unknown[] = [];
  let cursor = 0;
  const effects: (() => void | (() => void))[] = [];
  let mounted = false;
  let inventoryChanged: (() => void) | undefined;
  let download!: Parameters<typeof import("../src/features/model-picker/use-load-after-download.ts").useLoadAfterDownload>;
  const { CodingModelSelector } = loadWithStubs<typeof Selector>(
    new URL(
      "../src/features/coding/coding-model-selector.tsx",
      import.meta.url,
    ),
    {
      "@/features/hub": {
        getInventoryVersion: () => inventoryVersion,
        subscribeInventory(callback: () => void) {
          inventoryChanged = callback;
          return () => {
            inventoryChanged = undefined;
          };
        },
      },
      "react-dom": { createPortal: () => null },
      "@/features/model-picker": { SidebarModelConfig: "sidebar-config", RunSettingsPanel: "settings-panel", RunSettingsToggle: "settings-toggle", RunSettingsSection: "settings-section", residentModelConfig: () => null, useLoadAfterDownload: (...args: typeof download) => { download = args; } },
      react: {
        useContext: (context: { initial: unknown }) => context.initial,
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
          if (!mounted) effects.push(callback);
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
      "./coding-layout-context": { CodingLayoutHosts: { initial: { settingsPanel: null, settingsTrigger: null, contextUsage: null } } },
      "./model-selection": selection,
      "./use-local-model": { useLocalModel: () => ({ loadedModels: [], unloading: false, unloadAll: async () => {}, ...local, refresh: local.refresh ?? (async () => local.models) }) },
      "@/features/chat": { ...downloadStaging, listModels: async () => ({ models: [{ id: "org/fallback", name: "Fallback", is_gguf: true }] }) },
    },
  );
  return {
    render(props: Parameters<typeof CodingModelSelector>[0]) {
      cursor = 0;
      const tree = CodingModelSelector(props) as unknown as StubElement;
      const children = tree.props.children as StubElement[];
      return {
        source: children.find((child) => child && child.type === "provider")!.props.value as ComposerModelPickerSource,
        notice: children.at(-1),
      };
    },
    download: () => download,
    inventoryChanged() {
      inventoryChanged?.();
    },
    start() {
      mounted = true;
      const cleanups = effects.map((effect) => effect());
      return () => { for (const cleanup of cleanups) cleanup?.(); };
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
  assert.equal(view.render(props).source.runtimeControls?.disabled, true);
  const cleanup = view.start();
  await tick();
  const source = view.render(props).source;
  assert.equal(source.externalModels[0].name, "Friendly model");
  assert.deepEqual(source.runtimeControls?.reasoning.levels, ["low", "high"]);
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
  blocked.runtimeControls?.reasoning.onChange("low");
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
  assert.deepEqual(view.render(props).source.externalModels, []);
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
  assert.equal(refreshing.source.runtimeControls?.disabled, false);
  assert.equal(
    refreshing.source.selection?.placeholder,
    "Select model",
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
  assert.deepEqual(view.render(props).source.externalModels, []);
  assert.equal(
    view.render(props).source.selection?.id,
    "",
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
  assert.equal(view.render(props).source.runtimeControls?.disabled, false);
  if (typeof cleanup === "function") cleanup();
});

test("shared controls select exact inventory quant IDs and retain false preserve without awaiting preload", async () => {
  const preloads: string[] = [];
  let unloaded = 0;
  const view = mount(0, {
    models: ["Q4", "BF16"].map((quant) => ({ id: `exact-${quant}`, group: "repo", quant, name: quant })),
    residency: { state: "loaded" },
    preload: (id) => { preloads.push(id); },
    unload: async () => { unloaded++; },
  });
  const changes: selection.CodingConfigurationChange[] = [];
  const props = {
    readCatalog: async (): Promise<selection.CodingProviderChoice[]> => [{
      id: "studio-local", name: "On Device", models: ["Q4", "BF16"].map((quant) => ({
        id: `exact-${quant}`, name: quant, api_model: "unrelated-no-parsing",
        reasoning: "unsupported", default_reasoning: null, preserve_thinking: true,
      })),
    }],
    configuration: { provider: "studio-local", model: "exact-Q4", reasoning: null, preserve_thinking: false },
    disabled: false, configuring: false,
    configure: async (change: selection.CodingConfigurationChange) => { changes.push(change); },
  };
  view.render(props); view.start(); await tick();
  const source = view.render(props).source;
  assert.equal(source.selection?.loaded, true);
  assert.equal(source.runtimeControls?.preserveThinking?.value, false);
  assert.equal(source.selection?.id, "repo");
  assert.equal(source.selection?.ggufVariant, "Q4");
  source.onPick("repo", { source: "hub", isLora: false, isDownloaded: true, ggufVariant: "BF16" }); await tick();
  assert.deepEqual(changes, [{ provider: "studio-local", model: "exact-BF16" }]);
  assert.deepEqual(preloads, ["exact-BF16"]);
  view.render(props).source.runtimeControls?.preserveThinking?.onChange(false); await tick();
  assert.deepEqual(changes[1], { preserve_thinking: false });
  source.eject(); await tick(); assert.equal(unloaded, 1);
  assert.equal(view.render(props).source.runtimeControls?.disabled, false);
});

test("native preparation shows loading only for the selected local model without blocking selection", async () => {
  const view = mount();
  const props: Parameters<typeof Selector.CodingModelSelector>[0] = {
    readCatalog: async () => [],
    configuration: { provider: "studio-local", model: "a", reasoning: null },
    disabled: false,
    configuring: false,
    configure: async () => {},
  };
  view.render(props);
  view.start();
  await tick();
  const preparing = { provider: "studio-local", model: "a" };
  const same = view.render({ ...props, preparing }).source;
  assert.equal(same.selection?.operation, "loading");
  assert.equal(same.runtimeControls?.disabled, false);
  assert.equal(view.render({ ...props, preparing: { ...preparing, model: "b" } }).source.selection?.operation, undefined);
});

function localProps(configure: (change: selection.CodingConfigurationChange) => Promise<void>) {
  return {
    readCatalog: async (): Promise<selection.CodingProviderChoice[]> => [{
      id: "studio-local", name: "On Device", models: ["Q4", "Q8"].map((quant) => ({
        id: `exact-${quant}`, name: quant, api_model: "repo", reasoning: "unsupported", default_reasoning: null,
      })),
    }],
    configuration: { provider: "studio-local", model: "exact-Q4", reasoning: null },
    disabled: false, configuring: false, configure,
  };
}
const downloadedModels = ["Q4", "Q8"].map((quant) => ({ id: `exact-${quant}`, group: "repo", quant, name: quant }));
const localMeta = { source: "hub" as const, isLora: false, isDownloaded: true, ggufVariant: "Q8" };

test("local picker clears unloaded selections and restores controls only while loading or loaded", async () => {
  const preloads: string[] = [];
  const local: LocalStub = {
    models: downloadedModels,
    residency: { state: "unloaded" },
    preload: (id) => { preloads.push(id); },
    unload: async () => { local.residency.state = "unloaded"; },
  };
  const view = mount(0, local);
  const props = localProps(async () => {});
  view.render(props);
  const cleanup = view.start();
  await tick();
  const source = view.render(props).source;
  assert.equal(source.selection?.id, "");
  assert.equal(source.selection?.placeholder, "Select model");
  assert.equal(source.runtimeControls?.reasoning.value, "");
  assert.equal(source.runtimeControls?.preserveThinking, undefined);
  assert.equal(source.selection?.ggufVariant, null);
  assert.equal(source.selection?.loaded, false);
  assert.equal(source.loaded, false);
  assert.deepEqual(preloads, []);
  source.onPick("repo", { ...localMeta, ggufVariant: "Q4" });
  await tick();
  assert.deepEqual(preloads, ["exact-Q4"]);
  local.residency.state = "loading";
  assert.equal(view.render(props).source.selection?.id, "repo");
  assert.equal(view.render(props).source.selection?.ggufVariant, "Q4");
  assert.equal(view.render(props).source.selection?.operation, "loading");
  assert.equal(view.render(props).source.selection?.loaded, false);
  local.residency.state = "loaded";
  const resident = view.render(props).source;
  assert.equal(resident.selection?.loaded, true);
  resident.eject("repo");
  await tick();
  assert.equal(view.render(props).source.selection?.loaded, false);
  assert.equal(view.render(props).source.selection?.id, "");
  assert.equal(view.render(props).source.selection?.placeholder, "Select model");
  if (typeof cleanup === "function") cleanup();
});

test("cached model selection configures immediately and unload rejects a different model", async () => {
  let refreshes = 0;
  let unloads = 0;
  const changes: selection.CodingConfigurationChange[] = [];
  const view = mount(0, { models: downloadedModels, residency: { state: "loaded" }, refresh: async () => { refreshes++; return downloadedModels; }, preload: () => {}, unload: async () => { unloads++; } });
  const props = localProps(async (change) => { changes.push(change); });
  view.render(props); view.start(); await tick();
  const source = view.render(props).source;
  source.onPick("repo", localMeta);
  assert.deepEqual(changes, [{ provider: "studio-local", model: "exact-Q8" }]);
  assert.equal(refreshes, 0);
  source.eject("another-repo");
  assert.equal(unloads, 0);
  source.eject("repo");
  assert.equal(unloads, 1);
});

test("download completion cannot replace a newer pick before React renders it", async () => {
  const changes: selection.CodingConfigurationChange[] = [];
  const view = mount(0, { models: downloadedModels, residency: { state: "loaded" }, preload: () => {}, unload: async () => {} });
  const props = localProps(async (change) => { changes.push(change); });
  view.render(props); view.start(); await tick();
  view.render(props).source.onPick("remote", { ...localMeta, isDownloaded: false });
  const source = view.render(props).source;
  const pending = view.download()[0];
  const complete = view.download()[3];
  assert.equal(pending?.id, "remote");
  assert.equal(pending?.isCurrent?.(), true);
  source.onPick("repo", localMeta);
  assert.equal(pending?.isCurrent?.(), false);
  complete("remote", localMeta);
  await tick();
  assert.deepEqual(changes, [{ provider: "studio-local", model: "exact-Q8" }]);
});

test("download completion is discarded after native configuration changes", async () => {
  const changes: selection.CodingConfigurationChange[] = [];
  const view = mount(0, { models: downloadedModels, residency: { state: "loaded" }, preload: () => {}, unload: async () => {} });
  const props = localProps(async (change) => { changes.push(change); });
  view.render(props); view.start(); await tick();
  view.render(props).source.onPick("remote", { ...localMeta, isDownloaded: false });
  view.render(props);
  const complete = view.download()[3];
  view.render({ ...props, configuration: { ...props.configuration, model: "exact-Q8" } });
  complete("remote", localMeta);
  await tick();
  assert.deepEqual(changes, []);
});

test("newly downloaded choices refresh native catalog before configuration", async () => {
  const order: string[] = [];
  const view = mount(0, { models: [], residency: { state: "unloaded" }, refresh: async () => { order.push("inventory"); return downloadedModels; }, preload: () => { order.push("preload"); }, unload: async () => {} });
  const props = localProps(async () => { order.push("configure"); });
  const read = props.readCatalog;
  props.readCatalog = async () => { order.push("catalog"); return read(); };
  view.render(props); view.start(); await tick();
  order.length = 0;
  view.render(props).source.onPick("repo", localMeta);
  await tick();
  assert.deepEqual(order, ["inventory", "catalog", "configure", "preload"]);
});

test("a connected model sharing a native local ID remains a connected identity", async () => {
  const view = mount(0, { models: downloadedModels, residency: { state: "loaded" }, preload: () => {}, unload: async () => {} });
  const props = { ...localProps(async () => {}), configuration: { provider: "connected", model: "exact-Q4", reasoning: null } };
  view.render(props); view.start(); await tick();
  const source = view.render(props).source;
  assert.equal(source.selection?.id, selection.modelIdentity("connected", "exact-Q4"));
  assert.equal(source.selection?.ggufVariant, null);
  assert.equal(source.selection?.loaded, false);
});

test("an inventory lookup cannot replace native configuration changed while it waited", async () => {
  let resolve!: (models: LocalModel[]) => void;
  const changes: selection.CodingConfigurationChange[] = [];
  const view = mount(0, { models: [], residency: { state: "unloaded" }, refresh: () => new Promise((done) => { resolve = done; }), preload: () => {}, unload: async () => {} });
  const props = localProps(async (change) => { changes.push(change); });
  view.render(props); view.start(); await tick();
  view.render(props).source.onPick("repo", localMeta);
  view.render({ ...props, configuration: { ...props.configuration, model: "exact-Q8" } });
  resolve(downloadedModels);
  await tick();
  assert.deepEqual(changes, []);
});

test("a restored local selection never exposes its native ID while inventory is loading", async () => {
  const view = mount();
  const props = localProps(async () => {});
  const first = view.render(props).source;
  assert.equal(first.selection?.id, "");
  assert.equal(first.selection?.placeholder, "Select model");
  view.start(); await tick();
  const catalogReady = view.render(props).source;
  assert.equal(catalogReady.selection?.id, "");
  assert.equal(catalogReady.selection?.placeholder, "Select model");
});

test("Coding supplies the server Discover fallback without changing Chat selection", async () => {
  const view = mount();
  const props = localProps(async () => {});
  view.render(props); view.start(); await tick();
  assert.deepEqual(view.render(props).source.models, [{ id: "org/fallback", name: "Fallback", isGguf: true }]);
});

test("shared picker receives every resident and ejects a non-selected model or all models", async () => {
  const targets: (string | undefined)[] = [];
  let all = 0;
  const residents = [
    { id: "repo", checkpoint: "repo", quant: "Q4" },
    { id: "other", checkpoint: "/models/other.gguf", quant: "Q8" },
  ];
  const view = mount(0, {
    models: downloadedModels,
    loadedModels: residents,
    residency: { state: "loaded" },
    preload: () => {},
    unload: async (id?: string) => { targets.push(id); },
    unloadAll: async () => { all++; },
  });
  const props = localProps(async () => {});
  view.render(props); view.start(); await tick();
  const source = view.render(props).source;
  assert.deepEqual(source.loadedModels, residents);
  assert.equal(source.deleteDisabled, false);
  source.eject("/models/other.gguf");
  source.eject();
  source.eject("missing");
  await tick();
  assert.deepEqual(targets, ["/models/other.gguf", undefined]);
  source.ejectAll(); await tick();
  assert.equal(all, 1);
});

test("toggle-only thinking and preserve thinking use the same coupled controls as Chat", async () => {
  const changes: selection.CodingConfigurationChange[] = [];
  const view = mount(0, {
    models: downloadedModels, residency: { state: "loaded" },
    status: { supports_reasoning: true, reasoning_style: "enable_thinking", reasoning_always_on: false },
    preload: () => {}, unload: async () => {},
  });
  const props = { ...localProps(async (change) => { changes.push(change); }),
    readCatalog: async (): Promise<selection.CodingProviderChoice[]> => [{
      id: "studio-local", name: "Local", models: [{ id: "exact-Q4", name: "Q4", api_model: "repo",
        default_reasoning: "high", reasoning: { levels: ["off", "high"] }, preserve_thinking: true }],
    }],
  };
  view.render(props); view.start(); await tick();
  const controls = view.render(props).source.runtimeControls;
  assert.deepEqual(controls?.reasoning.levels, []);
  assert.equal(controls?.reasoning.thinking?.enabled, true);
  controls?.reasoning.thinking?.onChange(false); await tick();
  assert.deepEqual(changes[0], { reasoning: "off", preserve_thinking: false });
  const off = view.render({ ...props, configuration: { ...props.configuration, reasoning: "off" } }).source.runtimeControls;
  assert.equal(off?.reasoning.thinking?.enabled, false);
  off?.preserveThinking?.onChange(true); await tick();
  assert.deepEqual(changes[1], { preserve_thinking: true, reasoning: "high" });
});

test("selecting an already resident quant configures Mimir without another load", async () => {
  const preloads: string[] = [];
  const changes: selection.CodingConfigurationChange[] = [];
  const view = mount(0, {
    models: downloadedModels, loadedModels: [{ id: "repo", checkpoint: "repo", quant: "Q8" }],
    residency: { state: "unloaded" }, preload: (id) => { preloads.push(id); }, unload: async () => {},
  });
  const props = localProps(async (change) => { changes.push(change); });
  view.render(props); view.start(); await tick();
  view.render(props).source.onPick("repo", localMeta); await tick();
  assert.deepEqual(changes, [{ provider: "studio-local", model: "exact-Q8" }]);
  assert.deepEqual(preloads, []);
  view.render(props).source.onPick("repo", { ...localMeta, forceReload: true }); await tick();
  assert.deepEqual(preloads, ["exact-Q8"]);
});
