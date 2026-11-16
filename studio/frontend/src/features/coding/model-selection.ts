// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Native catalog data only. Labels and API names are never selection identities. */
export interface CodingModelChoice {
  id: string;
  name: string;
  api_model: string;
  default_reasoning: string | null;
  preserve_thinking?: boolean | null;
  reasoning: "unsupported" | { levels: string[] };
}
export interface CodingProviderChoice {
  id: string;
  name: string;
  models: CodingModelChoice[];
}
export interface CodingConfiguration {
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  mode: string;
  preserve_thinking?: boolean | null;
}
export interface CodingConfigurationChange {
  provider?: string;
  model?: string;
  reasoning?: string;
  preserve_thinking?: boolean;
}
export interface CodingModelApi {
  /** The retained controller's inventory, not a separately loaded folder catalog. */
  catalog(id: string, signal: AbortSignal): Promise<CodingProviderChoice[]>;
  refresh(id: string, signal: AbortSignal): Promise<CodingProviderChoice[]>;
}

export const modelIdentity = (provider: string, model: string) =>
  JSON.stringify([provider, model]);

export function findCodingModel(
  catalog: CodingProviderChoice[],
  selection: Pick<CodingConfiguration, "provider" | "model"> | null,
) {
  const provider = catalog.find((item) => item.id === selection?.provider);
  const model = provider?.models.find((item) => item.id === selection?.model);
  return provider && model ? { provider, model } : null;
}

export function codingSelectionCatalog(catalog: CodingProviderChoice[]) {
  return new Map(
    catalog.flatMap((provider) =>
      provider.models.map(
        (model) =>
          [
            modelIdentity(provider.id, model.id),
            {
              id: modelIdentity(provider.id, model.id),
              name: model.name,
              description: provider.name,
              searchText: `${provider.id} ${model.id} ${model.api_model}`,
              identity: "opaque",
              providerId: provider.id,
              providerName: provider.name,
              providerType: provider.id,
              provider: provider.id,
              model: model.id,
            },
          ] as const,
      ),
    ),
  );
}

export function findLocalPickerChoice<
  T extends { id: string; group: string; quant: string | null },
>(
  inventory: readonly T[],
  id: string,
  selection: { loadId?: string | null; ggufVariant?: string },
): T | undefined {
  const loadId = selection.loadId ?? id;
  const quant = selection.ggufVariant ?? null;
  return inventory.find(
    (model) => model.group === loadId && model.quant === quant,
  );
}
