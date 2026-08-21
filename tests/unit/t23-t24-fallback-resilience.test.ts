import test from "node:test";
import assert from "node:assert/strict";

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");

test.beforeEach(() => {
  resetAllCircuitBreakers();
});

function createLog() {
  const entries = [];
  return {
    info: (tag: string, msg: string) => entries.push({ level: "info", tag, msg }),
    warn: (tag: string, msg: string) => entries.push({ level: "warn", tag, msg }),
    error: (tag: string, msg: string) => entries.push({ level: "error", tag, msg }),
    debug: (tag: string, msg: string) => entries.push({ level: "debug", tag, msg }),
    entries,
  };
}

function createStatusSequenceHandler(sequence) {
  let idx = 0;
  return async () => {
    const step = sequence[idx++] || { status: 200 };
    if (step.status === 200) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        error: { message: step.message || `Error ${step.status}` },
      }),
      {
        status: step.status,
        headers: step.headers || { "content-type": "application/json" },
      }
    );
  };
}

test("T23: 429 with long Retry-After uses real reset cooldown instead of short exponential backoff", () => {
  const headers = new Headers({ "retry-after": "3600" });
  const result = checkFallbackError(429, "Rate limit exceeded", 2, null, "groq", headers);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.reason, "rate_limit_exceeded");
  assert.equal(result.newBackoffLevel, 0);
  assert.ok(result.cooldownMs > 3_590_000);
});

test("T24: combo awaits short 503 cooldown before falling through to next model", async () => {
  const log = createLog();

  const result = await handleComboChat({
    body: {},
    combo: {
      name: "t24-short-cooldown",
      strategy: "priority",
      // Cross-provider targets: a 503 marks the failing provider's remaining same-provider
      // targets for skip (#1731v2), so the fallthrough target must be a DIFFERENT provider
      // for this cooldown-wait test to exercise the fall-through-to-next-model path.
      models: [
        { model: "groq/model-a", weight: 0 },
        { model: "openai/model-b", weight: 0 },
      ],
      config: { fallbackDelayMs: 2000, maxRetries: 1 },
    },
    // Two transient failures on first model, then success on fallback model.
    handleSingleModel: createStatusSequenceHandler([
      { status: 503 },
      { status: 503 },
      { status: 200 },
    ]),
    isModelAvailable: () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  // checkFallbackError returns COOLDOWN_MS.transient (5000ms) for a plain 503.
  // fallbackDelayMs=2000, cooldownMs=5000 ≤ MAX_FALLBACK_WAIT_MS(5000) → fallbackWaitMs=2000ms.
  // The combo MUST emit a debug log before waiting, proving the wait behavior is wired.
  const waitLog = log.entries.find((e) => e.msg.includes("Waiting") && e.msg.includes("fallback"));
  assert.ok(waitLog, "combo must emit a debug wait-before-fallback log for short 503 cooldowns");
});

test("T24: combo skips wait when 503 cooldown is long (>5s)", async () => {
  const log = createLog();

  const result = await handleComboChat({
    body: {},
    combo: {
      name: "t24-long-cooldown",
      strategy: "priority",
      // Cross-provider targets (see t24-short-cooldown): the fall-through target must be a
      // different provider so the #1731v2 same-provider skip doesn't short-circuit it.
      models: [
        { model: "groq/model-a", weight: 0 },
        { model: "openai/model-b", weight: 0 },
      ],
      config: { fallbackDelayMs: 2000, maxRetries: 1 },
    },
    handleSingleModel: createStatusSequenceHandler([
      {
        status: 503,
        message: "rate limit exceeded",
        headers: { "content-type": "application/json", "retry-after": "120" },
      },
      {
        status: 503,
        message: "rate limit exceeded",
        headers: { "content-type": "application/json", "retry-after": "120" },
      },
      { status: 200 },
    ]),
    isModelAvailable: () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  const waitLog = log.entries.find((e) => e.msg.includes("Waiting") && e.msg.includes("fallback"));
  assert.equal(waitLog, undefined);
});

test("T24: all inactive accounts return 503 service_unavailable (not 406)", async () => {
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "t24-all-inactive",
      strategy: "priority",
      models: [
        { model: "groq/model-a", weight: 0 },
        { model: "groq/model-b", weight: 0 },
      ],
    },
    handleSingleModel: async () => {
      throw new Error("handleSingleModel should not be called when all models are unavailable");
    },
    isModelAvailable: () => false,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.status, 503);
  const body = (await result.json()) as any;
  assert.equal(body.error?.code, "ALL_ACCOUNTS_INACTIVE");
});

test("combo falls through 400s and reaches the next model", async () => {
  const calls = [];
  const sequence = [
    { status: 429, message: "No capacity available for model gemini-3.1-pro-preview" },
    { status: 400, message: "bad request" },
    { status: 200 },
  ];

  const result = await handleComboChat({
    body: {},
    combo: {
      name: "t24-provider-scoped-400",
      strategy: "priority",
      models: [
        { model: "free/gemini-3.1-pro-preview", weight: 0 },
        { model: "aio/gemini-3.1-pro-preview-thinking-high", weight: 0 },
        { model: "openrouter/google/gemini-3.1-pro-preview", weight: 0 },
      ],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body, modelStr) => {
      calls.push(modelStr);
      const step = sequence[calls.length - 1] || { status: 200 };
      if (step.status === 200) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: step.message } }), {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    },
    isModelAvailable: () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "free/gemini-3.1-pro-preview",
    "aio/gemini-3.1-pro-preview-thinking-high",
    "openrouter/google/gemini-3.1-pro-preview",
  ]);
});

