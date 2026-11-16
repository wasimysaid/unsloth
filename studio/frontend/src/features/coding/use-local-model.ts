// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { subscribeInventory } from "@/features/hub/stores/inventory-events";
import { codingLocalModels, type CodingLocalModel } from "./api";
import { createModelPreloader } from "./local-model-preload";

export type LocalModelResidency =
  | { state: "unloaded" | "loading" | "loaded" }
  | { state: "failed"; message: string };

export function useLocalModel(selectedId: string | null) {
  const [models, setModels] = useState<CodingLocalModel[]>([]);
  const [residency, setResidency] = useState<LocalModelResidency>({
    state: "unloaded",
  });
  const [revision, setRevision] = useState(0);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const preloader = useRef<ReturnType<typeof createModelPreloader> | null>(
    null,
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    preloader.current = createModelPreloader(
      codingLocalModels.load,
      (id, error, loading) => {
        if (selected.current !== id) return;
        if (error) {
          setResidency({
            state: "failed",
            message:
              error instanceof Error ? error.message : "Model loading failed.",
          });
        } else {
          setResidency({ state: loading ? "loading" : "loaded" });
        }
      },
    );
    const controller = new AbortController();
    const read = () => {
      void refresh(controller.signal).catch(() => {});
    };
    read();
    const unsubscribe = subscribeInventory(read);
    return () => {
      mounted.current = false;
      preloader.current?.close();
      controller.abort();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setResidency({
      state: preloader.current?.isLoading(selectedId) ? "loading" : "unloaded",
    });
    if (!selectedId) return;
    const id = selectedId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const result = await codingLocalModels.state(id, controller.signal);
        if (!controller.signal.aborted) {
          setResidency((previous) => {
            if (previous.state === "failed" && !result.loaded) return previous;
            if (result.loaded) return { state: "loaded" };
            if (result.loading || preloader.current?.isLoading(selectedId)) {
              return { state: "loading" };
            }
            return { state: "unloaded" };
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setResidency({
            state: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Model status is unavailable.",
          });
        }
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

  function preload(id: string) {
    preloader.current?.select(id);
  }

  async function unload() {
    if (!selectedId) return;
    preloader.current?.removePending(selectedId);
    const active = preloader.current?.active();
    const requestId = active?.id === selectedId ? active.requestId : undefined;
    try {
      await codingLocalModels.unload(selectedId, requestId);
      if (requestId) preloader.current?.dismissCompletion(requestId);
      if (mounted.current) setRevision((value) => value + 1);
    } catch (error) {
      if (mounted.current && selected.current === selectedId) {
        setResidency({
          state: "failed",
          message:
            error instanceof Error ? error.message : "Model unload failed.",
        });
      }
    }
  }

  return { models, residency, refresh, preload, unload };
}
