/**
 * Pure RequestLogger table metrics + sort comparators extracted from
 * RequestLoggerV2 so the TTFT column can land without growing the frozen
 * god-component (file-size + cyclomatic ratchets).
 */

export type RequestLogSortable = {
  timestamp?: string | number | Date | null;
  duration?: number | null;
  status?: number | null;
  model?: string | null;
  tokens?: { in?: number | null; out?: number | null } | null;
  timeToFirstTokenMs?: unknown;
};

export const COLUMN_SORT_MAP = {
  status: { desc: "status_desc", asc: "status_asc" },
  model: { desc: "model_desc", asc: "model_asc" },
  tokens: { desc: "tokens_desc", asc: "tokens_asc" },
  ttft: { desc: "ttft_desc", asc: "ttft_asc" },
  tps: { desc: "tps_desc", asc: "tps_asc" },
  duration: { desc: "duration_desc", asc: "duration_asc" },
  time: { desc: "newest", asc: "oldest" },
} as const;

export function getLogTotalTokens(log: RequestLogSortable | null | undefined): number {
  return (log?.tokens?.in || 0) + (log?.tokens?.out || 0);
}

export function getLogTtft(log: RequestLogSortable | null | undefined): number {
  return typeof log?.timeToFirstTokenMs === "number" &&
    Number.isFinite(log.timeToFirstTokenMs) &&
    log.timeToFirstTokenMs > 0
    ? log.timeToFirstTokenMs
    : 0;
}

export function getLogTps(log: RequestLogSortable | null | undefined): number {
  const tokensOut = log?.tokens?.out || 0;
  const durationMs = log?.duration || 0;
  if (tokensOut <= 0 || durationMs <= 0) return 0;
  return tokensOut / (durationMs / 1000);
}

export function formatTps(tps: number): string {
  if (tps <= 0) return "—";
  if (tps >= 100) return Math.round(tps).toLocaleString();
  return tps.toFixed(1);
}

export function formatTtft(ttftMs: number | null | undefined): string {
  if (ttftMs == null || !Number.isFinite(ttftMs) || ttftMs <= 0) return "—";
  const rounded = Math.round(ttftMs);
  if (rounded < 1000) return `${rounded}ms`;
  return `${(rounded / 1000).toFixed(2)}s`;
}

function timestampMs(log: RequestLogSortable | null | undefined): number {
  const value = log?.timestamp;
  if (value == null) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compareTtft(
  a: RequestLogSortable,
  b: RequestLogSortable,
  direction: "asc" | "desc"
): number {
  const aVal = getLogTtft(a);
  const bVal = getLogTtft(b);
  if (direction === "desc") {
    const aNorm = aVal > 0 ? aVal : -1;
    const bNorm = bVal > 0 ? bVal : -1;
    return bNorm - aNorm;
  }
  const aNorm = aVal > 0 ? aVal : Infinity;
  const bNorm = bVal > 0 ? bVal : Infinity;
  return aNorm - bNorm;
}

const COMPARATORS: Record<string, (a: RequestLogSortable, b: RequestLogSortable) => number> = {
  oldest: (a, b) => timestampMs(a) - timestampMs(b),
  newest: (a, b) => timestampMs(b) - timestampMs(a),
  tokens_desc: (a, b) => getLogTotalTokens(b) - getLogTotalTokens(a),
  tokens_asc: (a, b) => getLogTotalTokens(a) - getLogTotalTokens(b),
  ttft_desc: (a, b) => compareTtft(a, b, "desc"),
  ttft_asc: (a, b) => compareTtft(a, b, "asc"),
  duration_desc: (a, b) => (b.duration || 0) - (a.duration || 0),
  duration_asc: (a, b) => (a.duration || 0) - (b.duration || 0),
  tps_desc: (a, b) => getLogTps(b) - getLogTps(a),
  tps_asc: (a, b) => getLogTps(a) - getLogTps(b),
  status_desc: (a, b) => (b.status || 0) - (a.status || 0),
  status_asc: (a, b) => (a.status || 0) - (b.status || 0),
  model_asc: (a, b) => (a.model || "").localeCompare(b.model || ""),
  model_desc: (a, b) => (b.model || "").localeCompare(a.model || ""),
};

export function compareRequestLogs(
  a: RequestLogSortable,
  b: RequestLogSortable,
  sortBy: string
): number {
  return (COMPARATORS[sortBy] ?? COMPARATORS.newest)(a, b);
}
