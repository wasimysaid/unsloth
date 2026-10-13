// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Native catalog data only. Labels and API names are never selection identities. */
export interface CodingModelChoice {
  id: string;
  name: string;
  api_model: string;
  default_reasoning: string | null;
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
}
export interface CodingConfigurationChange {
  provider?: string;
  model?: string;
  reasoning?: string;
}
export interface CodingModelApi {
  catalog(cwd: string, signal: AbortSignal): Promise<CodingProviderChoice[]>;
}

export const modelIdentity = (provider: string, model: string) =>
  JSON.stringify([provider, model]);

export function findCodingModel(
  catalog: CodingProviderChoice[],
  selection: CodingConfiguration | null,
) {
  const provider = catalog.find((item) => item.id === selection?.provider);
  const model = provider?.models.find((item) => item.id === selection?.model);
  return provider && model ? { provider, model } : null;
}

export function filterCodingModels(
  catalog: CodingProviderChoice[],
  search: string,
  providerId: string | null,
  favorites: ReadonlySet<string>,
  favoritesOnly: boolean,
) {
  const query = search.trim().toLocaleLowerCase();
  return catalog
    .filter((provider) => providerId === null || provider.id === providerId)
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => {
        if (
          favoritesOnly &&
          !favorites.has(modelIdentity(provider.id, model.id))
        )
          return false;
        return [
          provider.id,
          provider.name,
          model.id,
          model.name,
          model.api_model,
        ].some((text) => text.toLocaleLowerCase().includes(query));
      }),
    }))
    .filter((provider) => provider.models.length > 0);
}

/** Favorite persistence stores exact identity pairs, never copies of catalog entries. */
export function readCodingFavorites(value: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((key): key is string => {
        if (typeof key !== "string") return false;
        try {
          const pair: unknown = JSON.parse(key);
          return (
            Array.isArray(pair) &&
            pair.length === 2 &&
            pair.every((part) => typeof part === "string" && part.length > 0) &&
            JSON.stringify(pair) === key
          );
        } catch {
          return false;
        }
      }),
    );
  } catch {
    return new Set();
  }
}
