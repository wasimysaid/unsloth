// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { loadWithStubs } from "./helpers/module-stubs.ts";
import type * as Resident from "../src/features/model-picker/model-config/resident-model-config.ts";
import type { InferenceStatusResponse } from "../src/features/chat/types/api.ts";
import {
  installLocalStorageFake,
  registerStoreStubResolver,
} from "./helpers/kit.ts";

registerStoreStubResolver();
installLocalStorageFake();
const { toApiOverride, fromApiOverride } = await import(
  "../src/features/model-picker/api/model-overrides.ts"
);
const { DEFAULT_PER_MODEL_CONFIG } = await import(
  "../src/features/model-picker/model-config/per-model-config.ts"
);
const { createModelPreloader } = await import(
  "../src/features/coding/local-model-preload.ts"
);
const { loadedGpuMemoryFields } = await import(
  "../src/features/chat/stores/chat-runtime-store.ts"
);
const { mlxOffloadStateFrom } = await import(
  "../src/features/chat/lib/mlx-runtime-state.ts"
);
const { residentModelConfig } = loadWithStubs<typeof Resident>(
  new URL(
    "../src/features/model-picker/model-config/resident-model-config.ts",
    import.meta.url,
  ),
  {
    "@/features/chat": { loadedGpuMemoryFields, mlxOffloadStateFrom },
    "../api/model-overrides": { fromApiOverride },
  },
);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const gguf: InferenceStatusResponse = {
  active_model: "repo:Q4_K_M",
  is_vision: false,
  is_gguf: true,
  loading: [],
  loaded: ["repo:Q4_K_M"],
  context_length: 16384,
  requested_context_length: 0,
  requested_context_pin: null,
  requested_n_parallel: null,
  requested_parallel_slots: 2,
  cache_type_kv: "q8_0",
  requested_n_batch: 512,
  requested_n_ubatch: 128,
  reasoning_budget: 2048,
  reasoning_budget_message: "environment default",
  requested_reasoning_budget: -1,
  requested_reasoning_budget_message: "",
  disable_vision: true,
  chat_template_override: "{{ messages }}",
  requested_llama_extra_args: [],
};

test("resident editor uses actual launch settings without turning Auto into the resolved context", () => {
  const config = residentModelConfig(gguf);
  assert.equal(config.customContextLength, null);
  assert.equal(config.maxSeqLength, null);
  assert.equal(config.kvCacheDtype, "q8_0");
  assert.equal(config.reasoningBudget, -1);
  assert.equal(config.reasoningBudgetMessage, "");
  assert.equal(config.nParallel, null);
  assert.equal(config.nBatch, 512);
  assert.equal(config.nUbatch, 128);
  assert.equal(config.disableVision, true);
  assert.equal(config.chatTemplateOverride, "{{ messages }}");
  assert.deepEqual(config.llamaExtraArgs, []);
  assert.equal(toApiOverride(config).custom_context_length, undefined);
});

test("resident explicit context and MLX requested fallback settings survive another reload", () => {
  const config = residentModelConfig({
    ...gguf,
    is_gguf: false,
    is_mlx: true,
    requested_context_length: 8192,
    context_length: 8192,
    mlx_kv_quant: "4",
    mlx_kv_quant_requested: "8",
    mlx_int8_prefill: false,
    mlx_int8_prefill_requested: true,
    mlx_offload: {
      ple: { requested: 0.5, applied: 0.25, reason: null },
      experts: { requested: null, applied: null, reason: null },
      disk_bytes: 0,
    },
  });
  assert.equal(config.customContextLength, 8192);
  assert.equal(config.mlxKvQuant, "8");
  assert.equal(config.mlxInt8Prefill, true);
  assert.equal(config.mlxPleOffload, 0.5);
  assert.equal(toApiOverride(config).custom_context_length, 8192);
});

test("different settings for the same model survive coalescing and exact duplicates join", async () => {
  const calls: unknown[] = [];
  const finish: (() => void)[] = [];
  const loader = createModelPreloader(
    (_id, _request, options) => {
      calls.push(options);
      return new Promise<void>((resolve) => finish.push(resolve));
    },
    () => {},
  );
  const first = {
    config: { ...DEFAULT_PER_MODEL_CONFIG, customContextLength: 8192 },
    forceReload: true,
  };
  const second = {
    config: { ...DEFAULT_PER_MODEL_CONFIG, customContextLength: 16384 },
    forceReload: true,
  };
  loader.select("A", first);
  loader.select("A", first);
  loader.select("A", second);
  assert.deepEqual(calls, [first]);
  finish[0]();
  await tick();
  assert.deepEqual(calls, [first, second]);
  finish[1]();
  await tick();
});

test("Auto parallelism stays unpinned while an explicit pin survives the status roundtrip", () => {
  const automatic = residentModelConfig({
    ...gguf,
    requested_n_parallel: null,
    requested_parallel_slots: 4,
  });
  assert.equal(
    toApiOverride({ ...automatic, nBatch: 1024 }).n_parallel,
    undefined,
  );
  const pinned = residentModelConfig({
    ...gguf,
    requested_n_parallel: 2,
    requested_parallel_slots: 2,
    parallel_slots: 1,
  });
  assert.equal(toApiOverride(pinned).n_parallel, 2);
});

test("replaying an automatically fitted context does not create a context pin", () => {
  const automatic = residentModelConfig({
    ...gguf,
    requested_context_length: 16384,
    requested_context_pin: null,
  });
  assert.equal(
    toApiOverride({ ...automatic, nBatch: 1024 }).custom_context_length,
    undefined,
  );
  const pinned = residentModelConfig({
    ...gguf,
    requested_context_length: 8192,
    requested_context_pin: 8192,
  });
  assert.equal(toApiOverride(pinned).custom_context_length, 8192);
});
