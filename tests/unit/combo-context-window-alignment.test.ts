import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Live 2026-08-19: best-reasoning-paid dropped Codex/Cursor as unknown-window
// hops and collapsed to Kimi+Opus. Paid combo hops must resolve a known
// context window so a large prompt keeps every capable fallback.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-ctx-align-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { filterTargetsByRequestCompatibility } = await import(
  "../../open-sse/services/combo/comboStructure.ts"
);

test.after(() => {
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const PAID_HOPS = [
  "codex/gpt-5.6-sol-high",
  "cursor/cursor-grok-4.6-high",
  "cursor/composer-2.5",
  "cursor/composer-2.5-fast",
  "cursor/gemini-3.1-pro",
  "claude/claude-opus-5",
  "claude/claude-sonnet-5",
  "kimi-coding/k3",
  "kimi-coding/kimi-for-coding",
  "kiro/claude-sonnet-5",
  "moonshot/kimi-for-coding",
  "moonshot/k3-256k",
  "openrouter/x-ai/grok-4.6-high",
  "openrouter/anthropic/claude-sonnet-5",
  "openrouter/deepseek/deepseek-v4-flash",
  "openrouter/google/gemini-3.1-pro-preview",
] as const;

function target(modelStr: string) {
  return {
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

test("every paid-combo hop resolves a known context window", () => {
  const missing = PAID_HOPS.filter(
    (hop) => getResolvedModelCapabilities(hop).contextWindow == null
  );
  assert.deepEqual(missing, [], `unknown-window hops: ${missing.join(", ")}`);
});

test("Cursor registry lists grok-4.6-high and inherits defaultContextLength on composers", () => {
  const entry = getRegistryEntry("cursor");
  assert.ok(entry);
  assert.equal(entry.defaultContextLength, 200000);
  const grok = (entry.models ?? []).find((model) => model.id === "cursor-grok-4.6-high");
  assert.ok(grok, "cursor catalog must list cursor-grok-4.6-high");
  assert.ok(
    typeof grok.contextLength === "number" && grok.contextLength >= 500000,
    "cursor-grok-4.6-high must declare the xAI 500k window"
  );
  assert.equal(
    getResolvedModelCapabilities("cursor/composer-2.5").contextWindow,
    200000,
    "composer-2.5 must inherit Cursor defaultContextLength"
  );
  assert.equal(
    getResolvedModelCapabilities("cursor/composer-2.5-fast").contextWindow,
    200000
  );
});

test("Moonshot combo hop ids resolve the Kimi windows they actually are", () => {
  assert.equal(getResolvedModelCapabilities("moonshot/kimi-for-coding").contextWindow, 262144);
  assert.equal(getResolvedModelCapabilities("moonshot/k3-256k").contextWindow, 262144);
});

test("large-prompt filter keeps the full best-reasoning-paid membership", () => {
  const hops = [
    "codex/gpt-5.6-sol-high",
    "cursor/cursor-grok-4.6-high",
    "claude/claude-opus-5",
    "kimi-coding/k3",
    "openrouter/x-ai/grok-4.6-high",
  ];
  const out = filterTargetsByRequestCompatibility(
    hops.map(target),
    { messages: [{ role: "user", content: "x".repeat(80_000) }] },
    noopLog
  );
  assert.deepEqual(
    out.map((entry) => entry.modelStr),
    hops
  );
});
