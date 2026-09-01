/**
 * Regression tests for #12254 — CircuitBreaker.execute() counted a resolved
 * `{success:false, status:5xx}` value as a success, because it only checks
 * whether fn() threw. That call shape is exactly what handleChatCore returns
 * for ordinary upstream failures (it does not throw), so every dispatch
 * through execute() called _onSuccess() regardless of the actual outcome.
 * In CLOSED state, _onSuccess() does `failureCount = Math.max(0, failureCount
 * - 1)`, which silently cancelled the very next explicit _onFailure() call
 * site (chat.ts / accountFallback.ts) for the same attempt — capping
 * failureCount at ~1 forever and preventing the breaker from ever opening.
 *
 * Fix: executeTrackingFailureOnly() never calls _onSuccess() on a
 * non-throwing resolution. Failure accounting on an actual throw is
 * unchanged from execute() (same gating, same isFailure/classifyError).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  resetAllCircuitBreakers,
} from "../../src/shared/utils/circuitBreaker.ts";

const uniqueName = (suffix: string) =>
  `cb-test-#12254-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("executeTrackingFailureOnly does not call _onSuccess when fn resolves without throwing", async () => {
  const cb = new CircuitBreaker(uniqueName("no-implicit-success"), {
    failureThreshold: 5,
    resetTimeout: 30_000,
  });

  for (let i = 0; i < 10; i++) {
    const result = await cb.executeTrackingFailureOnly(async () => ({
      success: false,
      status: 503,
    }));
    assert.deepEqual(result, { success: false, status: 503 });
  }

  assert.equal(cb.failureCount, 0, "no accounting happens on a resolved (non-throwing) call");
  assert.equal(cb.successCount, 0);
  assert.equal(cb.state, "CLOSED");
  cb.reset();
});

test("executeTrackingFailureOnly still records _onFailure on a genuine throw, honoring classifyError", async () => {
  const cb = new CircuitBreaker(uniqueName("throw-classify"), {
    failureThreshold: 1,
    resetTimeout: 1_000,
    cooldownByKind: { quota_exhausted: 600_000 },
    classifyError: (err: unknown) =>
      err instanceof Error && err.message.includes("daily limit") ? "quota_exhausted" : "transient",
  });

  await assert.rejects(async () => {
    await cb.executeTrackingFailureOnly(async () => {
      throw new Error("You exceeded your daily limit");
    });
  });

  assert.equal(cb.state, "OPEN");
  assert.equal(cb.lastFailureKind, "quota_exhausted");
  cb.reset();
});

test("consecutive genuine failures escalate to OPEN without being cancelled by interleaved non-throwing calls", async () => {
  // This is the exact shape of the reported bug: a mix of calls that resolve
  // to {success:false} (never throw — like ordinary upstream 5xx responses)
  // and calls that genuinely throw (the manual _onFailure() call sites in
  // chat.ts / accountFallback.ts model the resolved-failure case separately;
  // this test only proves executeTrackingFailureOnly's own throw-accounting
  // is not corrupted by interleaved non-throwing resolutions).
  const cb = new CircuitBreaker(uniqueName("interleaved"), {
    failureThreshold: 3,
    resetTimeout: 30_000,
  });

  const resolveNoThrow = () => cb.executeTrackingFailureOnly(async () => ({ success: false }));
  const throwFailure = () =>
    cb.executeTrackingFailureOnly(async () => {
      throw new Error("upstream exploded");
    });

  await resolveNoThrow();
  await assert.rejects(throwFailure);
  assert.equal(cb.failureCount, 1);

  await resolveNoThrow();
  await assert.rejects(throwFailure);
  assert.equal(cb.failureCount, 2);
  assert.equal(cb.state, "DEGRADED", `expected DEGRADED at 2/3, got ${cb.state}`);

  await resolveNoThrow();
  await assert.rejects(throwFailure);
  assert.equal(cb.failureCount, 3);
  assert.equal(cb.state, "OPEN", `breaker must open at threshold, got ${cb.state}`);

  cb.reset();
});

test("executeTrackingFailureOnly rejects immediately while OPEN, same as execute()", async () => {
  const cb = new CircuitBreaker(uniqueName("open-gate"), {
    failureThreshold: 1,
    resetTimeout: 60_000,
  });
  cb._onFailure();
  assert.equal(cb.state, "OPEN");

  let called = false;
  await assert.rejects(
    cb.executeTrackingFailureOnly(async () => {
      called = true;
      return "unreachable";
    }),
    CircuitBreakerOpenError
  );
  assert.equal(called, false, "fn must not run while OPEN");
  cb.reset();
});

test("executeTrackingFailureOnly honors HALF_OPEN probe-count gating", async () => {
  const cb = new CircuitBreaker(uniqueName("half-open-gate"), {
    failureThreshold: 1,
    resetTimeout: 10,
    halfOpenRequests: 1,
  });
  cb._onFailure();
  assert.equal(cb.state, "OPEN");
  await new Promise((r) => setTimeout(r, 20));

  // First call transitions OPEN -> HALF_OPEN and consumes the single probe slot.
  await cb.executeTrackingFailureOnly(async () => "probe-ok");
  assert.equal(cb.state, "HALF_OPEN", "a resolved probe does not itself close the breaker");

  // Second call has no probe slots left.
  await assert.rejects(
    cb.executeTrackingFailureOnly(async () => "should-not-run"),
    CircuitBreakerOpenError
  );
  cb.reset();
});

test("teardown — reset all circuit breakers", () => {
  resetAllCircuitBreakers();
});
