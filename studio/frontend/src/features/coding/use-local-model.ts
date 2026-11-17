// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ensureGpuDeviceCache } from "@/hooks/use-gpu-info";
import { toApiOverride } from "@/features/model-picker";
import type { InferenceStatusResponse } from "@/features/chat";
import { subscribeInventory } from "@/features/hub/stores/inventory-events";
import { codingLocalModels, type CodingLocalModel } from "./api";
import {
  createModelPreloader,
  type LocalModelLoadOptions,
} from "./local-model-preload";

export type LocalModelResidency = { state: "unloaded" | "loading" | "loaded" };

export function useLocalModel(selectedId: string | null, onLoaded: () => void) {
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
    if (!selectedId) return;
    const id = selectedId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await codingLocalModels.state(id, controller.signal);
        if (!controller.signal.aborted) {
          setSnapshot({
            id,
            status: result.loaded ? result.status : null,
            loading: result.loading,
          });
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setFailure({
            id,
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

  async function unload() {
    if (!selectedId) return;
    preloader.current?.removePending(selectedId);
    const active = preloader.current?.active();
    const requestId = active?.id === selectedId ? active.requestId : undefined;
    try {
      await codingLocalModels.unload(selectedId, requestId);
      if (requestId) preloader.current?.dismissCompletion(requestId);
      if (mounted.current) {
        setRevision((value) => value + 1);
        setFailure(null);
      }
    } catch (reason) {
      if (mounted.current && selected.current === selectedId)
        setFailure({
          id: selectedId,
          message:
            reason instanceof Error ? reason.message : "Model unload failed.",
        });
    }
  }

  const current = snapshot?.id === selectedId ? snapshot : null;
  const status = current?.status ?? null;
  const error = failure?.id === selectedId ? failure.message : null;
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
  return { models, residency, status, error, refresh, preload, unload };
}
