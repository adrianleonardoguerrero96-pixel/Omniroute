import { getProviderConnectionById } from "@/lib/db/providers";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { fetchAndPersistProviderLimits } from "@/lib/usage/providerLimits";
import {
  fetchGlmResetCardList,
  getGlmResetCardEnvelopeMessage,
  getGlmResetCardEnvelopeStatus,
  isGlmResetCardEnvelopeOk,
  parseGlmResetCards,
  redeemGlmResetCard,
  type GlmResetCard,
} from "@omniroute/open-sse/services/usage/glmResetCards.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

/**
 * GLM Coding Plan Reset Cards — connection-aware orchestration.
 *
 * Mirrors `codexResetCredits.ts` (same list/redeem contract, same public shapes) so the
 * Provider Limits UI can drive either provider through one flow. The differences are all
 * upstream-imposed: z.ai authenticates with the connection's API key rather than an OAuth
 * access token (so there is no token-refresh retry), and reports failures inside an
 * HTTP-200 envelope rather than through the status line.
 */

type JsonRecord = Record<string, unknown>;

/** GLM providers that resolve usage through the z.ai/bigmodel coding-plan endpoints. */
export const GLM_RESET_CARD_PROVIDERS = ["glm", "glm-cn", "glmt", "zai"] as const;

type GlmConnectionLike = JsonRecord & {
  id: string;
  provider: string;
  apiKey?: string;
  providerSpecificData?: JsonRecord;
};

export type PublicGlmResetCard = Omit<GlmResetCard, "id"> & {
  selectionToken: string;
};

export interface GlmResetCardListResult {
  credits: PublicGlmResetCard[];
  availableCount: number;
  lastFiveHourResetAt: string | null;
  lastWeekResetAt: string | null;
}

export class GlmResetCardError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GlmResetCardError";
    this.status = status;
    this.code = code;
  }
}

export function isGlmResetCardProvider(provider: unknown): boolean {
  return (
    typeof provider === "string" &&
    (GLM_RESET_CARD_PROVIDERS as readonly string[]).includes(provider)
  );
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toPublicCard(card: GlmResetCard): PublicGlmResetCard {
  const { id, ...metadata } = card;
  return { ...metadata, selectionToken: id };
}

/**
 * `glm-cn` is pinned to the China region the same way the usage dispatcher pins it, so the
 * reset endpoints follow the key's own host instead of defaulting to the international one.
 */
function getProviderSpecificData(connection: GlmConnectionLike): JsonRecord {
  return {
    ...toRecord(connection.providerSpecificData),
    ...(connection.provider === "glm-cn" ? { apiRegion: "china" } : {}),
  };
}

async function loadGlmConnection(connectionId: string): Promise<GlmConnectionLike> {
  if (await isConnectionUnavailableToAuxiliaryActivity(connectionId)) {
    throw new GlmResetCardError(
      409,
      "exclusive_lease_active",
      "Reset-card operations are deferred while an exclusive lease is active."
    );
  }

  const connection = (await getProviderConnectionById(
    connectionId
  )) as unknown as GlmConnectionLike | null;

  if (!connection) {
    throw new GlmResetCardError(404, "connection_not_found", "Connection not found.");
  }

  if (!isGlmResetCardProvider(connection.provider)) {
    throw new GlmResetCardError(
      400,
      "glm_provider_required",
      "Reset cards can only be redeemed for GLM coding-plan accounts."
    );
  }

  if (!connection.apiKey) {
    throw new GlmResetCardError(
      401,
      "glm_api_key_missing",
      "GLM coding-plan API key is missing on this connection."
    );
  }

  return connection;
}

function assertEnvelopeOk(payload: unknown, httpStatus: number, fallbackMessage: string): void {
  if (isGlmResetCardEnvelopeOk(payload) && httpStatus < 400) return;

  const status = getGlmResetCardEnvelopeStatus(payload, httpStatus);
  const upstreamMessage = getGlmResetCardEnvelopeMessage(payload);

  if (status === 401 || status === 403) {
    throw new GlmResetCardError(
      401,
      "glm_reset_card_unauthorized",
      "The GLM API key was rejected by the reset-card API."
    );
  }

  throw new GlmResetCardError(
    status >= 400 ? status : 502,
    "glm_reset_card_upstream_error",
    upstreamMessage || fallbackMessage
  );
}

export async function listGlmResetCards(connectionId: string): Promise<GlmResetCardListResult> {
  if (!connectionId || typeof connectionId !== "string") {
    throw new GlmResetCardError(400, "connection_id_required", "connectionId is required.");
  }

  try {
    const connection = await loadGlmConnection(connectionId);
    const { response, payload } = await fetchGlmResetCardList(
      connection.apiKey as string,
      getProviderSpecificData(connection)
    );

    assertEnvelopeOk(payload, response.status, "The GLM reset-card API returned an error.");

    const parsed = parseGlmResetCards(payload);
    return {
      credits: parsed.cards.map(toPublicCard),
      availableCount: parsed.availableCount,
      lastFiveHourResetAt: parsed.lastFiveHourResetAt,
      lastWeekResetAt: parsed.lastWeekResetAt,
    };
  } catch (error) {
    if (error instanceof GlmResetCardError) throw error;
    throw new GlmResetCardError(
      500,
      "glm_reset_card_list_failed",
      sanitizeErrorMessage(error) || "Failed to load GLM reset cards."
    );
  }
}

export async function consumeGlmResetCard(
  connectionId: string,
  idempotencyKey: string,
  selectionToken?: string
): Promise<{ outcome: "reset"; usage: JsonRecord }> {
  if (!connectionId || typeof connectionId !== "string") {
    throw new GlmResetCardError(400, "connection_id_required", "connectionId is required.");
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new GlmResetCardError(400, "idempotency_key_required", "idempotencyKey is required.");
  }

  try {
    const connection = await loadGlmConnection(connectionId);
    const providerSpecificData = getProviderSpecificData(connection);
    const apiKey = connection.apiKey as string;

    const listed = await fetchGlmResetCardList(apiKey, providerSpecificData);
    assertEnvelopeOk(
      listed.payload,
      listed.response.status,
      "The GLM reset-card API returned an error."
    );

    const { cards } = parseGlmResetCards(listed.payload);
    const requested =
      typeof selectionToken === "string" && selectionToken.trim() ? selectionToken.trim() : null;
    const card = requested ? cards.find((entry) => entry.id === requested) : cards[0];

    if (!card) {
      throw new GlmResetCardError(
        409,
        requested ? "selected_card_unavailable" : "no_reset_card",
        requested
          ? "The selected GLM reset card is no longer available."
          : "No GLM reset cards are available."
      );
    }

    const redeemed = await redeemGlmResetCard(
      apiKey,
      providerSpecificData,
      card,
      idempotencyKey.trim()
    );
    assertEnvelopeOk(
      redeemed.payload,
      redeemed.response.status,
      "The GLM reset-card API rejected the redemption."
    );

    const refreshed = await fetchAndPersistProviderLimits(connectionId, "manual", {
      allowRotatingRefresh: true,
    });

    return { outcome: "reset", usage: refreshed.usage };
  } catch (error) {
    if (error instanceof GlmResetCardError) throw error;
    throw new GlmResetCardError(
      500,
      "glm_reset_card_failed",
      sanitizeErrorMessage(error) || "Failed to redeem GLM reset card."
    );
  }
}
