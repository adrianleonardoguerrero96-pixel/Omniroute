import type { TierAssignment, TierConfig, ProviderTier } from "./tierTypes";
import { PROVIDER_TIER } from "./tierTypes";
import { getModelPricing } from "./providerCostData";
import { isExplicitlyFree } from "./providerCostData";
import { mergeTierConfig, DEFAULT_TIER_CONFIG } from "./tierConfig";
import { isFreeModel } from "@/shared/utils/freeModels";

let dbPersistenceChecked = false;

const tierCache = new Map<string, TierAssignment>();
let currentConfig: TierConfig = DEFAULT_TIER_CONFIG;

function cacheKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function matchGlob(pattern: string, text: string): boolean {
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`, "i").test(text);
}

function ensurePersistedTierConfigLoaded(): void {
  if (dbPersistenceChecked) return;
  if (process.env.NODE_ENV === "test" || typeof window !== "undefined") {
    currentConfig = DEFAULT_TIER_CONFIG;
    dbPersistenceChecked = true;
    tierCache.clear();
    return;
  }
  try {
    const { loadTierConfig } = require("../../src/lib/db/tierConfig");
    currentConfig = loadTierConfig();
    dbPersistenceChecked = true;
    tierCache.clear();
  } catch {
    // Routing can be imported before DB initialization in tests/tools. Keep the
    // default and retry on a later call rather than permanently masking SQLite.
    currentConfig = DEFAULT_TIER_CONFIG;
  }
}

/** Highest-precedence local tier assertion, excluding automatic catalog/pricing inference. */
export function resolveExplicitTierOverride(
  provider: string,
  model: string
): ProviderTier | undefined {
  ensurePersistedTierConfigLoaded();
  const providerOverride = currentConfig.providerOverrides.find(
    (o) => o.provider.toLowerCase() === provider.toLowerCase()
  );
  if (providerOverride) return providerOverride.tier;
  return currentConfig.modelOverrides.find(
    (o) => o.provider.toLowerCase() === provider.toLowerCase() && matchGlob(o.modelPattern, model)
  )?.tier;
}

export function classifyTier(provider: string, model: string): TierAssignment {
  ensurePersistedTierConfigLoaded();
  const key = cacheKey(provider, model);

  if (tierCache.has(key)) {
    return tierCache.get(key)!;
  }

  const explicitOverride = resolveExplicitTierOverride(provider, model);
  if (explicitOverride) {
    const pricing = getModelPricing(provider, model);
    const assignment: TierAssignment = {
      provider,
      model,
      tier: explicitOverride,
      reason: `Explicit tier override: '${provider}/${model}' → ${explicitOverride}`,
      costPer1MInput: explicitOverride === PROVIDER_TIER.FREE ? 0 : pricing.inputCostPer1M,
      costPer1MOutput: explicitOverride === PROVIDER_TIER.FREE ? 0 : pricing.outputCostPer1M,
      hasFreeTier: explicitOverride === PROVIDER_TIER.FREE,
      freeQuotaLimit: pricing.freeQuotaLimit,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  if (isExplicitlyFree(provider, currentConfig)) {
    const assignment: TierAssignment = {
      provider,
      model,
      tier: PROVIDER_TIER.FREE,
      reason: `Provider '${provider}' is in explicit free providers list`,
      costPer1MInput: 0,
      costPer1MOutput: 0,
      hasFreeTier: true,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  if (isFreeModel(provider, { id: model })) {
    const assignment: TierAssignment = {
      provider,
      model,
      tier: PROVIDER_TIER.FREE,
      reason: "Model is explicitly identified as free by the shared free-model classifier",
      costPer1MInput: 0,
      costPer1MOutput: 0,
      hasFreeTier: true,
    };
    tierCache.set(key, assignment);
    return assignment;
  }

  const pricing = getModelPricing(provider, model);
  let tier: ProviderTier;
  let reason: string;

  if (pricing.isFree || pricing.inputCostPer1M <= currentConfig.defaults.freeThreshold) {
    tier = PROVIDER_TIER.FREE;
    reason = `Cost-based: $${pricing.inputCostPer1M}/M input ≤ free threshold ($${currentConfig.defaults.freeThreshold}/M)`;
  } else if (pricing.inputCostPer1M <= currentConfig.defaults.cheapThreshold) {
    tier = PROVIDER_TIER.CHEAP;
    reason = `Cost-based: $${pricing.inputCostPer1M}/M input ≤ cheap threshold ($${currentConfig.defaults.cheapThreshold}/M)`;
  } else {
    tier = PROVIDER_TIER.PREMIUM;
    reason = `Cost-based: $${pricing.inputCostPer1M}/M input > cheap threshold ($${currentConfig.defaults.cheapThreshold}/M)`;
  }

  const assignment: TierAssignment = {
    provider,
    model,
    tier,
    reason,
    costPer1MInput: pricing.inputCostPer1M,
    costPer1MOutput: pricing.outputCostPer1M,
    hasFreeTier: pricing.isFree,
    freeQuotaLimit: pricing.freeQuotaLimit,
  };

  tierCache.set(key, assignment);
  return assignment;
}

export function setTierConfig(config?: Partial<TierConfig> | null): void {
  if (config === null || config === undefined) {
    dbPersistenceChecked = false;
    ensurePersistedTierConfigLoaded();
  } else {
    currentConfig = mergeTierConfig(config);
    dbPersistenceChecked = true;
  }
  tierCache.clear();
}

export function getTierConfig(): TierConfig {
  ensurePersistedTierConfigLoaded();
  return { ...currentConfig };
}

export function clearTierCache(): void {
  tierCache.clear();
}

export function classifyTiers(
  targets: Array<{ provider: string; model: string }>
): TierAssignment[] {
  return targets.map((t) => classifyTier(t.provider, t.model));
}

export function getTierStats(): Record<ProviderTier, number> {
  const stats: Record<ProviderTier, number> = { free: 0, cheap: 0, premium: 0 };
  for (const assignment of tierCache.values()) {
    stats[assignment.tier]++;
  }
  return stats;
}