test("combo does not leak a hop-local 403 credits body when a later hop succeeds", async () => {
  const calls = [];
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "billing-skip-then-codex",
      strategy: "priority",
      models: [
        { model: "claude/claude-opus-5", weight: 0, connectionId: "kopyt1" },
        { model: "codex/gpt-5.6-sol-high", weight: 0, connectionId: "codex1" },
      ],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr.startsWith("claude/")) {
        return new Response(
          JSON.stringify({
            error: { message: "You've reached your usage limit for this billing cycle" },
          }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    isModelAvailable: () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["claude/claude-opus-5", "codex/gpt-5.6-sol-high"]);
  const body = await result.json();
  assert.equal(JSON.stringify(body).includes("billing cycle"), false);
});

test("combo does not leak a hop-local 403 as the combo body when remaining hops were skipped", async () => {
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "billing-then-skipped",
      strategy: "priority",
      models: [
        { model: "kimi/k2.5", weight: 0, connectionId: "kimi1" },
        { model: "codex/gpt-5.6-sol-high", weight: 0, connectionId: "codex1" },
      ],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body, modelStr) => {
      if (String(modelStr).startsWith("kimi/")) {
        return new Response(
          JSON.stringify({ error: { message: "out of credits" } }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`should not dispatch skipped hop ${modelStr}`);
    },
    isModelAvailable: (_modelStr, target) => !String(target?.modelStr ?? _modelStr).startsWith("codex/"),
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  const body = await result.json();
  const text = JSON.stringify(body);
  assert.equal(text.includes("out of credits"), false);
  assert.equal(body.error?.code, "ALL_ACCOUNTS_INACTIVE");
});

test("cursor-agent stream timeout before first token fails over to the next hop", async () => {
  // Live 2026-08-19: best-chat-paid / main burned 300s on composer-2.5*,
  // logged cursor 502, and never dispatched Claude/Kiro (same cid had no
  // 200 sibling). Combo must treat that 200+dead-SSE as a hop failure.
  const calls: string[] = [];
  const deadSse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("cursor-agent stream timed out"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  const result = await handleComboChat({
    body: { stream: true },
    combo: {
      name: "best-chat-paid",
      strategy: "priority",
      models: [
        { model: "cursor/composer-2.5-fast", weight: 0 },
        { model: "claude/claude-sonnet-5", weight: 0 },
      ],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body, modelStr) => {
      calls.push(String(modelStr));
      if (String(modelStr).startsWith("cursor/")) return deadSse();
      return new Response(JSON.stringify({ ok: true, model: modelStr }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    isModelAvailable: () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.deepEqual(calls, ["cursor/composer-2.5-fast", "claude/claude-sonnet-5"]);
  assert.equal(result.ok, true, "Claude must serve after Cursor's empty-stream timeout");
});

test("one-hop cheap combo must not 502 when the hop returns keepalive-prefixed SSE", async () => {
  const sse =
    ': keep-alive\n\ndata: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n';
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "cheap",
      strategy: "priority",
      models: [{ model: "openrouter/deepseek/deepseek-v4-flash", weight: 0 }],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    isModelAvailable: () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true, "a 200 SSE hop is usable — do not crystallize a quality 502");
});
