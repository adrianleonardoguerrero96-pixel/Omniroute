import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectDefaultThinkingEffort,
  detectSupportedThinkingEfforts,
  normalizeDiscoveredModels,
} from "@/lib/providerModels/modelDiscovery";

// Merge Gateway `/v1/models` nests per-vendor-route reasoning capability under
// `vendors.<vendor>.capabilities.reasoning` with the route's accepted effort
// levels in `effort_values` (docs.merge.dev, "Effort levels per route"). The
// same canonical model declares DIFFERENT vocabularies per vendor route, and
// unpinned requests self-narrow to a route honoring the requested level when
// one exists — so the synced vocabulary is the INTERSECTION across routes:
// a level outside the intersection can be silently adjusted (or 400 on pinned
// requests) on the route a request actually lands on.

function mergeRecord(vendorEfforts: Record<string, string[] | undefined>) {
  return {
    id: "zai/glm-5.3-flash",
    vendors: Object.fromEntries(
      Object.entries(vendorEfforts).map(([vendor, efforts]) => [
        vendor,
        { capabilities: { reasoning: { effort_values: efforts } } },
      ])
    ),
  };
}

test("Merge effort_values from a single vendor route is parsed into supportedThinkingEfforts", () => {
  assert.deepEqual(detectSupportedThinkingEfforts(mergeRecord({ zai: ["low", "high", "max"] })), [
    "low",
    "high",
    "max",
  ]);
});

test("Merge effort_values from multiple vendor routes intersects across routes", () => {
  assert.deepEqual(
    detectSupportedThinkingEfforts(
      mergeRecord({
        zai: ["low", "high", "max"],
        baseten: ["low", "medium", "high", "xhigh"],
        makora: ["low", "high", "max"],
      })
    ),
    ["low", "high"]
  );
});

test("vendor routes without effort_values (no effort control) are excluded from the intersection", () => {
  // fireworks: no effort_values key at all — "no effort control" per the docs.
  const record = {
    id: "moonshot/kimi-k3",
    vendors: {
      moonshot: { capabilities: { reasoning: { effort_values: ["low", "max"] } } },
      fireworks: { capabilities: { reasoning: {} } },
    },
  };
  assert.deepEqual(detectSupportedThinkingEfforts(record), ["low", "max"]);
});

test("a malformed vendor entry is dropped individually; no throw on garbage vendors", () => {
  const record = {
    id: "vendor/garbage",
    vendors: {
      good: { capabilities: { reasoning: { effort_values: ["low", "high"] } } },
      bad: "not-an-object",
      worse: { capabilities: { reasoning: { effort_values: 42 } } },
    },
  };
  assert.doesNotThrow(() => detectSupportedThinkingEfforts(record));
  assert.deepEqual(detectSupportedThinkingEfforts(record), ["low", "high"]);
});

test("no vendors key degrades to undefined (legacy behavior preserved)", () => {
  assert.equal(detectSupportedThinkingEfforts({ id: "plain/model" }), undefined);
  assert.equal(
    detectSupportedThinkingEfforts({ id: "plain/model", vendors: "not-a-map" }),
    undefined
  );
});

test("effort synonyms are normalized inside effort_values", () => {
  assert.deepEqual(detectSupportedThinkingEfforts(mergeRecord({ zai: ["low", "extra", "max"] })), [
    "low",
    "xhigh",
    "max",
  ]);
});

test("Merge defaultThinkingEffort falls back to the intersected vocabulary's highest tier", () => {
  // max survives both routes → default max.
  const withMax = mergeRecord({
    zai: ["low", "high", "max"],
    makora: ["none", "low", "high", "max"],
  });
  assert.equal(detectDefaultThinkingEffort(withMax), "max");
  // max only on one route → the intersection's highest (high) is the default.
  const withoutSharedMax = mergeRecord({
    zai: ["low", "high", "max"],
    baseten: ["low", "medium", "high"],
  });
  assert.equal(detectDefaultThinkingEffort(withoutSharedMax), "high");
});

test("explicit default_effort keeps precedence over the Merge vendors fallback", () => {
  const record = {
    ...mergeRecord({ zai: ["low", "high", "max"] }),
    reasoning: { default_effort: "high" },
  };
  assert.equal(detectDefaultThinkingEffort(record), "high");
});

test("normalizeDiscoveredModels threads the intersected Merge vocabulary into synced models", () => {
  const models = normalizeDiscoveredModels([
    {
      id: "zai/glm-5.3-flash",
      vendors: {
        zai: { capabilities: { reasoning: { effort_values: ["low", "high", "max"] } } },
        baseten: { capabilities: { reasoning: { effort_values: ["low", "high", "xhigh"] } } },
      },
    },
  ]);
  const synced = models.find((model) => model.id === "zai/glm-5.3-flash");
  assert.deepEqual(synced?.supportedThinkingEfforts, ["low", "high"]);
  assert.equal(synced?.defaultThinkingEffort, "high");
});
