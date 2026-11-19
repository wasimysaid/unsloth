// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ensureGpuDeviceCache } from "@/hooks/use-gpu-info";
import {
  loadedModelsFromStatus,
  toApiOverride,
  type LoadedModelSummary,
} from "@/features/model-picker";
import {
  getInferenceStatus,
  unloadModel,
  syncKeepModelsLoaded,
  type InferenceStatusResponse,
} from "@/features/chat";
import { listOpenAIModels } from "@/features/settings";
import { subscribeInventory } from "@/features/hub";
import { codingLocalModels, type CodingLocalModel } from "./api";
import {
  createModelPreloader,
  type LocalModelLoadOptions,
} from "./local-model-preload";

export type LocalModelResidency = { state: "unloaded" | "loading" | "loaded" };

export function useLocalModel(selectedId: string | null, onLoaded: () => void) {
  const [loadedModels, setLoadedModels] = useState<LoadedModelSummary[]>([]);
  const residents = useRef<LoadedModelSummary[]>([]);
  const [unloading, setUnloading] = useState(false);
  const [models, setModels] = useState<CodingLocalModel[]>([]);
  const [snapshot, setSnapshot] = useState<{
    id: string;
    status: InferenceStatusResponse | null;
    loading: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const preloader = useRef<ReturnType<typeof createModelPreloader> | null>(
    null,
  );
  const mounted = useRef(true);
  const loaded = useEffectEvent(onLoaded);

  useEffect(() => {
    mounted.current = true;
    preloader.current = createModelPreloader(
      (id, requestId, options) =>
        codingLocalModels.load(id, requestId, {
          forceReload: options.forceReload,
          ...(options.config == null
            ? {}
            : { config: toApiOverride(options.config) }),
        }),
      (id, error) => {
        setRevision((value) => value + 1);
        if (selected.current !== id) return;
        setFailure(
          error
            ? {
                id,
                message:
                  error instanceof Error
                    ? error.message
                    : "Model loading failed.",
              }
            : null,
        );
      },
    );
    const controller = new AbortController();
    const read = () => {
      void refresh(controller.signal).catch(() => {});
    };
    read();
    void ensureGpuDeviceCache()
      .then(() => {
        if (!controller.signal.aborted) setRevision((value) => value + 1);
      })
      .catch(() => {});
    const unsubscribe = subscribeInventory(read);
    return () => {
      mounted.current = false;
      preloader.current?.close();
      controller.abort();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const id = selectedId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [globalStatus, result] = await Promise.all([
          getInferenceStatus(controller.signal),
          id
            ? codingLocalModels
                .state(id, controller.signal)
                .catch((reason: unknown) => {
                  if (!controller.signal.aborted)
                    setFailure({
                      id,
                      message:
                        reason instanceof Error
                          ? reason.message
                          : "Model status is unavailable.",
                    });
                  return null;
                })
            : null,
        ]);
        let next = loadedModelsFromStatus(globalStatus, residents.current);
        if (next.some((model) => model.quant === undefined)) {
          const details = await listOpenAIModels(controller.signal);
          const quants = new Map(
            details
              .filter((model) => model.loaded)
              .map((model) => [model.id, model.quant]),
          );
          next = next.map((model) =>
            model.quant === undefined
              ? { ...model, quant: quants.get(model.id) ?? null }
              : model,
          );
        }
        if (!controller.signal.aborted) {
          residents.current = next;
          setLoadedModels(next);
          syncKeepModelsLoaded(globalStatus.multi_model_mode);
          setSnapshot(
            id && result
              ? {
                  id,
                  status: result.loaded ? result.status : null,
                  loading: result.loading,
                }
              : null,
          );
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setFailure({
            id: id ?? "",
            message:
              reason instanceof Error
                ? reason.message
                : "Model status is unavailable.",
          });
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedId, revision]);

  async function refresh(signal: AbortSignal) {
    const inventory = await codingLocalModels.inventory(signal);
    if (mounted.current && !signal.aborted) setModels(inventory);
    return inventory;
  }

  function preload(id: string, options: LocalModelLoadOptions = {}) {
    preloader.current?.select(id, options);
  }

  async function unload(target?: string) {
    const id = selected.current;
    if (!target && !id) return;
    if (!target && id) preloader.current?.removePending(id);
    const active = preloader.current?.active();
    const requestId =
      !target && active?.id === id ? active?.requestId : undefined;
    setUnloading(true);
    try {
      if (target) await unloadModel({ model_path: target });
      else if (id) await codingLocalModels.unload(id, requestId);
      if (requestId) preloader.current?.dismissCompletion(requestId);
      if (mounted.current) {
        setRevision((value) => value + 1);
        setFailure(null);
      }
      return true;
    } catch (reason) {
      if (mounted.current)
        setFailure({
          id: selected.current ?? "",
          message:
            reason instanceof Error ? reason.message : "Model unload failed.",
        });
      return false;
    } finally {
      if (mounted.current) setUnloading(false);
    }
  }

  async function unloadAll() {
    // Every target is guarded independently; active Chat/Coding work is never cancelled.
    for (const model of residents.current) {
      if (!(await unload(model.checkpoint ?? model.id))) break;
    }
  }

  const current = snapshot?.id === selectedId ? snapshot : null;
  const status = current?.status ?? null;
  const error = failure?.id === (selectedId ?? "") ? failure.message : null;
  const residency: LocalModelResidency = {
    state:
      preloader.current?.isLoading(selectedId) || current?.loading
        ? "loading"
        : status
          ? "loaded"
          : "unloaded",
  };
  const capabilities = JSON.stringify([
    selectedId,
    status?.active_model,
    status?.context_length,
    status?.is_vision,
    status?.supports_reasoning,
    status?.reasoning_style,
    status?.reasoning_effort_levels,
    status?.reasoning_always_on,
    status?.supports_preserve_thinking,
    status?.preserve_thinking_default,
  ]);
  useEffect(() => {
    if (snapshot?.id === selectedId) loaded();
  }, [capabilities, selectedId, snapshot?.id]);
  return {
    models,
    loadedModels,
    unloading,
    residency,
    status,
    error,
    refresh,
    preload,
    unload,
    unloadAll,
  };
}
