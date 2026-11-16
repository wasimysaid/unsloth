// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
import { useLocalModel } from "./use-local-model";
import {
  codingSelectionCatalog,
  findCodingModel,
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
  const requestCatalog = useRef<(refresh: boolean) => void>(() => {});
  const [result, setResult] = useState<{
    catalog: CodingProviderChoice[];
    loading: boolean;
    ready: boolean;
    error: string | null;
  }>({ catalog: [], loading: true, ready: false, error: null });
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const read = useEffectEvent(readCatalog);
  useEffect(() => {
    const controller = new AbortController();
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
          const catalog = await read(refresh, controller.signal);
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
    () => [...selectionCatalog.values()],
    [selectionCatalog],
  );
  const selected = findCodingModel(result.catalog, configuration);
  const local = useLocalModel(configuration?.provider === "studio-local" ? configuration.model : null);
  const localChoice = local.models.find((model) => model.id === configuration?.model);
  const quants = localChoice ? local.models.filter((model) => model.group === localChoice.group && model.quant) : [];
  const preserveDefault = selected?.model.preserve_thinking;
  const identity =
    configuration?.provider && configuration.model
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
  async function apply(change: CodingConfigurationChange) {
    if (blocked) return;
    setApplying(true);
    setError(null);
    try {
      await configure(change);
      if (change.provider === "studio-local" && change.model) void local.preload(change.model);
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
  const notice =
    error ??
    (local.residency.state === "failed" ? local.residency.message : null) ??
    result.error ??
    (missing
      ? "The selected model is unavailable. Choose another model."
      : null);
  const source: ComposerModelPickerSource = {
    models: [],
    loraModels: [],
    externalModels: [],
    externalConnections: [],
    onPick: (id) => {
      const choice = selectionCatalog.get(id);
      if (choice)
        void apply({ provider: choice.provider, model: choice.model });
    },
    eject: () => { void local.unload(); },
    ejectAll: () => { void local.unload(); },
    open: open && !disabled,
    onOpenChange: (next) => {
      setOpen(next && !blocked);
      if (next && result.error && !blocked) requestCatalog.current(false);
    },
    configRequest: null,
    onConfigRequestAdopted: () => undefined,
    onFoldersChange: () => undefined,
    onModelsChange: () => undefined,
    deleteDisabled: true,
    activeModelConfig: null,
    loadedContextLength: null,
    loaded: false,
    selection: {
      id: identity ?? "",
      ggufVariant: localChoice?.quant ?? null,
      loaded: local.residency.state === "loaded",
      placeholder: "Select model",
      loading: (loading && !result.ready) || local.residency.state === "loading" ||
        (local.residency.state !== "loaded" && preparing?.provider === "studio-local" &&
          preparing.provider === configuration?.provider && preparing.model === configuration?.model),
    },
    runtimeCatalog: {
      models,
      disabled: blocked,
      quantization: quants.length > 1 && configuration?.model ? {
        value: configuration.model,
        choices: quants.map((model) => ({ id: model.id, label: model.quant ?? model.name })),
        onChange: (model) => { void apply({ provider: "studio-local", model }); },
      } : undefined,
      preserveThinking: preserveDefault != null ? {
        value: configuration?.preserve_thinking ?? preserveDefault,
        onChange: (preserve_thinking) => { void apply({ preserve_thinking }); },
      } : undefined,
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
