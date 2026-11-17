// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useShallow } from "zustand/react/shallow";
import type { InferenceStatusResponse } from "../src/features/chat/types/api.ts";
import type * as Runtime from "../src/features/model-picker/model-config/resident-editor-runtime.tsx";
import { selectResidentEstimateSettings } from "../src/features/model-picker/model-config/resident-memory-request.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";
import {
  installLocalStorageFake,
  registerStoreStubResolver,
} from "./helpers/kit.ts";

registerStoreStubResolver();
installLocalStorageFake();
const { loadedGpuMemoryFields, normalizeSpeculativeType } = await import(
  "../src/features/chat/stores/chat-runtime-store.ts"
);
const { mlxRuntimeStateFrom } = await import(
  "../src/features/chat/lib/mlx-runtime-state.ts"
);
const { loadedPlacementFrom } = await import(
  "../src/features/chat/lib/partial-offload.ts"
);

type EditorRuntime = ReturnType<typeof Runtime.residentEditorRuntime>;
let chat: EditorRuntime;
const {
  ResidentEditorContext,
  residentEditorRuntime,
  useResidentEditorRuntime,
} = loadWithStubs<typeof Runtime>(
  new URL(
    "../src/features/model-picker/model-config/resident-editor-runtime.tsx",
    import.meta.url,
  ),
  {
    react: React,
    "zustand/react/shallow": { useShallow },
    "@/features/chat": {
      useChatRuntimeStore: (select: (state: EditorRuntime) => unknown) =>
        select(chat),
      loadedGpuMemoryFields,
      mlxRuntimeStateFrom,
      loadedPlacementFrom,
      normalizeSpeculativeType,
    },
    "./resident-memory-request": { selectResidentEstimateSettings },
  },
);

const codingStatus: InferenceStatusResponse = {
  active_model: "coding:Q4_K_M",
  loaded: ["coding:Q4_K_M"],
  loading: [],
  is_gguf: true,
  is_vision: false,
  disable_vision: true,
  offloaded_layers: 25,
  offload_total_layers: 29,
  gpu_weights_mib: 4096,
  host_weights_mib: 512,
  chat_template: "coding template",
  max_context_length: 32768,
  cache_type_kv: "q8_0",
  requested_parallel_slots: 2,
  requested_n_batch: 512,
  requested_n_ubatch: 128,
  gpu_memory_mode: "auto",
  tensor_parallel: false,
  speculative_type: "none",
};

function renderSnapshot(snapshot?: Runtime.ResidentEditorSnapshot) {
  const values: ReturnType<typeof useResidentEditorRuntime>[] = [];
  function EditorChild() {
    values.push(useResidentEditorRuntime());
    return null;
  }
  renderToStaticMarkup(
    React.createElement(
      ResidentEditorContext.Provider,
      { value: snapshot },
      React.createElement(EditorChild),
      React.createElement(EditorChild),
    ),
  );
  assert.equal(values.length, 2);
  assert.deepEqual(values[0], values[1]);
  return values[0];
}

function conflictingChat() {
  chat = {
    ...residentEditorRuntime({
      status: {
        ...codingStatus,
        active_model: "chat:MLX",
        is_gguf: false,
        is_mlx: true,
        chat_template: "chat template",
        max_context_length: 8192,
        mlx_kv_quant_requested: "8",
        mlx_kv_quant_reason: "chat kv fallback",
        mlx_kv_quant_note: "chat kv note",
        chat_template_override_reason: "chat template rejection",
        mlx_offload: {
          ple: {
            requested: 0.5,
            applied: 0.25,
            reason: "chat offload fallback",
          },
          experts: { requested: null, applied: null, reason: null },
          disk_bytes: 1024,
        },
      },
      loading: true,
    }),
    loadedPlacement: loadedPlacementFrom({
      offloaded_layers: 1,
      offload_total_layers: 32,
      gpu_weights_mib: 128,
      host_weights_mib: 8192,
    }),
    activeNativePathToken: "chat-path-token",
    activePresetSource: "builtin-default",
  };
}

test("Coding editor and its children use their resident without visiting Chat", () => {
  conflictingChat();
  const runtime = renderSnapshot({ status: codingStatus, loading: false });
  assert.deepEqual(runtime.loadedPlacement, loadedPlacementFrom(codingStatus));
  assert.equal(runtime.defaultChatTemplate, "coding template");
  assert.equal(runtime.maxContextLength, 32768);
  assert.equal(runtime.modelLoading, false);
  assert.equal(runtime.mlxKvQuantReason, null);
  assert.equal(runtime.mlxKvQuantNote, null);
  assert.equal(runtime.chatTemplateOverrideReason, null);
  assert.equal(runtime.mlxPleOffloadReason, null);
  assert.equal(runtime.loadedMlxPleOffload, null);
  assert.equal(runtime.activeNativePathToken, null);
  assert.equal(runtime.activePresetSource, "custom");
  assert.equal(runtime.residentEstimateSettings?.disableVision, true);
  assert.equal(runtime.residentEstimateSettings?.nParallel, 2);
  assert.equal(runtime.residentEstimateSettings?.cacheTypeKv, "q8_0");
});

test("explicitly absent Coding resident never falls back to an unrelated Chat model", () => {
  conflictingChat();
  const runtime = renderSnapshot({ status: null, loading: false });
  assert.equal(runtime.loadedPlacement, null);
  assert.equal(runtime.defaultChatTemplate, null);
  assert.equal(runtime.maxContextLength, null);
  assert.equal(runtime.loadedDisableVision, null);
  assert.equal(runtime.mlxKvQuantReason, null);
  assert.equal(runtime.mlxPleOffloadReason, null);
  assert.equal(runtime.modelLoading, false);
  assert.equal(runtime.residentEstimateSettings, null);
});

test("Coding loading disables resident estimates independently of Chat loading", () => {
  conflictingChat();
  chat.modelLoading = false;
  const runtime = renderSnapshot({ status: codingStatus, loading: true });
  assert.equal(runtime.modelLoading, true);
  assert.equal(runtime.residentEstimateSettings, null);
});

test("New Chat keeps its existing runtime when no resident source is supplied", () => {
  conflictingChat();
  const runtime = renderSnapshot();
  assert.deepEqual(runtime.loadedPlacement, chat.loadedPlacement);
  assert.equal(runtime.defaultChatTemplate, "chat template");
  assert.equal(runtime.maxContextLength, 8192);
  assert.equal(runtime.mlxKvQuantReason, "chat kv fallback");
  assert.equal(runtime.mlxPleOffloadReason, "chat offload fallback");
  assert.equal(runtime.activeNativePathToken, "chat-path-token");
  assert.equal(runtime.activePresetSource, "builtin-default");
  assert.equal(runtime.modelLoading, true);
});
