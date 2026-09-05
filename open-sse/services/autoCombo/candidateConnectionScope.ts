import { classifyTier } from "../tierResolver";

type ConnectionScopedCandidate = {
  provider: string;
  model: string;
  allowedConnectionIds?: string[];
  freeConnectionIds?: string[];
};

export function clonePreparedCandidates<T extends ConnectionScopedCandidate>(
  candidates: readonly T[]
): T[] {
  return candidates.map((candidate) => ({
    ...candidate,
    ...(candidate.allowedConnectionIds
      ? { allowedConnectionIds: [...candidate.allowedConnectionIds] }
      : {}),
    ...(candidate.freeConnectionIds ? { freeConnectionIds: [...candidate.freeConnectionIds] } : {}),
  }));
}

/**
 * `auto/*:free` is itself a routing guarantee. When a model is admitted only
 * because one or more synced connections reported it free, narrow dispatch to
 * those exact connections even when the global `hidePaidModels` and strict
 * zero-cost settings are off. Models that are globally classified free keep
 * their existing provider-wide connection scope.
 */
export function narrowConnectionScopedFreeCandidates<T extends ConnectionScopedCandidate>(
  candidates: T[]
): T[] {
  return candidates.flatMap((candidate) => {
    const discoveredFree = candidate.freeConnectionIds ?? [];
    if (discoveredFree.length === 0) return [candidate];

    try {
      if (classifyTier(candidate.provider, candidate.model).tier === "free") return [candidate];
    } catch {
      // If global tier classification is unavailable, fail closed to the
      // connection-scoped free evidence that admitted this candidate.
    }

    const allowed = candidate.allowedConnectionIds ?? [];
    const narrowed = discoveredFree.filter((id) => allowed.includes(id));
    if (narrowed.length === 0) return [];

    const same =
      allowed.length === narrowed.length && narrowed.every((id) => allowed.includes(id));
    return same ? [candidate] : [{ ...candidate, allowedConnectionIds: narrowed }];
  });
}
