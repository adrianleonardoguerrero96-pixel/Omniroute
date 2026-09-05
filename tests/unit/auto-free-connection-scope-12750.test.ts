import test from "node:test";
import assert from "node:assert/strict";

import { createVirtualAutoComboFromPrepared } from "../../open-sse/services/autoCombo/virtualFactory.ts";

test("auto/*:free narrows dispatch to the connections that reported a model free", async () => {
  const candidate = {
    provider: "openai",
    connectionId: null,
    allowedConnectionIds: ["free-account", "paid-account"],
    freeConnectionIds: ["free-account"],
    model: "gpt-4o",
    modelStr: "openai/gpt-4o",
    costPer1MTokens: 2.5,
    resolvedContextLength: 128000,
    resolvedMaxOutputTokens: 16384,
    resolvedSupportsVision: true,
    resolvedReasoning: false,
    resolvedSupportsThinking: false,
  };

  const combo = await createVirtualAutoComboFromPrepared(
    { regularCandidates: [candidate], familyCandidates: [candidate] },
    undefined,
    { tier: "free" }
  );

  assert.equal(combo.models.length, 1);
  assert.deepEqual(combo.models[0]?.allowedConnectionIds, ["free-account"]);
});

test("auto/*:free keeps provider-wide scope for models that are globally classified free", async () => {
  const candidate = {
    provider: "openai",
    connectionId: null,
    allowedConnectionIds: ["account-a", "account-b"],
    freeConnectionIds: ["account-a"],
    model: "qwen3-coder-plus",
    modelStr: "openai/qwen3-coder-plus",
    costPer1MTokens: 0,
    resolvedContextLength: 128000,
    resolvedMaxOutputTokens: 16384,
    resolvedSupportsVision: false,
    resolvedReasoning: false,
    resolvedSupportsThinking: false,
  };

  const combo = await createVirtualAutoComboFromPrepared(
    { regularCandidates: [candidate], familyCandidates: [candidate] },
    undefined,
    { tier: "free" }
  );

  assert.equal(combo.models.length, 1);
  assert.deepEqual(combo.models[0]?.allowedConnectionIds, ["account-a", "account-b"]);
});
