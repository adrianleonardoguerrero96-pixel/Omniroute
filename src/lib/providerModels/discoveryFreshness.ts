const lastSuccessfulDiscoveryMs = new Map<string, number>();

function key(provider: string, connectionId: string): string {
  return `${provider}::${connectionId}`;
}

/** Mark a provider/connection catalog as live-verified in this process. */
export function markProviderModelDiscoveryFresh(
  provider: string,
  connectionId: string,
  checkedAtMs = Date.now()
): void {
  lastSuccessfulDiscoveryMs.set(key(provider, connectionId), checkedAtMs);
}

export function invalidateProviderModelDiscoveryFreshness(
  provider: string,
  connectionId: string
): void {
  lastSuccessfulDiscoveryMs.delete(key(provider, connectionId));
}

/** Strict-free freshness proof. Process restart intentionally resets this to UNKNOWN. */
export function isProviderModelDiscoveryFresh(
  provider: string,
  connectionId: string,
  maxAgeMs: number,
  nowMs = Date.now()
): boolean {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const checkedAtMs = lastSuccessfulDiscoveryMs.get(key(provider, connectionId));
  return checkedAtMs !== undefined && nowMs >= checkedAtMs && nowMs - checkedAtMs <= maxAgeMs;
}

export const __testing = {
  clear(): void {
    lastSuccessfulDiscoveryMs.clear();
  },
};
