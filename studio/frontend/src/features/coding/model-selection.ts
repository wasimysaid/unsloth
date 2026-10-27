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

export function filterCodingModels(
  catalog: CodingProviderChoice[],
  search: string,
) {
  const query = search.trim().toLocaleLowerCase();
  return catalog
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) =>
        [
          provider.id,
          provider.name,
          model.id,
          model.name,
          model.api_model,
        ].some((text) => text.toLocaleLowerCase().includes(query)),
      ),
    }))
    .filter((provider) => provider.models.length > 0);
}

export const STARRED_GROUP = "starred";
/** Starred models first, then one group per provider, in catalog order. */
export function modelGroups(
  catalog: CodingProviderChoice[],
  favorites: ReadonlySet<string>,
) {
  const entry =
    (provider: CodingProviderChoice) => (model: CodingModelChoice) => ({
      provider: provider.id,
      model,
    });
  const starred = catalog.flatMap((provider) =>
    provider.models
      .filter((model) => favorites.has(modelIdentity(provider.id, model.id)))
      .map(entry(provider)),
  );
  return [
    ...(starred.length
      ? [{ key: STARRED_GROUP, name: "Starred", models: starred }]
      : []),
    ...catalog.map((provider) => ({
      key: provider.id,
      name: provider.name,
      models: provider.models.map(entry(provider)),
    })),
  ];
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
