// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  STARRED_GROUP,
  filterCodingModels,
  modelGroups,
  findCodingModel,
  modelIdentity,
  readCodingFavorites,
} from "../src/features/coding/model-selection.ts";
import type { CodingProviderChoice } from "../src/features/coding/model-selection.ts";

const catalog: CodingProviderChoice[] = ["provider/a", "provider/b"].map(
  (id) => ({
    id,
    name: "Same provider label",
    models: [
      {
        id: "local-id",
        name: "Same model label",
        api_model: `native-api-${id}`,
        default_reasoning: id === "provider/a" ? "medium" : null,
        reasoning:
          id === "provider/a"
            ? { levels: ["low", "medium", "high"] }
            : "unsupported",
      },
    ],
  }),
);

test("catalog selection and favorites use exact identity, never colliding labels or API mapping", () => {
  const selection = {
    provider: "provider/b",
    model: "local-id",
    reasoning: null,
    mode: "build",
  };
  assert.equal(
    findCodingModel(catalog, selection)?.model.api_model,
    "native-api-provider/b",
  );
  assert.equal(
    findCodingModel(catalog, { ...selection, model: "Same model label" }),
    null,
  );
  assert.equal(
    findCodingModel(catalog, { ...selection, model: "native-api-provider/b" }),
    null,
  );
  const a = modelIdentity("provider/a", "local-id");
  const b = modelIdentity("provider/b", "local-id");
  assert.notEqual(a, b);
  const favorites = readCodingFavorites(
    JSON.stringify([a, a, "Same model label", '["single"]', '["", "id"]']),
  );
  assert.deepEqual([...favorites], [a]);
  const [starred, ...providers] = modelGroups(
    filterCodingModels(catalog, ""),
    favorites,
  );
  assert.equal(starred.key, STARRED_GROUP);
  assert.deepEqual(
    starred.models.map(({ provider, model }) => [provider, model.id]),
    [["provider/a", "local-id"]],
    "only the exact starred identity, never the same id of another provider",
  );
  assert.deepEqual(
    providers.map((group) => group.key),
    catalog.map((provider) => provider.id),
  );
  assert.equal(
    modelGroups(filterCodingModels(catalog, ""), new Set())[0].key,
    catalog[0].id,
    "no Starred group without favorites",
  );
});

test("search/provider navigation derive exclusively from native entries and do not invent reasoning levels", () => {
  const before = structuredClone(catalog);
  assert.deepEqual(
    filterCodingModels(catalog, " NATIVE-api-PROVIDER/B ").map(
      (provider) => provider.id,
    ),
    ["provider/b"],
  );
  assert.equal(filterCodingModels(catalog, "no such model").length, 0);
  assert.deepEqual(
    modelGroups(filterCodingModels(catalog, "same"), new Set()).find(
      (group) => group.key === "provider/b",
    )?.models[0].model.reasoning,
    "unsupported",
  );
  assert.deepEqual(catalog, before);
});

test("favorite keys are collision safe even when IDs contain separators, quotes or Unicode", () => {
  assert.notEqual(modelIdentity("a/b", "c"), modelIdentity("a", "b/c"));
  const key = modelIdentity('provider/"ü', "local:model");
  assert.equal(readCodingFavorites(JSON.stringify([key])).has(key), true);
  for (const malformed of [null, "not JSON", '{"models":[]}', "[null,42,{}]"])
    assert.equal(readCodingFavorites(malformed).size, 0);
});
