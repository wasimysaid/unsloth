// SPDX-License-Identifier: AGPL-3.0-only
import type { InferenceStatusResponse } from "../chat/types/api";

export type LoadedModelSummary = {
  id: string;
  quant?: string | null;
  checkpoint?: string;
};

/** Preserve known quants for secondary slots; status describes the routed slot. */
export function loadedModelsFromStatus(
  status: Pick<
    InferenceStatusResponse,
    "serving" | "serving_checkpoints" | "active_model" | "gguf_variant"
  >,
  current: readonly LoadedModelSummary[] = [],
): LoadedModelSummary[] {
  const known = new Map(
    current.map((model) => [model.checkpoint ?? model.id, model]),
  );
  return (status.serving ?? []).map((id, index) => {
    const checkpoint = status.serving_checkpoints?.[index] || id;
    const previous = known.get(checkpoint);
    const quant =
      id === status.active_model
        ? (status.gguf_variant ?? null)
        : previous?.quant;
    return previous &&
      previous.quant === quant &&
      previous.checkpoint === checkpoint
      ? previous
      : { id, quant, checkpoint };
  });
}
