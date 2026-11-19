// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  SidebarModelConfig,
  RunSettingsPanel,
  RunSettingsToggle,
  RunSettingsSection,
  residentModelConfig,
  type PendingModelDownload,
  useLoadAfterDownload,
} from "@/features/model-picker";
import type { LocalModelLoadOptions } from "./local-model-preload";
import { ComposerModelPicker } from "@/components/assistant-ui/composer-model-picker/composer-model-picker";
import {
  ComposerModelPickerContext,
  type ComposerModelPickerSource,
} from "@/components/assistant-ui/composer-model-picker/context";
import { getInventoryVersion, subscribeInventory } from "@/features/hub";
import { Button } from "@/components/ui/button";
import { listModels, wantsDownloadManagerStaging } from "@/features/chat";
import type {
  ModelOption,
  ModelSelectorChangeMeta,
} from "@/features/model-picker";
import { CodingLayoutHosts } from "./coding-layout-context";
import { useLocalModel } from "./use-local-model";
import {
  codingSelectionCatalog,
  findCodingModel,
  findLocalPickerChoice,
  findResidentLocalChoice,
  modelIdentity,
} from "./model-selection";
import type {
  CodingConfiguration,
  CodingConfigurationChange,
  CodingProviderChoice,
} from "./model-selection";

