import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSyncedAvailableModels } from "../../src/lib/db/models/synced.ts";
import { normalizeDiscoveredModels } from "../../src/lib/providerModels/modelDiscovery.ts";

test("normalizeDiscoveredModels preserves provider-declared free economics", () => {
  const models = normalizeDiscoveredModels(
    [
      { id: "declared-free", isFree: true },
      { id: "zero-priced", pricing: { prompt: "0", completion: 0 } },
      { id: "rotating-model:free" },
      { id: "paid", pricing: { prompt: "1", completion: "2" } },
    ],
    "example-provider"
  );

  assert.equal(models.find((model) => model.id === "declared-free")?.isFree, true);
  assert.equal(models.find((model) => model.id === "zero-priced")?.isFree, true);
  assert.equal(models.find((model) => model.id === "rotating-model:free")?.isFree, true);
  assert.equal(models.find((model) => model.id === "paid")?.isFree, undefined);
});

test("normalizeSyncedAvailableModels preserves isFree through DB serialization normalization", () => {
  const [model] = normalizeSyncedAvailableModels([
    { id: "live-free", name: "Live Free", source: "imported", isFree: true },
  ]);
  assert.equal(model?.isFree, true);
});
