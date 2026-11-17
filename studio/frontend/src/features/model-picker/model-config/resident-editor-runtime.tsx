// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useChatRuntimeStore,
  loadedGpuMemoryFields,
  mlxRuntimeStateFrom,
  loadedPlacementFrom,
  normalizeSpeculativeType,
  type InferenceStatusResponse,
} from "@/features/chat";
import { selectResidentEstimateSettings } from "./resident-memory-request";

export interface ResidentEditorSnapshot {
  status: InferenceStatusResponse | null;
  loading: boolean;
}

export const ResidentEditorContext = createContext<
  ResidentEditorSnapshot | undefined
>(undefined);

type ResidentEditorRuntime = Pick<
  ReturnType<typeof useChatRuntimeStore.getState>,
  | "mlxKvQuantReason"
  | "chatTemplateOverrideReason"
  | "loadedChatTemplateOverride"
  | "loadedLlamaExtraArgs"
  | "loadedGpuIds"
  | "loadedGpuIndexKind"
  | "loadedCpuFallback"
  | "modelLoading"
  | "mlxKvQuantNote"
  | "loadedMlxPleOffloadRequested"
  | "loadedMlxExpertOffloadRequested"
  | "loadedMlxPleOffload"
  | "loadedMlxExpertOffload"
  | "mlxPleOffloadReason"
  | "mlxExpertOffloadReason"
  | "loadedMlxKvQuantRequested"
  | "activeNativePathToken"
  | "defaultChatTemplate"
  | "loadedNpuContextFit"
  | "maxContextLength"
  | "loadedPlacement"
  | "activePresetSource"
  | "loadedKvCacheDtype"
  | "loadedNParallel"
  | "loadedNBatch"
  | "loadedNUbatch"
  | "loadedCtxCheckpoints"
  | "loadedSpeculativeType"
  | "loadedSpecDraftNMax"
  | "loadedSpecDraftCacheDtype"
  | "loadedTensorParallel"
  | "loadedDisableVision"
  | "loadedGpuMemoryMode"
  | "loadedGpuLayers"
  | "loadedNCpuMoe"
  | "specFallbackReason"
  | "mmprojFallbackReason"
>;

function selectChatEditorRuntime(
  state: ResidentEditorRuntime,
): ResidentEditorRuntime {
  return {
    mlxKvQuantReason: state.mlxKvQuantReason,
    chatTemplateOverrideReason: state.chatTemplateOverrideReason,
    loadedChatTemplateOverride: state.loadedChatTemplateOverride,
    loadedLlamaExtraArgs: state.loadedLlamaExtraArgs,
    loadedGpuIds: state.loadedGpuIds,
    loadedGpuIndexKind: state.loadedGpuIndexKind,
    loadedCpuFallback: state.loadedCpuFallback,
    modelLoading: state.modelLoading,
    mlxKvQuantNote: state.mlxKvQuantNote,
    loadedMlxPleOffloadRequested: state.loadedMlxPleOffloadRequested,
    loadedMlxExpertOffloadRequested: state.loadedMlxExpertOffloadRequested,
    loadedMlxPleOffload: state.loadedMlxPleOffload,
    loadedMlxExpertOffload: state.loadedMlxExpertOffload,
    mlxPleOffloadReason: state.mlxPleOffloadReason,
    mlxExpertOffloadReason: state.mlxExpertOffloadReason,
    loadedMlxKvQuantRequested: state.loadedMlxKvQuantRequested,
    activeNativePathToken: state.activeNativePathToken,
    defaultChatTemplate: state.defaultChatTemplate,
    loadedNpuContextFit: state.loadedNpuContextFit,
    maxContextLength: state.maxContextLength,
    loadedPlacement: state.loadedPlacement,
    activePresetSource: state.activePresetSource,
    loadedKvCacheDtype: state.loadedKvCacheDtype,
    loadedNParallel: state.loadedNParallel,
    loadedNBatch: state.loadedNBatch,
    loadedNUbatch: state.loadedNUbatch,
    loadedCtxCheckpoints: state.loadedCtxCheckpoints,
    loadedSpeculativeType: state.loadedSpeculativeType,
    loadedSpecDraftNMax: state.loadedSpecDraftNMax,
    loadedSpecDraftCacheDtype: state.loadedSpecDraftCacheDtype,
    loadedTensorParallel: state.loadedTensorParallel,
    loadedDisableVision: state.loadedDisableVision,
    loadedGpuMemoryMode: state.loadedGpuMemoryMode,
    loadedGpuLayers: state.loadedGpuLayers,
    loadedNCpuMoe: state.loadedNCpuMoe,
    specFallbackReason: state.specFallbackReason,
    mmprojFallbackReason: state.mmprojFallbackReason,
  };
}

export function residentEditorRuntime({
  status,
  loading,
}: ResidentEditorSnapshot): ResidentEditorRuntime {
  const source: Partial<InferenceStatusResponse> = status ?? {};
  return {
    ...loadedGpuMemoryFields(source),
    ...mlxRuntimeStateFrom(source),
    modelLoading: loading,
    loadedChatTemplateOverride: source.chat_template_override ?? null,
    loadedLlamaExtraArgs: source.requested_llama_extra_args ?? null,
    activeNativePathToken: null,
    defaultChatTemplate: source.chat_template ?? null,
    loadedNpuContextFit: source.npu_context_fit ?? null,
    maxContextLength: source.max_context_length ?? null,
    loadedPlacement: status ? loadedPlacementFrom(status) : null,
    activePresetSource: "custom",
    loadedKvCacheDtype: source.cache_type_kv ?? null,
    loadedNParallel: source.requested_parallel_slots ?? null,
    loadedNBatch: source.requested_n_batch ?? null,
    loadedNUbatch: source.requested_n_ubatch ?? null,
    loadedCtxCheckpoints: source.requested_ctx_checkpoints ?? null,
    loadedSpeculativeType: status
      ? normalizeSpeculativeType(source.speculative_type)
      : null,
    loadedSpecDraftNMax: source.spec_draft_n_max ?? null,
    loadedSpecDraftCacheDtype: source.requested_spec_draft_cache_type ?? null,
    loadedTensorParallel: source.tensor_parallel ?? null,
    loadedDisableVision: source.disable_vision ?? null,
    specFallbackReason: source.spec_fallback_reason ?? null,
    mmprojFallbackReason: source.mmproj_fallback_reason ?? null,
  };
}

export function useResidentEditorRuntime() {
  const snapshot = useContext(ResidentEditorContext);
  const chat = useChatRuntimeStore(
    useShallow((state) =>
      snapshot === undefined ? selectChatEditorRuntime(state) : null,
    ),
  );
  return useMemo(() => {
    const runtime =
      chat ??
      residentEditorRuntime(snapshot ?? { status: null, loading: false });
    return {
      ...runtime,
      residentEstimateSettings: selectResidentEstimateSettings(runtime),
    };
  }, [chat, snapshot]);
}
