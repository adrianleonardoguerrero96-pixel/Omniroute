/**
 * usage/glmResetCards.ts — GLM Coding Plan Reset Card wire layer.
 *
 * z.ai sells "Reset Cards" that clear an exhausted GLM coding-plan window (the 5-hour or the
 * weekly one) before it would roll over on its own. z.ai's dashboard drives them through two
 * endpoints that sit next to the quota endpoint this file's sibling `glm.ts` already polls:
 *
 *   GET  /api/biz/customer-package-reset/list?targetType=PERSONAL
 *   POST /api/biz/customer-package-reset/use
 *
 * Both accept the same `Authorization: Bearer <apiKey>` credential as
 * `/api/monitor/usage/quota/limit`, so no new credential type is involved. Verified against
 * the live endpoint: with no auth header it answers `code: 1001` ("Authentication parameter
 * not received in Header"); with a Bearer token it answers `code: 401` ("token expired or
 * incorrect") — i.e. the header is consumed and validated exactly like on the quota route.
 *
 * Like the rest of the z.ai API these endpoints answer HTTP 200 even when they fail and carry
 * the real status inside the body (`success: false` + `code`), so callers must inspect the
 * envelope rather than `response.ok` alone.
 *
 * Transport only: no DB access and no credential lookup. Connection-aware orchestration lives
 * in `src/lib/usage/glmResetCards.ts`.
 */

import { buildGlmResetCardFetch, type GlmResetCardAction } from "../../config/glmProvider.ts";
import { toNumber, toRecord } from "./scalars.ts";

type JsonRecord = Record<string, unknown>;

/** The target z.ai's dashboard uses for individual coding-plan keys. */
export const GLM_RESET_CARD_TARGET_TYPE = "PERSONAL";

const GLM_RESET_CARD_TIMEOUT_MS = 15_000;

/**
 * Which window a card resets. z.ai groups banked cards into two arrays and echoes the
 * matching `resetType` back in the redeem body (`WEEK` observed on the wire). An item that
 * carries its own `resetType` always wins over the array-derived default.
 */
export type GlmResetWindow = "FIVE_HOUR" | "WEEK";

const GLM_RESET_CARD_BUCKETS: ReadonlyArray<{ key: string; resetType: GlmResetWindow }> = [
  { key: "fiveHourResets", resetType: "FIVE_HOUR" },
  { key: "weekResets", resetType: "WEEK" },
];

export interface GlmResetCard {
  /** z.ai's `recordId`, carried as a string; sent back as a number. */
  id: string;
  resetType: GlmResetWindow;
  expiresAt?: string | null;
  title?: string;
}

export interface GlmResetCardList {
  cards: GlmResetCard[];
  availableCount: number;
  /** When each window was last reset, as reported by z.ai (display only). */
  lastFiveHourResetAt: string | null;
  lastWeekResetAt: string | null;
}

function firstString(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function parseResetWindow(value: unknown, fallback: GlmResetWindow): GlmResetWindow {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized === "WEEK" || normalized === "FIVE_HOUR") return normalized;
  return fallback;
}

function parseResetCard(value: unknown, fallbackType: GlmResetWindow): GlmResetCard | null {
  const record = toRecord(value);
  if (Object.keys(record).length === 0) return null;

  const id = firstString(record, ["recordId", "id", "packageResetId", "resetId"]);
  if (!id) return null;

  const expiresAt = firstString(record, ["expireTime", "expiredTime", "expiresAt", "endTime"]);
  const title = firstString(record, ["packageName", "name", "title"]);

  return {
    id,
    resetType: parseResetWindow(record.resetType ?? record.type, fallbackType),
    ...(expiresAt ? { expiresAt } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * Parse the `/customer-package-reset/list` envelope into the cards redeemable right now.
 *
 * Both buckets are read defensively: an account with none left reports them as empty arrays
 * (the common case), and the per-item shape is matched on several key spellings because z.ai
 * only populates it while a card is actually banked.
 */
export function parseGlmResetCards(payload: unknown): GlmResetCardList {
  const data = toRecord(toRecord(payload).data);
  const cards: GlmResetCard[] = [];

  for (const bucket of GLM_RESET_CARD_BUCKETS) {
    const entries = data[bucket.key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const card = parseResetCard(entry, bucket.resetType);
      if (card) cards.push(card);
    }
  }

  return {
    cards,
    availableCount: cards.length,
    lastFiveHourResetAt: firstString(data, ["lastFiveHourResetTime"]),
    lastWeekResetAt: firstString(data, ["lastWeekResetTime"]),
  };
}

/** True when the z.ai envelope reports success — HTTP 200 alone is not enough. */
export function isGlmResetCardEnvelopeOk(payload: unknown): boolean {
  const record = toRecord(payload);
  if (record.success === false) return false;
  const code = toNumber(record.code, 200);
  return code === 0 || code === 200;
}

/** The upstream status carried inside the envelope, falling back to the HTTP status. */
export function getGlmResetCardEnvelopeStatus(payload: unknown, httpStatus: number): number {
  const code = toNumber(toRecord(payload).code, 0);
  if (code === 401 || code === 403 || code === 404 || code === 429) return code;
  // 1001 = "Authentication parameter not received in Header".
  if (code === 1001) return 401;
  return httpStatus;
}

/** The upstream message carried inside the envelope, if any. */
export function getGlmResetCardEnvelopeMessage(payload: unknown): string | null {
  const record = toRecord(payload);
  const message = record.msg ?? record.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

async function requestGlmResetCards(
  apiKey: string,
  providerSpecificData: unknown,
  action: GlmResetCardAction,
  body?: JsonRecord
): Promise<{ response: Response; payload: unknown }> {
  const { url, headers } = buildGlmResetCardFetch(apiKey, providerSpecificData, action);
  const response = await fetch(url, {
    method: action === "use" ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(GLM_RESET_CARD_TIMEOUT_MS),
  });

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { response, payload };
}

/** GET the reset cards banked on this key. */
export function fetchGlmResetCardList(
  apiKey: string,
  providerSpecificData?: unknown
): Promise<{ response: Response; payload: unknown }> {
  return requestGlmResetCards(apiKey, providerSpecificData, "list");
}

/**
 * POST a redemption. `requestId` is z.ai's idempotency key — the same value must be reused
 * when retrying so a network retry cannot burn two cards.
 */
export function redeemGlmResetCard(
  apiKey: string,
  providerSpecificData: unknown,
  card: { id: string; resetType: GlmResetWindow },
  requestId: string
): Promise<{ response: Response; payload: unknown }> {
  const numericId = Number(card.id);
  return requestGlmResetCards(apiKey, providerSpecificData, "use", {
    targetType: GLM_RESET_CARD_TARGET_TYPE,
    resetType: card.resetType,
    recordId: Number.isFinite(numericId) ? numericId : card.id,
    requestId,
  });
}

/**
 * Best-effort count of redeemable cards, for the quota card. Never throws: a key without
 * coding-plan entitlements (or a transient failure) simply reports none, so the quota poll
 * this is folded into keeps rendering.
 */
export async function fetchGlmResetCardCount(
  apiKey: string,
  providerSpecificData?: unknown
): Promise<number> {
  if (!apiKey) return 0;
  try {
    const { payload } = await fetchGlmResetCardList(apiKey, providerSpecificData);
    if (!isGlmResetCardEnvelopeOk(payload)) return 0;
    return parseGlmResetCards(payload).availableCount;
  } catch {
    return 0;
  }
}