export function CodingModelSelector({
  readCatalog,
  configuration,
  unavailable,
  preparing,
  disabled,
  configuring,
  configure,
}: {
  readCatalog: (
    refresh: boolean,
    signal: AbortSignal,
  ) => Promise<CodingProviderChoice[]>;
  configuration: Pick<
    CodingConfiguration,
    "provider" | "model" | "reasoning" | "preserve_thinking"
  > | null;
  unavailable?: string | null;
  preparing?: Pick<CodingConfiguration, "provider" | "model"> | null;
  disabled: boolean;
  configuring: boolean;
  configure: (change: CodingConfigurationChange) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hosts = useContext(CodingLayoutHosts);
  const [discoverModels, setDiscoverModels] = useState<ModelOption[]>([]);
  const [pendingDownload, setPendingDownload] =
    useState<PendingModelDownload | null>(null);
  const intent = useRef(0);
  const currentConfiguration = useRef(configuration);
  currentConfiguration.current = configuration;
  const lifetime = useRef<AbortController | null>(null);
  const requestCatalog = useRef<(refresh: boolean) => void>(() => {});
  const [result, setResult] = useState<{
    catalog: CodingProviderChoice[];
    loading: boolean;
    ready: boolean;
    error: string | null;
  }>({ catalog: [], loading: true, ready: false, error: null });
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const read = useRef(readCatalog);
  read.current = readCatalog;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void listModels(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setDiscoverModels(
            response.models.map((model) => ({
              id: model.id,
              name: model.name || model.id,
              isGguf: model.is_gguf,
            })),
          );
        }
      })
      .catch(() => {});
    let pending: boolean | null = null;
    let running = false;
    async function drain() {
      if (running) return;
      running = true;
      while (pending !== null && !controller.signal.aborted) {
        const refresh = pending;
        pending = null;
        setResult((previous) => ({ ...previous, loading: true }));
        try {
          const catalog = await read.current(refresh, controller.signal);
          if (!controller.signal.aborted)
            setResult({
              catalog,
              loading: pending !== null,
              ready: true,
              error: null,
            });
        } catch (reason) {
          if (!controller.signal.aborted)
            setResult((previous) => ({
              ...previous,
              loading: pending !== null,
              error:
                reason instanceof Error
                  ? reason.message
                  : "Models could not be loaded.",
            }));
        }
      }
      running = false;
    }
    const request = (refresh: boolean) => {
      if (controller.signal.aborted) return;
      pending = pending === true || refresh;
      void drain();
    };
    requestCatalog.current = request;
    const unsubscribe = subscribeInventory(() => request(true));
    request(getInventoryVersion() > 0);
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, []);
  const selectionCatalog = useMemo(
    () => codingSelectionCatalog(result.catalog),
    [result.catalog],
  );
  const models = useMemo(
    () =>
      [...selectionCatalog.values()].filter(
        (choice) => choice.provider !== "studio-local",
      ),
    [selectionCatalog],
  );
  const selected = findCodingModel(result.catalog, configuration);
  const local = useLocalModel(
    configuration?.provider === "studio-local" ? configuration.model : null,
    () => requestCatalog.current(true),
  );
  const localChoice =
    configuration?.provider === "studio-local"
      ? local.models.find((model) => model.id === configuration.model)
      : undefined;
  const localLoading =
    local.residency.state === "loading" ||
    (local.residency.state !== "loaded" &&
      preparing?.provider === "studio-local" &&
      preparing.provider === configuration?.provider &&
      preparing.model === configuration?.model);
  const localLoaded =
    configuration?.provider === "studio-local" &&
    Boolean(localChoice) &&
    local.residency.state === "loaded";
  // Session configuration can survive an unload; the picker follows residency.
  const pickerSelected =
    configuration?.provider === "studio-local" && !localLoaded && !localLoading
      ? undefined
      : selected;
  const preserveDefault = pickerSelected?.model.preserve_thinking;
  const identity =
    configuration?.provider === "studio-local"
      ? localLoaded || localLoading
        ? localChoice?.group
        : undefined
      : configuration?.provider && configuration.model
        ? modelIdentity(configuration.provider, configuration.model)
        : undefined;
  const levels =
    pickerSelected && pickerSelected.model.reasoning !== "unsupported"
      ? pickerSelected.model.reasoning.levels
      : [];
  const reasoningValue = pickerSelected
    ? (configuration?.reasoning ?? pickerSelected.model.default_reasoning ?? "")
    : "";
  const reasoningOn =
    (pickerSelected?.model.default_reasoning !== "off"
      ? pickerSelected?.model.default_reasoning
      : null) ?? levels.find((value) => value !== "off");
  const thinkingToggle = Boolean(
    localLoaded &&
      local.status?.supports_reasoning &&
      (local.status.reasoning_always_on ||
        local.status.reasoning_style === "enable_thinking"),
  );
  const loading = result.loading;
  const blocked =
    disabled || configuring || applying || (loading && !result.ready);
  const adoptedResident = useRef<string | null>(null);
  useEffect(() => {
    if (
      blocked ||
      !result.ready ||
      local.residency.state !== "unloaded" ||
      localLoading ||
      local.unloading ||
      (configuration?.provider && configuration.provider !== "studio-local")
    )
      return;
    const choice = findResidentLocalChoice(local.models, local.loadedModels);
    if (!choice) {
      adoptedResident.current = null;
      return;
    }
    if (
      !findCodingModel(result.catalog, {
        provider: "studio-local",
        model: choice.id,
      }) ||
      choice.id === configuration?.model ||
      adoptedResident.current === choice.id
    )
      return;
    adoptedResident.current = choice.id;
    void configure({ provider: "studio-local", model: choice.id }).catch(
      (reason: unknown) => {
        if (!lifetime.current?.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "The loaded model could not be selected.",
          );
      },
    );
  }, [
    blocked,
    result.ready,
    result.catalog,
    local.residency.state,
    localLoading,
    local.unloading,
    local.models,
    local.loadedModels,
    configuration?.provider,
    configuration?.model,
    configure,
  ]);
  const missing =
    unavailable ||
    (result.ready && !result.error && configuration?.model && !selected);
  async function apply(
    change: CodingConfigurationChange,
    options: LocalModelLoadOptions = {},
  ) {
    if (blocked) return;
    setApplying(true);
    setError(null);
    try {
      await configure(change);
      if (change.provider === "studio-local" && change.model) {
        const inventory = local.models.filter(
          (model) => model.id === change.model,
        );
        const alreadyLoaded = findResidentLocalChoice(
          inventory,
          local.loadedModels,
        );
        if (!alreadyLoaded || options.forceReload || options.config != null)
          local.preload(change.model, options);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The model selection was not confirmed.",
      );
    } finally {
      setApplying(false);
    }
  }

  async function pickLocal(
    id: string,
    meta: ModelSelectorChangeMeta,
    generation: number,
  ) {
    const signal = lifetime.current?.signal;
    const origin = currentConfiguration.current;
    const isCurrent = () =>
      generation === intent.current &&
      currentConfiguration.current?.provider === origin?.provider &&
      currentConfiguration.current?.model === origin?.model;
    if (!signal || signal.aborted || !isCurrent()) return;
    setError(null);
    try {
      let choice = findLocalPickerChoice(local.models, id, meta);
      let catalog = result.catalog;
      if (
        !choice ||
        !findCodingModel(catalog, {
          provider: "studio-local",
          model: choice.id,
        })
      ) {
        const inventory = await local.refresh(signal);
        choice = findLocalPickerChoice(inventory, id, meta);
        catalog = await read.current(true, signal);
        if (signal.aborted || !isCurrent()) return;
        setResult({ catalog, ready: true, loading: false, error: null });
      }
      if (!choice)
        throw new Error(
          "This model is not yet available in the local inventory. Refresh models once its download finishes.",
        );
      if (signal.aborted || !isCurrent()) return;
      if (
        !findCodingModel(catalog, {
          provider: "studio-local",
          model: choice.id,
        })
      ) {
        throw new Error(
          "This model is not available to Coding in this project.",
        );
      }
      await apply({ provider: "studio-local", model: choice.id }, meta);
    } catch (reason) {
      if (!signal.aborted && isCurrent()) {
        setError(
          reason instanceof Error
            ? reason.message
            : "The model selection failed.",
        );
      }
    }
  }

  function pick(id: string, meta: ModelSelectorChangeMeta) {
    if (blocked) return;
    const generation = ++intent.current;
    setPendingDownload(null);
    setError(null);
    if (meta.source === "external") {
      const choice = selectionCatalog.get(id);
      if (choice)
        void apply({ provider: choice.provider, model: choice.model });
    } else if (wantsDownloadManagerStaging({ id, ...meta })) {
      const origin = currentConfiguration.current;
      setPendingDownload({
        id,
        meta,
        originModel: String(generation),
        isCurrent: () =>
          generation === intent.current &&
          currentConfiguration.current?.provider === origin?.provider &&
          currentConfiguration.current?.model === origin?.model,
      });
    } else {
      void pickLocal(id, meta, generation);
    }
  }

  useLoadAfterDownload(
    pendingDownload,
    setPendingDownload,
    String(intent.current),
    (id, meta) => {
      if (pendingDownload?.isCurrent?.() !== true) return;
      void pickLocal(id, meta, Number(pendingDownload.originModel));
    },
    setError,
  );

  function unload(id?: string) {
    if (!localChoice && id === undefined) return;
    if (
      id !== undefined &&
      id !== localChoice?.group &&
      !local.loadedModels.some((model) => (model.checkpoint ?? model.id) === id)
    )
      return;
    ++intent.current;
    setPendingDownload(null);
    void local.unload(id === localChoice?.group ? undefined : id);
  }
  const notice =
    error ??
    local.error ??
    result.error ??
    (missing
      ? "The selected model is unavailable. Choose another model."
      : null);
  const loadedConfig = useMemo(
    () => (local.status ? residentModelConfig(local.status) : null),
    [local.status],
  );
  const resident = useMemo(
    () => ({
      status: local.status,
      loading: local.residency.state === "loading",
    }),
    [local.status, local.residency.state],
  );
  const source: ComposerModelPickerSource = {
    resident,
    loadedModels: local.loadedModels,
    models: discoverModels,
    loraModels: [],
    externalModels: models,
    externalConnections: [],
    onPick: pick,
    eject: unload,
    ejectAll: () => {
      ++intent.current;
      setPendingDownload(null);
      void local.unloadAll();
    },
    open: open && !disabled,
    onOpenChange: (next) => {
      setOpen(next && !blocked);
      if (next && result.error && !blocked) requestCatalog.current(false);
    },
    configRequest: null,
    onConfigRequestAdopted: () => undefined,
    onFoldersChange: () => requestCatalog.current(true),
    onModelsChange: () => requestCatalog.current(true),
    deleteDisabled: blocked || localLoading || local.unloading,
    activeModelConfig: loadedConfig,
    loadedContextLength: local.status?.context_length ?? null,
    loaded: localLoaded,
    selection: {
      id: identity ?? "",
      ggufVariant: identity ? (localChoice?.quant ?? null) : null,
      loaded: localLoaded,
      placeholder: pickerSelected?.model.name ?? "Select model",
      config: loadedConfig,
      operation: local.unloading
        ? "unloading"
        : (loading && !result.ready) || localLoading
          ? "loading"
          : undefined,
    },
    runtimeControls: {
      disabled: blocked,
      preserveThinking:
        preserveDefault != null
          ? {
              value: configuration?.preserve_thinking ?? preserveDefault,
              onChange: (preserve_thinking) => {
                void apply({
                  preserve_thinking,
                  ...(preserve_thinking &&
                  configuration?.provider === "studio-local" &&
                  reasoningValue === "off" &&
                  reasoningOn
                    ? { reasoning: reasoningOn }
                    : {}),
                });
              },
            }
          : undefined,
      reasoning: {
        thinking: thinkingToggle
          ? {
              enabled:
                local.status?.reasoning_always_on === true ||
                reasoningValue !== "off",
              lockedOn: local.status?.reasoning_always_on === true,
              onChange: (enabled) => {
                if (local.status?.reasoning_always_on || !reasoningOn) return;
                void apply({
                  reasoning: enabled ? reasoningOn : "off",
                  ...(!enabled ? { preserve_thinking: false } : {}),
                });
              },
            }
          : undefined,
        levels: thinkingToggle ? [] : levels,
        value: reasoningValue,
        onChange: (reasoning) => {
          void apply({
            reasoning,
            ...(reasoning === "off" &&
            configuration?.provider === "studio-local"
              ? { preserve_thinking: false }
              : {}),
          });
        },
      },
    },
  };
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="coding-model-selector"
    >
      {hosts.settingsTrigger &&
        identity &&
        localChoice &&
        !settingsOpen &&
        createPortal(
          <RunSettingsToggle onOpen={() => setSettingsOpen(true)} />,
          hosts.settingsTrigger,
        )}
      {hosts.settingsPanel &&
        identity &&
        localChoice &&
        createPortal(
          <RunSettingsPanel open={settingsOpen} onOpenChange={setSettingsOpen}>
            <div className="px-[calc(18px*var(--ui-space-scale,1))] pt-3">
              {loadedConfig && local.status ? (
                <RunSettingsSection
                  label="Model"
                  defaultOpen={true}
                  first={true}
                >
                  <SidebarModelConfig
                    resident={resident}
                    modelId={localChoice.group}
                    ggufVariant={localChoice.quant}
                    isGguf={local.status.is_gguf === true}
                    isLora={localChoice.is_lora}
                    isDiffusion={false}
                    nativeContextLength={
                      local.status.native_context_length ?? null
                    }
                    loadedContextLength={local.status.context_length ?? null}
                    loadedConfig={loadedConfig}
                    onReload={(config) => {
                      if (!blocked)
                        local.preload(localChoice.id, {
                          config,
                          forceReload: true,
                        });
                    }}
                  />
                </RunSettingsSection>
              ) : (
                <p className="py-3 text-sm text-muted-foreground">
                  {local.residency.state === "loading"
                    ? "Loading model…"
                    : "Load the selected model to view its run settings."}
                </p>
              )}
              {local.error && (
                <p role="alert" className="py-3 text-sm text-destructive">
                  {local.error}
                </p>
              )}
            </div>
          </RunSettingsPanel>,
          hosts.settingsPanel,
        )}
      <ComposerModelPickerContext.Provider value={source}>
        <ComposerModelPicker />
      </ComposerModelPickerContext.Provider>
      {notice && (
        <span
          role={error || result.error || missing ? "alert" : "status"}
          className="basis-full px-2 text-xs text-muted-foreground"
        >
          {notice}
          {result.error && (
            <Button
              variant="link"
              size="sm"
              disabled={blocked}
              onClick={() => requestCatalog.current(false)}
            >
              Retry catalog
            </Button>
          )}
          {missing && (
            <Button
              variant="link"
              size="sm"
              disabled={blocked}
              onClick={() => {
                void apply({});
              }}
            >
              Retry model
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
