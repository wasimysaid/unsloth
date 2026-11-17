// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  SidebarModelConfig,
  RunSettingsPanel,
  RunSettingsToggle,
  RunSettingsSection,
  residentModelConfig,
} from "@/features/model-picker";
import type { LocalModelLoadOptions } from "./local-model-preload";
import { ComposerModelPicker } from "@/components/assistant-ui/composer-model-picker/composer-model-picker";
import {
  ComposerModelPickerContext,
  type ComposerModelPickerSource,
} from "@/components/assistant-ui/composer-model-picker/context";
import {
  getInventoryVersion,
  subscribeInventory,
} from "@/features/hub/stores/inventory-events";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { listModels } from "@/features/chat/api/chat-api";
import { wantsDownloadManagerStaging } from "@/features/chat/utils/model-download-staging";
import {
  type PendingModelDownload,
  useLoadAfterDownload,
} from "@/features/model-picker/use-load-after-download";
import type {
  ModelOption,
  ModelSelectorChangeMeta,
} from "@/features/model-picker";
import { useLocalModel } from "./use-local-model";
import {
  codingSelectionCatalog,
  findCodingModel,
  findLocalPickerChoice,
  modelIdentity,
} from "./model-selection";
import type {
  CodingConfiguration,
  CodingConfigurationChange,
  CodingProviderChoice,
} from "./model-selection";

export const CodingModelSettingsHosts = createContext<{
  panel: HTMLElement | null;
  trigger: HTMLElement | null;
}>({ panel: null, trigger: null });

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
  const hosts = useContext(CodingModelSettingsHosts);
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
  const preserveDefault = selected?.model.preserve_thinking;
  const identity =
    configuration?.provider === "studio-local"
      ? localChoice?.group
      : configuration?.provider && configuration.model
        ? modelIdentity(configuration.provider, configuration.model)
        : undefined;
  const levels =
    selected && selected.model.reasoning !== "unsupported"
      ? selected.model.reasoning.levels
      : [];
  const loading = result.loading;
  const blocked =
    disabled || configuring || applying || (loading && !result.ready);
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
      if (change.provider === "studio-local" && change.model)
        local.preload(change.model, options);
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
    if (!localChoice || (id !== undefined && id !== localChoice.group)) return;
    ++intent.current;
    setPendingDownload(null);
    void local.unload();
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
    models: discoverModels,
    loraModels: [],
    externalModels: models,
    externalConnections: [],
    onPick: pick,
    eject: unload,
    ejectAll: unload,
    open: open && !disabled,
    onOpenChange: (next) => {
      setOpen(next && !blocked);
      if (next && result.error && !blocked) requestCatalog.current(false);
    },
    configRequest: null,
    onConfigRequestAdopted: () => undefined,
    onFoldersChange: () => requestCatalog.current(true),
    onModelsChange: () => requestCatalog.current(true),
    deleteDisabled: true,
    activeModelConfig: loadedConfig,
    loadedContextLength: local.status?.context_length ?? null,
    loaded:
      configuration?.provider === "studio-local" &&
      Boolean(localChoice) &&
      local.residency.state === "loaded",
    selection: {
      id: identity ?? "",
      ggufVariant: localChoice?.quant ?? null,
      loaded:
        configuration?.provider === "studio-local" &&
        Boolean(localChoice) &&
        local.residency.state === "loaded",
      placeholder: selected?.model.name ?? "Select model",
      config: loadedConfig,
      loading:
        (loading && !result.ready) ||
        local.residency.state === "loading" ||
        (local.residency.state !== "loaded" &&
          preparing?.provider === "studio-local" &&
          preparing.provider === configuration?.provider &&
          preparing.model === configuration?.model),
    },
    runtimeControls: {
      disabled: blocked,
      preserveThinking:
        preserveDefault != null
          ? {
              value: configuration?.preserve_thinking ?? preserveDefault,
              onChange: (preserve_thinking) => {
                void apply({ preserve_thinking });
              },
            }
          : undefined,
      reasoning: {
        levels,
        value:
          configuration?.reasoning ?? selected?.model.default_reasoning ?? "",
        onChange: (reasoning) => {
          void apply({ reasoning });
        },
      },
    },
  };
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="coding-model-selector"
    >
      {hosts.trigger &&
        localChoice &&
        !settingsOpen &&
        createPortal(
          <RunSettingsToggle onOpen={() => setSettingsOpen(true)} />,
          hosts.trigger,
        )}
      {hosts.panel &&
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
          hosts.panel,
        )}
      <ComposerModelPickerContext.Provider value={source}>
        <ComposerModelPicker align="start" />
      </ComposerModelPickerContext.Provider>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Refresh models"
        disabled={blocked}
        onClick={() => requestCatalog.current(true)}
      >
        <RefreshCw className="size-3.5" />
      </Button>
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
