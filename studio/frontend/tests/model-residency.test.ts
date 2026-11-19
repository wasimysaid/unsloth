// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { loadedModelsFromStatus } from "../src/features/model-picker/loaded-models.ts";

test("Chat and Coding retain secondary quants while adopting the active slot", () => {
  const previous = [{ id: "a", checkpoint: "/models/a", quant: "Q4" }];
  const next = loadedModelsFromStatus(
    {
      active_model: "b",
      gguf_variant: "Q8",
      serving: ["b", "a"],
      serving_checkpoints: ["/models/b", "/models/a"],
    },
    previous,
  );
  assert.deepEqual(next, [
    { id: "b", checkpoint: "/models/b", quant: "Q8" },
    previous[0],
  ]);
  assert.equal(next[1], previous[0]);
});

test("resident removal clears the list and colliding labels do not reuse another file's quant", () => {
  const previous = [{ id: "same", checkpoint: "/models/first", quant: "Q4" }];
  assert.deepEqual(
    loadedModelsFromStatus({ active_model: null, serving: [] }, previous),
    [],
  );
  assert.deepEqual(
    loadedModelsFromStatus(
      {
        active_model: null,
        serving: ["same"],
        serving_checkpoints: ["/models/second"],
      },
      previous,
    ),
    [{ id: "same", checkpoint: "/models/second", quant: undefined }],
  );
});
