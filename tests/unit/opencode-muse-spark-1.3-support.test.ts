import test from "node:test";
import assert from "node:assert/strict";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.ts";
import { opencode_goProvider } from "../../open-sse/config/providers/registry/opencode/go/index.ts";
import { opencode_zenProvider } from "../../open-sse/config/providers/registry/opencode/zen/index.ts";
import { opencodeProvider } from "../../open-sse/config/providers/registry/opencode/index.ts";
import { command_codeProvider } from "../../open-sse/config/providers/registry/command-code/index.ts";
import { parseEffortLevel } from "../../open-sse/executors/opencode.ts";

test("muse-spark-1.3 models route to Responses API on opencode, opencode-go, and opencode-zen", () => {
  const opencodeGoModels = [
    "muse-spark-1.3-contributor",
    "muse-spark-1.3-contributor-minimal",
    "muse-spark-1.3-contributor-low",
    "muse-spark-1.3-contributor-medium",
    "muse-spark-1.3-contributor-high",
    "muse-spark-1.3-contributor-xhigh",
  ];

  for (const id of opencodeGoModels) {
    assert.equal(
      getModelTargetFormat("opencode-go", id),
      "openai-responses",
      `getModelTargetFormat("opencode-go", "${id}") should be openai-responses`
    );
    assert.equal(
      getModelTargetFormat("ocg", id),
      "openai-responses",
      `getModelTargetFormat("ocg", "${id}") should be openai-responses`
    );
  }

  const opencodeModels = [
    "muse-spark-1.3",
    "muse-spark-1.3-contributor",
    "muse-spark-1.3-contributor-free",
  ];

  for (const id of opencodeModels) {
    assert.equal(
      getModelTargetFormat("opencode", id),
      "openai-responses",
      `getModelTargetFormat("opencode", "${id}") should be openai-responses`
    );
    assert.equal(
      getModelTargetFormat("opencode-zen", id),
      "openai-responses",
      `getModelTargetFormat("opencode-zen", "${id}") should be openai-responses`
    );
  }
});

test("muse-spark-1.3-contributor effort aliases parse correctly in opencode executor", () => {
  const parsed = parseEffortLevel("muse-spark-1.3-contributor-xhigh");
  assert.deepEqual(parsed, {
    baseModel: "muse-spark-1.3-contributor",
    effort: "xhigh",
  });
});

test("command-code registers meta/muse-spark-1.3-contributor", () => {
  const model = command_codeProvider.models.find((m) => m.id === "meta/muse-spark-1.3-contributor");
  assert.ok(model, "meta/muse-spark-1.3-contributor must be in command-code registry");
  assert.equal(model?.supportsReasoning, true);
  assert.equal(model?.supportsVision, true);
});
