import { test } from "vitest";
import assert from "node:assert/strict";

import { createVirtualAutoComboFromPrepared } from "../../../open-sse/services/autoCombo/virtualFactory.ts";

const candidate = {
  provider: "example-provider",
  connectionId: null,
  allowedConnectionIds: ["free-account", "paid-account"],
  freeConnectionIds: ["free-account"],
  model: "model-a",
  modelStr: "example-provider/model-a",
  costPer1MTokens: 0,
};

test("auto/coding:free narrows dispatch to the connection that reported the model free", async () => {
  const combo = await createVirtualAutoComboFromPrepared(
    { regularCandidates: [candidate], familyCandidates: [candidate] },
    undefined,
    { category: "coding", tier: "free" }
  );

  assert.equal(combo.models.length, 1);
  assert.deepEqual(combo.models[0]?.allowedConnectionIds, ["free-account"]);
});
