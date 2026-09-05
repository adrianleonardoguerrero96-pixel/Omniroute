type SyncedFreeEvidence = Record<string, Array<{ id: string; isFree?: boolean }>>;

/** Convert per-connection discovery evidence into a candidate field without widening scope. */
export function discoveredFreeConnectionScope(
  allowedConnectionIds: string[],
  syncedByConnection: SyncedFreeEvidence,
  modelId: string
): { freeConnectionIds?: string[] } {
  const freeConnectionIds = allowedConnectionIds.filter((connectionId) =>
    (syncedByConnection[connectionId] ?? []).some((m) => m.id === modelId && m.isFree === true)
  );
  return freeConnectionIds.length > 0 ? { freeConnectionIds } : {};
}
