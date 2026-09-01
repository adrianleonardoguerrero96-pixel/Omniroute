/**
 * #12254 — end-to-end reproduction at the actual regressed call site.
 *
 * Before the fix, executeChatWithBreaker dispatched chatFn through
 * breaker.execute(), which calls _onSuccess() for ANY non-throwing
 * resolution — including handleChatCore's normal `{success:false,
 * status:5xx}` return for an ordinary upstream failure. Every failed
 * dispatch through this call site therefore also silently decremented
 * failureCount via _onSuccess()'s `Math.max(0, failureCount - 1)`,
 * corrupting the breaker's own accounting regardless of what chat.ts's
 * explicit _onFailure() call sites did afterward.
 *
 * This test drives real upstream 502s through executeChatWithBreaker (via a
 * mocked global.fetch, same pattern as
 * execute-chat-resource-pressure-breaker.test.ts) and asserts the breaker
 * accumulates NO implicit accounting from this call site — success/failure
 * accounting for a resolved (non-throwing) result is the caller's job.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-breaker-accounting-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { executeChatWithBreaker } = await import("../../src/sse/handlers/chatHelpers.ts");
const { getCircuitBreaker, resetAllCircuitBreakers, STATE } =
  await import("../../src/shared/utils/circuitBreaker.ts");
const { reloadResourcePressureRuntime } = await import("../../open-sse/utils/resourcePressure.ts");

const MiB = 1024 ** 2;

async function resetStorage() {
  resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  reloadResourcePressureRuntime({
    heapThresholdMb: 10_000,
    immediateHeapUsedMb: () => 1,
    sample: async () => ({
      observedAtMs: Date.now(),
      v8: { heapUsedBytes: MiB, heapLimitBytes: 10_000 * MiB },
      process: {
        rssBytes: MiB,
        externalBytes: 0,
        arrayBuffersBytes: 0,
        availableBytes: null,
        constrainedBytes: null,
      },
      cgroup: {
        currentBytes: null,
        maxBytes: null,
        highBytes: null,
        fileBytes: null,
        events: null,
      },
      psi: null,
    }),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("executeChatWithBreaker does not implicitly account a resolved upstream 502 as a breaker success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "bad gateway" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });

  try {
    const provider = "openai-12254-accounting";
    const breaker = getCircuitBreaker(provider);
    assert.equal(breaker.state, STATE.CLOSED);
    assert.equal(breaker.failureCount, 0);

    const credentials = {
      connectionId: "conn_12254",
      apiKey: "sk-12254",
      providerSpecificData: {},
    };

    const baseExecution = {
      bypassCircuitBreaker: false,
      breaker,
      body: { model: `${provider}/gpt-4o-mini`, messages: [{ role: "user", content: "x" }] },
      provider,
      model: "gpt-4o-mini",
      refreshedCredentials: credentials,
      proxyInfo: null,
      log: console,
      clientRawRequest: { endpoint: "/v1/chat/completions", headers: {}, body: {} },
      credentials,
      apiKeyInfo: null,
      userAgent: "",
      comboName: null,
      comboStrategy: null,
      isCombo: false,
      extendedContext: false,
      comboStepId: null,
      comboExecutionKey: null,
    };

    for (let i = 0; i < 6; i++) {
      const execution = await executeChatWithBreaker(baseExecution as never);
      assert.ok("result" in execution, `expected a dispatched result on iteration ${i}`);
    }

    const after = breaker.getStatus();
    assert.equal(
      after.failureCount,
      0,
      "executeChatWithBreaker must not implicitly account a resolved (non-throwing) result — " +
        "the old execute()-based path called _onSuccess() here on every one of these calls"
    );
    assert.equal(after.state, STATE.CLOSED);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
