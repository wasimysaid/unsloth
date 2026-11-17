// SPDX-License-Identifier: AGPL-3.0-only
import type { InferenceStatusResponse } from "@/features/chat";
import { loadedGpuMemoryFields, mlxOffloadStateFrom } from "@/features/chat";
import { fromApiOverride } from "../api/model-overrides";
import type { PerModelConfig } from "./per-model-config";

/** The resident launch values seed the editor without consulting saved defaults. */
export function residentModelConfig(
  status: InferenceStatusResponse,
): PerModelConfig {
  const offload = mlxOffloadStateFrom(status);
  const placement = loadedGpuMemoryFields(status);
  return fromApiOverride({
    engine: status.engine,
    engine_precision: status.engine_precision,
    engine_parallelism: status.engine_parallelism,
    engine_kv_cache_dtype: status.engine_kv_cache_dtype,
    engine_seed: status.engine_seed,
    engine_gpu_memory_utilization: status.engine_gpu_memory_utilization,
    load_in_4bit: status.load_in_4bit ?? undefined,
    custom_context_length:
      (status.is_gguf
        ? status.requested_context_pin
        : status.requested_context_length) || undefined,
    max_seq_length:
      status.is_gguf || status.is_mlx || status.is_npu
        ? undefined
        : (status.context_length ?? undefined),
    kv_cache_dtype: status.cache_type_kv ?? undefined,
    mlx_kv_quant: status.is_mlx
      ? (status.mlx_kv_quant_requested ?? undefined)
      : undefined,
    mlx_int8_prefill:
      status.is_mlx && status.mlx_int8_prefill_requested === true,
    mlx_ane_prefill: status.is_mlx && status.mlx_ane_prefill_requested === true,
    mlx_fast_verify: status.is_mlx && status.mlx_fast_verify_requested === true,
    mlx_ple_offload: offload.loadedMlxPleOffloadRequested,
    mlx_expert_offload: offload.loadedMlxExpertOffloadRequested,
    npu_power_mode: status.is_npu ? status.npu_power_mode : null,
    npu_prefill_chunk_len: status.is_npu ? status.npu_prefill_chunk_len : null,
    npu_img_pre_resize: status.is_npu ? status.npu_img_pre_resize : null,
    speculative_type: status.speculative_type ?? undefined,
    spec_draft_n_max: status.spec_draft_n_max ?? undefined,
    spec_draft_model: status.spec_draft_model ?? undefined,
    n_parallel: status.requested_n_parallel ?? undefined,
    reasoning_budget: status.requested_reasoning_budget ?? -1,
    reasoning_budget_message: status.requested_reasoning_budget_message ?? "",
    n_batch: status.requested_n_batch ?? undefined,
    n_ubatch: status.requested_n_ubatch ?? undefined,
    load_mode: status.requested_load_mode ?? undefined,
    spec_draft_cache_type: status.requested_spec_draft_cache_type ?? undefined,
    ctx_checkpoints: status.requested_ctx_checkpoints ?? undefined,
    cache_ram: status.requested_cache_ram ?? undefined,
    tensor_parallel: status.tensor_parallel,
    disable_vision: status.vision_disabled_by_user ?? status.disable_vision,
    engram_precision: status.engram_precision,
    chat_template_override: status.chat_template_override ?? undefined,
    llama_extra_args: status.requested_llama_extra_args ?? undefined,
    gpu_memory_mode: status.gpu_memory_mode,
    gpu_layers: placement.gpuLayers,
    n_cpu_moe: placement.nCpuMoe,
    gpu_ids: placement.selectedGpuIds ?? undefined,
    gpu_index_kind: placement.selectedGpuIndexKind ?? undefined,
    tensor_split: placement.splitRatio,
  });
}
