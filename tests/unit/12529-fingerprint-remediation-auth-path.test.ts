import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression guard for #12529, on the CONSUMER path (maintainer request on the
// PR): classifyProviderError() already returns FINGERPRINT_REJECTION for the
// Cloudflare 1010 case — the defect was that its only production consumer,
// resolveTerminalConnectionStatus() (src/sse/services/auth.ts), silently
// returned null for it, so the classification was computed and discarded
// without anything ever pointing at ENABLE_TLS_FINGERPRINT. A classifier-only
// unit passes both before and after the change; this file drives the real
// auth.ts flow (markAccountUnavailable → classifyProviderError →
// resolveTerminalConnectionStatus) and asserts BOTH that the account stays
// healthy AND that the remediation hint actually fires from that path.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-12529-tls-hint-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const classifier = await import("../../open-sse/services/errorClassifier.ts");

const CLOUDFLARE_1010_BODY =
  '{"error":{"message":"Access denied (error_code: 1010). The owner of this website has banned your access based on your browser\'s signature.","error_code":1010,"error_name":"browser_signature_banned"}}';

const HINT_MARKER = "[errorClassifier] Cloudflare fingerprint rejection";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/** Capture console.warn emissions without leaking other output. */
function captureWarnings() {
  const original = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => {
    seen.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return {
    hints: () => seen.filter((line) => line.includes(HINT_MARKER)),
    restore: () => {
      console.warn = original;
    },
  };
}

async function createOpencodeConnection(): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: "opencode-go",
    authType: "apikey",
    apiKey: "sk-opencode-test",
    isActive: true,
    testStatus: "active",
  });
  return String(conn.id);
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("auth path: a Cloudflare 1010 markAccountUnavailable keeps the account healthy AND fires the remediation hint", async (t) => {
  const prevFlag = process.env.ENABLE_TLS_FINGERPRINT;
  delete process.env.ENABLE_TLS_FINGERPRINT;
  classifier.resetFingerprintRemediationHintForTest();
  await resetStorage();
  const connId = await createOpencodeConnection();
  const capture = captureWarnings();
  t.after(() => {
    capture.restore();
    if (prevFlag === undefined) delete process.env.ENABLE_TLS_FINGERPRINT;
    else process.env.ENABLE_TLS_FINGERPRINT = prevFlag;
  });

  await auth.markAccountUnavailable(connId, 403, CLOUDFLARE_1010_BODY, "opencode-go", "glm-5.3-flash");

  // The consumer's contract: the CDN's rejection of the CLIENT signature must
  // never flip the account to a terminal state (banned/expired/credits_exhausted).
  const after = await providersDb.getProviderConnectionById(connId);
  assert.notEqual(after, null);
  assert.equal(after.isActive, true, "connection row should stay active");
  assert.notEqual(after.testStatus, "banned");
  assert.notEqual(after.testStatus, "expired");
  assert.notEqual(after.testStatus, "credits_exhausted");

  // The actual defect this PR fixes: the hint must reach the operator from the
  // production consumer path, not only from direct classifier calls.
  const hints = capture.hints();
  assert.equal(hints.length, 1, "exactly one hint on the first 1010 through auth");
  assert.match(hints[0], /ENABLE_TLS_FINGERPRINT=true/);
  assert.match(hints[0], /wreq-js/);
});

test("auth path: repeated 1010s through auth stay throttled to one hint", async (t) => {
  const prevFlag = process.env.ENABLE_TLS_FINGERPRINT;
  delete process.env.ENABLE_TLS_FINGERPRINT;
  classifier.resetFingerprintRemediationHintForTest();
  await resetStorage();
  const connId = await createOpencodeConnection();
  const capture = captureWarnings();
  t.after(() => {
    capture.restore();
    if (prevFlag === undefined) delete process.env.ENABLE_TLS_FINGERPRINT;
    else process.env.ENABLE_TLS_FINGERPRINT = prevFlag;
  });

  await auth.markAccountUnavailable(connId, 403, CLOUDFLARE_1010_BODY, "opencode-go", "glm-5.3-flash");
  await auth.markAccountUnavailable(connId, 403, CLOUDFLARE_1010_BODY, "opencode-go", "glm-5.3-flash");
  await auth.markAccountUnavailable(connId, 403, CLOUDFLARE_1010_BODY, "opencode-go", "glm-5.3-flash");

  assert.equal(capture.hints().length, 1, "throttled once per process across repeats");
});

test("auth path: hint is suppressed when ENABLE_TLS_FINGERPRINT=true", async (t) => {
  const prevFlag = process.env.ENABLE_TLS_FINGERPRINT;
  process.env.ENABLE_TLS_FINGERPRINT = "true";
  classifier.resetFingerprintRemediationHintForTest();
  await resetStorage();
  const connId = await createOpencodeConnection();
  const capture = captureWarnings();
  t.after(() => {
    capture.restore();
    if (prevFlag === undefined) delete process.env.ENABLE_TLS_FINGERPRINT;
    else process.env.ENABLE_TLS_FINGERPRINT = prevFlag;
  });

  await auth.markAccountUnavailable(connId, 403, CLOUDFLARE_1010_BODY, "opencode-go", "glm-5.3-flash");

  assert.equal(capture.hints().length, 0, "no hint when the transport is already enabled");
  const after = await providersDb.getProviderConnectionById(connId);
  assert.equal(after.isActive, true);
});
