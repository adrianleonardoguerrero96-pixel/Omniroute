import assert from "node:assert/strict";
import test from "node:test";
import { shouldPreserveScheduledQuotaCooldown, buildCredentialTestStatusUpdate } from "../../src/lib/quota/connectionRecovery.ts";

const NOW = Date.parse("2026-08-18T23:50:00.000Z");
const FUTURE = "2026-08-19T00:49:44.973Z";
const PAST = "2026-08-18T20:00:00.000Z";

test("shouldPreserveScheduledQuotaCooldown keeps a future quota_exhausted unavailable window", () => {
  assert.equal(
    shouldPreserveScheduledQuotaCooldown(
      {
        id: "kimi",
        testStatus: "unavailable",
        lastErrorType: "quota_exhausted",
        rateLimitedUntil: FUTURE,
      },
      NOW
    ),
    true
  );
});

test("shouldPreserveScheduledQuotaCooldown keeps a future Claude rate_limited 429 window", () => {
  assert.equal(
    shouldPreserveScheduledQuotaCooldown(
      {
        id: "kopyt1",
        testStatus: "unavailable",
        lastErrorType: "rate_limited",
        rateLimitedUntil: FUTURE,
      },
      NOW
    ),
    true
  );
});

test("shouldPreserveScheduledQuotaCooldown does not keep a timeout/backoff crash-stale window", () => {
  assert.equal(
    shouldPreserveScheduledQuotaCooldown(
      {
        id: "openai",
        testStatus: "unavailable",
        lastErrorType: "timeout",
        rateLimitedUntil: FUTURE,
      },
      NOW
    ),
    false
  );
});

test("shouldPreserveScheduledQuotaCooldown does not keep a short rate_limited backoff window", () => {
  assert.equal(
    shouldPreserveScheduledQuotaCooldown(
      {
        id: "glm",
        testStatus: "unavailable",
        lastErrorType: "rate_limited",
        rateLimitedUntil: new Date(NOW + 60_000).toISOString(),
      },
      NOW
    ),
    false
  );
});

test("shouldPreserveScheduledQuotaCooldown does not keep an elapsed rate_limited window", () => {
  assert.equal(
    shouldPreserveScheduledQuotaCooldown(
      {
        id: "kopyt1",
        testStatus: "unavailable",
        lastErrorType: "rate_limited",
        rateLimitedUntil: PAST,
      },
      NOW
    ),
    false
  );
});

test("buildCredentialTestStatusUpdate keeps a future rate_limited window on a valid /test", () => {
  const until = "2026-08-19T01:40:47.909Z";
  const update = buildCredentialTestStatusUpdate({
    id: "kopyt1",
    testStatus: "unavailable",
    lastErrorType: "rate_limited",
    rateLimitedUntil: until,
    resultValid: true,
    nowIso: "2026-08-19T00:46:00.000Z",
  });
  assert.equal(update.testStatus, "unavailable");
  assert.equal(update.rateLimitedUntil, until);
  assert.equal(update.lastErrorType, "rate_limited");
  assert.equal(update.lastTested, "2026-08-19T00:46:00.000Z");
});

test("buildCredentialTestStatusUpdate still marks active when no scheduled window", () => {
  const update = buildCredentialTestStatusUpdate({
    id: "glm",
    testStatus: "unavailable",
    lastErrorType: "timeout",
    rateLimitedUntil: "2026-08-19T00:47:00.000Z",
    resultValid: true,
    nowIso: "2026-08-19T00:46:00.000Z",
  });
  assert.equal(update.testStatus, "active");
  assert.equal(update.rateLimitedUntil, null);
});
