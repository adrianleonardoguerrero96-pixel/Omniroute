import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDiscoveredModels } from "../../src/lib/providerModels/modelDiscovery.ts";
import {
  __testing as discoveryFreshnessTesting,
  invalidateProviderModelDiscoveryFreshness,
  isProviderModelDiscoveryFresh,
  markProviderModelDiscoveryFresh,
} from "../../src/lib/providerModels/discoveryFreshness.ts";
import { normalizeSyncedAvailableModels } from "../../src/lib/db/models/synced.ts";

test("normalizeDiscoveredModels preserves provider-declared free economics", () => {
  const models = normalizeDiscoveredModels(
    [
      { id: "declared-free", isFree: true },
      { id: "zero-priced", pricing: { prompt: "0", completion: 0 } },
      { id: "rotating-model:free" },
      { id: "curated-only:free", _omnirouteDiscoveryFreeEvidence: false },
      { id: "paid", pricing: { prompt: "1", completion: "2" } },
    ],
    "example-provider"
  );

  assert.equal(models.find((model) => model.id === "declared-free")?.isFree, true);
  assert.equal(models.find((model) => model.id === "zero-priced")?.isFree, true);
  assert.equal(models.find((model) => model.id === "rotating-model:free")?.isFree, true);
  assert.equal(models.find((model) => model.id === "curated-only:free")?.isFree, undefined);
  assert.equal(models.find((model) => model.id === "paid")?.isFree, undefined);
});

test("normalizeSyncedAvailableModels keeps free economics through DB serialization normalization", () => {
  const [model] = normalizeSyncedAvailableModels([
    { id: "live-free", name: "Live Free", source: "imported", isFree: true },
  ]);
  assert.equal(model?.isFree, true);
});

test("discovery freshness expires and process-local reset returns UNKNOWN", () => {
  discoveryFreshnessTesting.clear();
  markProviderModelDiscoveryFresh("provider-a", "connection-a", 1_000);
  assert.equal(isProviderModelDiscoveryFresh("provider-a", "connection-a", 500, 1_500), true);
  assert.equal(isProviderModelDiscoveryFresh("provider-a", "connection-a", 499, 1_500), false);
  invalidateProviderModelDiscoveryFreshness("provider-a", "connection-a");
  assert.equal(isProviderModelDiscoveryFresh("provider-a", "connection-a", 500, 1_500), false);
  markProviderModelDiscoveryFresh("provider-a", "connection-a", 1_000);
  discoveryFreshnessTesting.clear();
  assert.equal(isProviderModelDiscoveryFresh("provider-a", "connection-a", 500, 1_500), false);
});
