// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { ComposerModelPicker } from "@/components/assistant-ui/composer-model-picker/composer-model-picker";
import {
  ComposerModelPickerContext,
  type ComposerModelPickerSource,
} from "@/components/assistant-ui/composer-model-picker/context";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
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
    "provider" | "model" | "reasoning"
  > | null;
  unavailable?: string | null;
  disabled: boolean;
  configuring: boolean;
  configure: (change: CodingConfigurationChange) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState({ refresh: false, attempt: 1 });
  const [result, setResult] = useState<{
    attempt: number;
    catalog: CodingProviderChoice[];
    error: string | null;
  }>({ attempt: 0, catalog: [], error: null });
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const read = useEffectEvent(readCatalog);
  useEffect(() => {
    const controller = new AbortController();
    read(request.refresh, controller.signal).then(
      (catalog) => {
        if (!controller.signal.aborted)
          setResult({ attempt: request.attempt, catalog, error: null });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            ...previous,
            attempt: request.attempt,
            error:
              reason instanceof Error
                ? reason.message
                : "Models could not be loaded.",
          }));
      },
    );
    return () => controller.abort();
  }, [request]);
  const selectionCatalog = useMemo(
    () => codingSelectionCatalog(result.catalog),
    [result.catalog],
  );
  const selected = findCodingModel(result.catalog, configuration);
  const identity =
    configuration?.provider && configuration.model
      ? modelIdentity(configuration.provider, configuration.model)
      : undefined;
  const levels =
    selected && selected.model.reasoning !== "unsupported"
      ? selected.model.reasoning.levels
      : [];
  const loading = request.attempt !== result.attempt;
  const blocked = disabled || configuring || applying || loading;
  const missing =
    unavailable ||
    (result.attempt > 0 && !result.error && configuration?.model && !selected);
  async function apply(change: CodingConfigurationChange) {
    if (blocked) return;
    setApplying(true);
    setError(null);
    try {
      await configure(change);
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
    result.error ??
    (missing
      ? "The selected model is unavailable. Choose another model."
      : loading
        ? "Loading models…"
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
    eject: () => undefined,
    ejectAll: () => undefined,
    open: open && !disabled,
    onOpenChange: (next) => {
      setOpen(next && !blocked);
      if (next && result.error && !blocked)
        setRequest((previous) => ({
          refresh: false,
          attempt: previous.attempt + 1,
        }));
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
      ggufVariant: null,
      placeholder: configuration?.model ?? "Select model",
    },
    runtimeCatalog: {
      models: [...selectionCatalog.values()],
      disabled: blocked,
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
        onClick={() =>
          setRequest((previous) => ({
            refresh: true,
            attempt: previous.attempt + 1,
          }))
        }
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
              onClick={() =>
                setRequest((previous) => ({
                  refresh: false,
                  attempt: previous.attempt + 1,
                }))
              }
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
