// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type {
  DeletedModelRef,
  ExternalConnectionRef,
  ExternalModelOption,
  LoraModelOption,
  LoadedModelSummary,
  ModelConfigHandoffRequest,
  ModelOption,
  ModelSelectorChangeMeta,
  PerModelConfig,
} from "@/features/model-picker";
import { createContext, useContext } from "react";

export interface ComposerRuntimeControls {
  disabled: boolean;
  preserveThinking?: {
    value: boolean;
    onChange: (value: boolean) => void;
  };
  reasoning: {
    thinking?: {
      enabled: boolean;
      lockedOn: boolean;
      onChange: (enabled: boolean) => void;
    };
    levels: readonly string[];
    value: string;
    onChange: (value: string) => void;
  };
}

import type { ResidentEditorSnapshot } from "@/features/model-picker";

export interface ComposerModelPickerSource {
  resident?: ResidentEditorSnapshot;
  /** Authoritative residents when the host owns its model lifecycle. */
  loadedModels?: readonly LoadedModelSummary[];
  /** The host owns connected providers and per-session configuration. */
  runtimeControls?: ComposerRuntimeControls;
  models: readonly ModelOption[];
  loraModels: readonly LoraModelOption[];
  externalModels: readonly ExternalModelOption[];
  onPick: (id: string, meta: ModelSelectorChangeMeta) => void;
  eject: (modelId?: string) => void;
  ejectAll: () => void;
  /** So a model whose connection is gone keeps its name. */
  externalConnections: readonly ExternalConnectionRef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configRequest: ModelConfigHandoffRequest | null;
  onConfigRequestAdopted: (requestId: string) => void;
  onFoldersChange: () => void;
  onModelsChange: (deleted?: DeletedModelRef) => void;
  deleteDisabled: boolean;
  activeModelConfig: PerModelConfig | null;
  loadedContextLength: number | null;
  loaded: boolean;
  /** False where only local models run (the API page): no Connected or provider tabs. */
  connections?: boolean;
  /** A choice owned outside Chat. Runtime controls opt into the full composer UI. */
  selection?: {
    id: string;
    ggufVariant: string | null;
    loaded?: boolean;
    operation?: "loading" | "unloading";
    placeholder?: string;
    /** The settings this selection runs with, seeding its Run settings. */
    config?: PerModelConfig | null;
  };
}

export const ComposerModelPickerContext =
  createContext<ComposerModelPickerSource | null>(null);

export function useComposerModelPickerSource(): ComposerModelPickerSource | null {
  return useContext(ComposerModelPickerContext);
}
