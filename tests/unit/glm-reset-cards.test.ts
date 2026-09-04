import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-glm-reset-cards-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-glm-reset-cards-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const glmResetCards = await import("../../src/lib/usage/glmResetCards.ts");
const wire = await import("../../open-sse/services/usage/glmResetCards.ts");
const glmProvider = await import("../../open-sse/config/glmProvider.ts");
const uiUtils = await import(
  "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx"
);

const originalFetch = globalThis.fetch;

/** The exact envelope z.ai returns for an account with no cards banked. */
const EMPTY_LIST_ENVELOPE = {
  code: 200,
  msg: "Operation successful",
  data: {
    customerId: 75751781508272646,
    targetType: "PERSONAL",
    organizationId: null,
    projectId: null,
    lastFiveHourResetTime: null,
    lastWeekResetTime: "2026-09-04 18:39:23",
    fiveHourResets: [],
    weekResets: [],
  },
  success: true,
};

function listEnvelopeWith(overrides: Record<string, unknown>) {
  return {
    ...EMPTY_LIST_ENVELOPE,
    data: { ...EMPTY_LIST_ENVELOPE.data, ...overrides },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createGlmConnection(overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    name: `GLM Reset ${Date.now()} ${Math.random()}`,
    apiKey: "glm-test-key",
    ...overrides,
  });
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("parseGlmResetCards reports no cards for an account with both buckets empty", () => {
  const parsed = wire.parseGlmResetCards(EMPTY_LIST_ENVELOPE);
  assert.equal(parsed.availableCount, 0);
  assert.deepEqual(parsed.cards, []);
  assert.equal(parsed.lastWeekResetAt, "2026-09-04 18:39:23");
  assert.equal(parsed.lastFiveHourResetAt, null);
});

test("parseGlmResetCards derives the reset window from the bucket it came from", () => {
  const parsed = wire.parseGlmResetCards(
    listEnvelopeWith({
      fiveHourResets: [{ recordId: 111 }],
      weekResets: [{ recordId: 124128 }],
    })
  );

  assert.equal(parsed.availableCount, 2);
  assert.deepEqual(
    parsed.cards.map((card) => [card.id, card.resetType]),
    [
      ["111", "FIVE_HOUR"],
      ["124128", "WEEK"],
    ]
  );
});

test("parseGlmResetCards prefers an explicit resetType and skips entries without an id", () => {
  const parsed = wire.parseGlmResetCards(
    listEnvelopeWith({
      fiveHourResets: [{ recordId: 222, resetType: "WEEK" }, { packageName: "no id here" }],
    })
  );

  assert.equal(parsed.availableCount, 1);
  assert.equal(parsed.cards[0].resetType, "WEEK");
});

test("z.ai failure envelopes are detected despite the HTTP 200 status line", () => {
  // Observed live: no auth header → code 1001, bad Bearer token → code 401.
  const missingAuth = { code: 1001, msg: "Authentication parameter not received in Header" };
  const badToken = { code: 401, msg: "token expired or incorrect", success: false };

  assert.equal(wire.isGlmResetCardEnvelopeOk(missingAuth), false);
  assert.equal(wire.isGlmResetCardEnvelopeOk(badToken), false);
  assert.equal(wire.isGlmResetCardEnvelopeOk(EMPTY_LIST_ENVELOPE), true);

  assert.equal(wire.getGlmResetCardEnvelopeStatus(missingAuth, 200), 401);
  assert.equal(wire.getGlmResetCardEnvelopeStatus(badToken, 200), 401);
  assert.equal(wire.getGlmResetCardEnvelopeMessage(badToken), "token expired or incorrect");
});

test("buildGlmResetCardFetch targets the right host, path and headers per region", () => {
  const list = glmProvider.buildGlmResetCardFetch("key-1", undefined, "list");
  assert.equal(list.url, "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL");
  assert.equal(list.headers.Authorization, "Bearer key-1");
  assert.equal(list.headers["Content-Type"], undefined);

  const use = glmProvider.buildGlmResetCardFetch("key-1", { apiRegion: "china" }, "use");
  assert.equal(use.url, "https://open.bigmodel.cn/api/biz/customer-package-reset/use");
  assert.equal(use.headers["Content-Type"], "application/json");

  const team = glmProvider.buildGlmResetCardFetch(
    "key-1",
    { glmOrganizationId: "org-1", glmProjectId: "proj-1" },
    "list"
  );
  assert.equal(team.headers["bigmodel-organization"], "org-1");
  assert.equal(team.headers["bigmodel-project"], "proj-1");
});

test("consumeGlmResetCard redeems the listed card with z.ai's wire body, then refreshes usage", async () => {
  const connection = (await createGlmConnection()) as { id: string };
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });

    if (href.includes("/customer-package-reset/list")) {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer glm-test-key");
      return json(listEnvelopeWith({ weekResets: [{ recordId: 124128 }] }));
    }

    if (href.includes("/customer-package-reset/use")) {
      assert.deepEqual(JSON.parse(String(init.body)), {
        targetType: "PERSONAL",
        resetType: "WEEK",
        recordId: 124128,
        requestId: "redeem-1",
      });
      return json({ code: 200, msg: "Operation successful", data: 124128, success: true });
    }

    if (href.includes("/monitor/usage/quota/limit")) {
      return json({
        code: 200,
        success: true,
        data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 0 }] },
      });
    }

    return new Response("unexpected", { status: 500 });
  };

  const result = await glmResetCards.consumeGlmResetCard(connection.id, "redeem-1");

  assert.equal(result.outcome, "reset");
  assert.ok(
    calls.some((call) => call.url.includes("/customer-package-reset/use")),
    "expected the redemption call to be issued"
  );
});

