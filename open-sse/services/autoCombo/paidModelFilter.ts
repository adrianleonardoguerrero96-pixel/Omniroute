/**
 * #6512 (follow-up to #6328 / #6495) — exclude paid-only backends from `auto/*`
 * candidate pools when the operator opts into the `hidePaidModels` setting.
 *
 * PR #6495 added `hidePaidModels` to hide paid models from the `GET /v1/models`
 * listing, but `auto/*` combos could still pick a paid-only backend into their
 * candidate pool → a 402/403 at request time, exactly what #6328 wanted to avoid.
 * This applies the SAME free-model predicate #6495 uses in `catalog.ts` to every
 * virtual auto-combo candidate pool.
 *
 * Kept as a pure, dependency-light function so the filter is unit-testable in
 * isolation without seeding the DB-backed virtual factory.
 */
import { isFreeModel } from "@/shared/utils/freeModels";

interface PaidFilterCandidate {
  provider: string;
  model: string;
  allowedConnectionIds?: string[];
  freeConnectionIds?: string[];
}

/**
 * Return the candidate pool filtered to free-only backends when
 * `hidePaidModels` is on; otherwise return the pool unchanged (identity — the
 * default, opt-in-off path). Connection-scoped discovery is honored without
 * widening it: when only some credentials reported this model free, the
 * candidate's dispatch allowlist is narrowed to exactly those connections.
 */
export function filterPaidOnlyCandidates<T extends PaidFilterCandidate>(
  pool: T[],
  hidePaidModels: boolean,
  resolveOperatorTier: (
    provider: string,
    model: string
  ) => "free" | "cheap" | "premium" | undefined = () => undefined
): T[] {
  if (!hidePaidModels) return pool;

  const kept: T[] = [];
  for (const candidate of pool) {
    const override = resolveOperatorTier(candidate.provider, candidate.model);
    if (override !== undefined) {
      if (override === "free") kept.push(candidate);
      continue;
    }
    if (isFreeModel(candidate.provider, { id: candidate.model })) {
      kept.push(candidate);
      continue;
    }

    const freeConnections = candidate.freeConnectionIds ?? [];
    if (freeConnections.length === 0) continue;
    const allowed = candidate.allowedConnectionIds ?? [];
    const narrowed = freeConnections.filter((id) => allowed.includes(id));
    if (narrowed.length === 0) continue;
    const same =
      allowed.length === narrowed.length && narrowed.every((id) => allowed.includes(id));
    kept.push(same ? candidate : ({ ...candidate, allowedConnectionIds: narrowed } as T));
  }
  return kept;
}
