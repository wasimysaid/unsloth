// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import {
  runtimeModelRows,
  DEVICE_TAB,
  CONNECTED_TAB,
  filterRows,
} from "../src/components/assistant-ui/composer-model-picker/picker-model.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  codingSelectionCatalog,
  findCodingModel,
  modelIdentity,
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

test("catalog selection use exact identity, never colliding labels or API mapping", () => {
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
  const choices = codingSelectionCatalog(catalog);
  assert.equal(choices.get(a)?.provider, "provider/a");
  assert.equal(choices.get(b)?.provider, "provider/b");
  assert.equal(choices.get(b)?.model, "local-id");
  assert.equal(choices.get("Same model label"), undefined);
  assert.equal(choices.get("native-api-provider/b"), undefined);
});

test("selection identities remain distinct with separators and unicode", () => {
  assert.notEqual(modelIdentity("a/b", "c"), modelIdentity("a", "b/c"));
  assert.notEqual(
    modelIdentity('provider/"ü', "local:model"),
    modelIdentity("provider", '"ü/local:model'),
  );
});

test("native case-distinct identities remain separate in shared selection and favorites", async () => {
  const { findChosenRow, filterRows, FAVORITES_TAB } = await import(
    "../src/components/assistant-ui/composer-model-picker/picker-model.ts"
  );
  const rows = ["Case", "case"].map((provider) => ({
    identity: "opaque" as const,
    searchText: "native-api-only",
    id: modelIdentity(provider, "Model"),
    key: provider,
    label: "Same label",
    tab: "connected",
    kind: "external" as const,
  }));
  assert.equal(findChosenRow(rows, rows[1].id), rows[1]);
  assert.equal(filterRows(rows, FAVORITES_TAB, "", () => true).length, 2);
  assert.equal(
    filterRows(rows, "connected", "native-api-only", () => false).length,
    2,
  );
});

test("native local models use On Device and retain exact selection identity", () => {
  const catalog = codingSelectionCatalog([
    {
      id: "studio-local",
      name: "Studio local",
      models: [
        {
          id: "local-hash",
          name: "Qwen Q4",
          api_model: "repo:Q4",
          reasoning: "unsupported",
          default_reasoning: null,
        },
      ],
    },
    {
      id: "cloud",
      name: "Cloud",
      models: [
        {
          id: "same",
          name: "Cloud model",
          api_model: "remote",
          reasoning: "unsupported",
          default_reasoning: null,
        },
      ],
    },
  ]);
  const rows = runtimeModelRows([...catalog.values()]);
  assert.equal(rows[0].tab, DEVICE_TAB);
  assert.equal(rows[0].section, "modelsDir");
  assert.equal(rows[0].kind, "external");
  assert.equal(rows[0].id, modelIdentity("studio-local", "local-hash"));
  assert.deepEqual(
    filterRows(rows, DEVICE_TAB, "", () => false).map((row) => row.label),
    ["Qwen Q4"],
  );
  assert.deepEqual(
    filterRows(rows, CONNECTED_TAB, "", () => false).map((row) => row.label),
    ["Cloud model"],
  );
});