test("consumeGlmResetCard reports a 409 when nothing is banked", async () => {
  const connection = (await createGlmConnection()) as { id: string };

  globalThis.fetch = async (url) => {
    if (String(url).includes("/customer-package-reset/list")) return json(EMPTY_LIST_ENVELOPE);
    return new Response("unexpected", { status: 500 });
  };

  await assert.rejects(
    () => glmResetCards.consumeGlmResetCard(connection.id, "redeem-2"),
    (error: InstanceType<typeof glmResetCards.GlmResetCardError>) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "no_reset_card");
      return true;
    }
  );
});

test("non-GLM connections are rejected before any upstream call", async () => {
  const connection = (await createGlmConnection({
    provider: "openai",
    apiKey: "sk-openai",
  })) as { id: string };

  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("unexpected", { status: 500 });
  };

  await assert.rejects(
    () => glmResetCards.listGlmResetCards(connection.id),
    (error: InstanceType<typeof glmResetCards.GlmResetCardError>) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "glm_provider_required");
      return true;
    }
  );
  assert.equal(called, false, "no upstream request should be made for a non-GLM provider");
});

test("fetchGlmResetCardCount stays best-effort when the endpoint fails", async () => {
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await wire.fetchGlmResetCardCount("glm-test-key"), 0);

  globalThis.fetch = async () => json({ code: 401, msg: "token expired or incorrect" });
  assert.equal(await wire.fetchGlmResetCardCount("glm-test-key"), 0);
});

test("the redeem button unlocks for the GLM family, not only for Codex", () => {
  const quotas = [{ isResetCredits: true, creditCount: 1 }];

  for (const provider of ["codex", "glm", "glm-cn", "glmt", "zai"]) {
    assert.equal(
      uiUtils.computeCanRedeemResetCredit(provider, quotas),
      true,
      `${provider} should be able to redeem`
    );
  }

  assert.equal(uiUtils.computeCanRedeemResetCredit("openai", quotas), false);
  assert.equal(uiUtils.computeCanRedeemResetCredit("glm", [{ isResetCredits: true }]), false);
  assert.equal(uiUtils.getResetCreditEndpoint("codex"), "/api/usage/codex-reset-credit");
  assert.equal(uiUtils.getResetCreditEndpoint("glm"), "/api/usage/glm-reset-card");
});
