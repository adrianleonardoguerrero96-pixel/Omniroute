"use client";
/**
 * Side-by-side comparison panel for two History runs (Task A3, PR-A). Fetches each side's
 * detail the SAME way the drawer does (`drawer/useDrawerDetail.ts`'s `routeFor` /
 * `unwrapDetailBody` — the a2a route already falls back to persisted history when the task
 * left the live TTL window, per Task C3), then normalizes each side through
 * `model/compareRuns.ts`'s `normalizeRunSide` (Task A1) and derives signed deltas through
 * `buildComparison`.
 *
 * One side's fetch failing never blocks the other: `detailUrlFor`'s two requests run in
 * parallel via `Promise.allSettled`, and `normalizeRunSide` is called with whatever `detail`
 * that side ended up with (the real payload on success, `null` on failure — `normalizeRunSide`
 * already treats a non-object `detail` as "empty events/memoryHits", never throwing). The
 * header/metrics rows read straight off the `HistoryItem` props (`left`/`right`), which are
 * already available synchronously — only the timeline/memory sections depend on the fetch, so
 * the panel renders immediately and fills in as each side's request settles.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { orchStateColor, type OrchState } from "../model/orchestrationTypes";
import { normalizeRunSide, buildComparison } from "../model/compareRuns";
import type { RunComparison, RunEvent, RunMemoryHit } from "../model/compareRuns";
import type { HistoryItem } from "../model/historyModel";

type Translate = ReturnType<typeof useTranslations>;

const STATE_KEY: Record<OrchState, string> = {
  queued: "stateQueued",
  running: "stateRunning",
  waiting_approval: "stateWaitingApproval",
  succeeded: "stateSucceeded",
  failed: "stateFailed",
  cancelled: "stateCancelled",
};
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// Client-safe stand-in for sanitizeErrorMessage (server-only, breaks the client bundle — same
// contract as `useDrawerDetail.ts`'s `toSafeErrorText`): only our own `HTTP <status>` errors
// and AbortError pass through verbatim, everything else collapses to a generic string. The
// panel itself only ever shows the translated `compareDetailFailed` key, never this raw text,
// but keeping the same shape avoids a second sanitization contract in this codebase.
function toSafeErrorText(err: unknown): string {
  if (err instanceof Error) {
    if (/^HTTP \d{3}$/.test(err.message)) return err.message;
    if (err.name === "AbortError") return "Request cancelled";
  }
  return "Request failed";
}

/** Mirrors `useDrawerDetail.ts`'s `routeFor` detail URLs for the two sources this panel ever
 * receives (`a2a` / `cloud-agent`) — HistoryItem never carries a `conductor` id (History has no
 * Conductor rows, see `HistoryTab.tsx`'s module doc). */
function detailUrlFor(item: HistoryItem): string {
  if (item.source === "cloud-agent") {
    const id = item.id.slice("cloud-agent:".length);
    return `/api/v1/agents/tasks/${encodeURIComponent(id)}`;
  }
  const id = item.id.slice("a2a:".length);
  return `/api/a2a/tasks/${encodeURIComponent(id)}`;
}

/** Mirrors `useDrawerDetail.ts`'s `unwrapDetailBody`: cloud-agent responds `{ data }`, a2a
 * `{ task }` — not `{ data }` (see that function's doc for why a generic `.data` fallback is
 * wrong for a2a). */
function unwrapDetailBody(item: HistoryItem, body: unknown): unknown {
  const b = body as { data?: unknown; task?: unknown };
  if (item.source === "a2a") return b.task ?? body;
  return b.data ?? body;
}

interface SideFetchState {
  detail: unknown | null;
  error: string | null;
}

const INITIAL_SIDE: SideFetchState = { detail: null, error: null };

function pairKey(left: HistoryItem, right: HistoryItem): string {
  return `${left.id}:${right.id}`;
}

/**
 * Resets both sides' fetch state during render when the (left, right) pair changes — React's
 * documented "adjust state when a prop changes" idiom, kept out of the fetch effect below (same
 * shape as `useDrawerDetail.ts`'s `useSyncedNodeIdentity` / `HistoryTab.tsx`'s
 * `useSyncedRangeReset`) so that effect never calls `setState` synchronously in its own body
 * (`react-hooks/set-state-in-effect`).
 */
function useSyncedPairReset(
  key: string,
  setLeft: (s: SideFetchState) => void,
  setRight: (s: SideFetchState) => void
) {
  const [syncedKey, setSyncedKey] = useState<string | undefined>(undefined);
  if (key !== syncedKey) {
    setSyncedKey(key);
    setLeft(INITIAL_SIDE);
    setRight(INITIAL_SIDE);
  }
}

/**
 * Fetches `left`/`right` detail in parallel with `Promise.allSettled` — one side failing never
 * blocks the other. `AbortController` cancels both requests on unmount or when the pair
 * changes. State is only ever set from the settled callback, never synchronously in the effect
 * body (same technique as `useDrawerDetail.ts`'s `useFetchDetail` / `HistoryTab.tsx`'s
 * `useHistoryData`).
 */
function useCompareDetail(left: HistoryItem, right: HistoryItem) {
  const [leftState, setLeftState] = useState<SideFetchState>(INITIAL_SIDE);
  const [rightState, setRightState] = useState<SideFetchState>(INITIAL_SIDE);
  useSyncedPairReset(pairKey(left, right), setLeftState, setRightState);

  useEffect(() => {
    const controller = new AbortController();
    const fetchSide = (item: HistoryItem) =>
      fetch(detailUrlFor(item), { signal: controller.signal, cache: "no-store" })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((body) => unwrapDetailBody(item, body));

    Promise.allSettled([fetchSide(left), fetchSide(right)]).then(([leftResult, rightResult]) => {
      if (controller.signal.aborted) return;
      setLeftState(
        leftResult.status === "fulfilled"
          ? { detail: leftResult.value, error: null }
          : { detail: null, error: toSafeErrorText(leftResult.reason) }
      );
      setRightState(
        rightResult.status === "fulfilled"
          ? { detail: rightResult.value, error: null }
          : { detail: null, error: toSafeErrorText(rightResult.reason) }
      );
    });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by pair identity (left.id/right.id)
  }, [left.id, right.id]);

  return { leftState, rightState };
}

/** Guards `new Date(value).toLocaleString()` / `.toLocaleTimeString()` against an unparseable
 * `timestamp`/`createdAt` string, which would otherwise leak the literal text `Invalid Date`
 * into the DOM — the same `—` fallback the panel already uses for absent numeric values
 * (`formatDuration`/`formatCost`). `Date.parse` never throws, only returns `NaN`, so
 * `Number.isFinite` is the correct guard (mirrors `formatDurationDelta`/`formatCostDelta`). */
function formatDateTime(value: string, style: "date" | "time"): string {
  if (!Number.isFinite(Date.parse(value))) return "—";
  const date = new Date(value);
  return style === "time" ? date.toLocaleTimeString() : date.toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatCost(cost: number | null): string {
  return cost == null ? "—" : usd.format(cost);
}

/** Signed delta text for a duration delta in ms, guarded with `Number.isFinite` so a `null`
 * delta (see `compareRuns.ts`'s `signedDelta`) renders `—`, never `NaN`. */
function formatDurationDelta(ms: number | null): string {
  if (!Number.isFinite(ms)) return "—";
  const val = ms as number;
  const sign = val > 0 ? "+" : val < 0 ? "-" : "";
  return `${sign}${formatDuration(Math.abs(val))}`;
}

/** Signed delta text for a cost delta, same `Number.isFinite` guard as `formatDurationDelta`. */
function formatCostDelta(cost: number | null): string {
  if (!Number.isFinite(cost)) return "—";
  const val = cost as number;
  const sign = val > 0 ? "+" : val < 0 ? "-" : "";
  return `${sign}${usd.format(Math.abs(val))}`;
}

/** `eventCount` is always a plain number (never null — see `RunDeltas`), so no `—` case here. */
function formatEventDelta(count: number): string {
  return count > 0 ? `+${count}` : `${count}`;
}

/** One column's header: status dot (`orchStateColor`), identity/source, state, start time. */
function RunHeader({ item, t, testId }: { item: HistoryItem; t: Translate; testId: string }) {
  const sourceKey = item.source === "a2a" ? "sourceA2A" : "sourceCloudAgent";
  return (
    <div data-testid={testId} className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span
          className="size-2 rounded-full shrink-0"
          style={{ backgroundColor: orchStateColor(item.state) }}
          aria-hidden="true"
        />
        <span className="text-xs font-semibold truncate">{item.identity}</span>
      </div>
      <div className="text-[10px] text-muted">
        {t(sourceKey)} · {t(STATE_KEY[item.state])}
      </div>
      <div className="text-[10px] text-muted">{formatDateTime(item.createdAt, "date")}</div>
    </div>
  );
}

/** One metric's row: label, left value, right value, signed delta. `metricKey` tags the delta
 * cell with a stable `data-testid` (`orchestration-compare-metric-<key>-delta`) so tests can
 * assert the DELTA specifically instead of matching on page-wide text content — the left/right
 * value cells legitimately render the same `—` glyph for an absent value, so a text-content
 * assertion alone cannot tell a correctly-absent delta from a broken formatter. */
function MetricRow({
  metricKey,
  label,
  leftText,
  rightText,
  deltaText,
}: {
  metricKey: string;
  label: string;
  leftText: string;
  rightText: string;
  deltaText: string;
}) {
  return (
    <div className="grid grid-cols-[70px_1fr_1fr_70px] gap-2 text-[11px] items-center min-w-[480px]">
      <span className="text-muted uppercase text-[9px]">{label}</span>
      <span data-testid={`orchestration-compare-metric-${metricKey}-left`}>{leftText}</span>
      <span data-testid={`orchestration-compare-metric-${metricKey}-right`}>{rightText}</span>
      <span
        data-testid={`orchestration-compare-metric-${metricKey}-delta`}
        className="text-right font-medium"
      >
        {deltaText}
      </span>
    </div>
  );
}

function EventCell({ event }: { event: RunEvent | null }) {
  if (!event) return <span className="text-muted">—</span>;
  return (
    <span className="truncate block">
      {event.label}
      {event.timestamp ? ` · ${formatDateTime(event.timestamp, "time")}` : ""}
    </span>
  );
}

/** Timeline aligned by index: row `i` pairs `left.events[i]` with `right.events[i]`; rows
 * beyond the shorter side's length render an empty `—` cell instead of being dropped. */
function TimelineRows({ comparison, t }: { comparison: RunComparison; t: Translate }) {
  const { left, right } = comparison;
  const rowCount = Math.max(left.events.length, right.events.length);
  if (rowCount === 0) return null;
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    left: left.events[i] ?? null,
    right: right.events[i] ?? null,
  }));
  return (
    <div className="mt-2">
      <div className="text-[10px] font-semibold uppercase text-muted mb-1">
        {t("compareEvents")}
      </div>
      <div className="flex flex-col gap-1 min-w-[480px]">
        {rows.map((row, i) => (
          <div
            key={i}
            data-testid="orchestration-compare-timeline-row"
            className="grid grid-cols-2 gap-2 text-[11px]"
          >
            <EventCell event={row.left} />
            <EventCell event={row.right} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoryList({ hits }: { hits: RunMemoryHit[] }) {
  if (hits.length === 0) return <span className="text-muted">—</span>;
  return (
    <ul className="flex flex-col gap-1">
      {hits.map((h) => (
        <li key={h.id} className="truncate">
          <code className="text-[9px] text-muted mr-1">{h.type}</code>
          <span className="font-medium">{h.key}</span>
        </li>
      ))}
    </ul>
  );
}

/** Memory-hits section, rendered only when at least one side has hits (a2a only — see
 * `compareRuns.ts`'s `memoryHitsFrom`, cloud-agent sides always come back empty). */
function MemorySection({ comparison, t }: { comparison: RunComparison; t: Translate }) {
  const { left, right } = comparison;
  if (left.memoryHits.length === 0 && right.memoryHits.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[10px] font-semibold uppercase text-muted mb-1">{t("drawerMemory")}</div>
      <div className="grid grid-cols-2 gap-2 text-[11px] min-w-[480px]">
        <MemoryList hits={left.memoryHits} />
        <MemoryList hits={right.memoryHits} />
      </div>
    </div>
  );
}

/** Renders the `role="alert"` failure notice for exactly the side that failed its fetch — a
 * side that succeeded renders an empty, role-less cell (kept only to hold its grid column, so
 * the left/right pairing above stays aligned) instead of an empty `role="alert"` div. Two
 * `role="alert"` regions firing whenever EITHER side fails — one of them empty — would announce
 * a blank alert to assistive tech for the side that loaded fine. */
function SideErrorCell({
  error,
  t,
  testId,
}: {
  error: string | null;
  t: Translate;
  testId: string;
}) {
  if (!error) return <div data-testid={testId} />;
  return (
    <div role="alert" data-testid={testId} className="text-[10px] text-error">
      {t("compareDetailFailed")}
    </div>
  );
}

export function CompareRunsPanel({
  left,
  right,
  onClose,
}: {
  left: HistoryItem;
  right: HistoryItem;
  onClose: () => void;
}) {
  const t = useTranslations("orchestration");
  const { leftState, rightState } = useCompareDetail(left, right);
  const comparison = buildComparison(
    normalizeRunSide(left, leftState.detail),
    normalizeRunSide(right, rightState.detail)
  );

  return (
    <div
      data-testid="orchestration-history-compare-panel"
      className="border border-border rounded p-2 overflow-x-auto"
    >
      <div className="flex items-center justify-between mb-2 min-w-[480px]">
        <span className="text-xs font-semibold">{t("compareTitle")}</span>
        <button
          type="button"
          data-testid="orchestration-compare-close"
          aria-label={t("drawerClose")}
          className="text-muted"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 min-w-[480px] mb-2">
        <RunHeader item={left} t={t} testId="orchestration-compare-header-left" />
        <RunHeader item={right} t={t} testId="orchestration-compare-header-right" />
      </div>

      {(leftState.error || rightState.error) && (
        <div className="grid grid-cols-2 gap-2 min-w-[480px] mb-2">
          <SideErrorCell error={leftState.error} t={t} testId="orchestration-compare-error-left" />
          <SideErrorCell
            error={rightState.error}
            t={t}
            testId="orchestration-compare-error-right"
          />
        </div>
      )}

      {!comparison.deltas.sameIdentity && (
        <div role="alert" className="text-[10px] text-warning mb-2">
          {t("compareDifferentIdentity")}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <MetricRow
          metricKey="duration"
          label={t("compareDuration")}
          leftText={formatDuration(left.durationMs)}
          rightText={formatDuration(right.durationMs)}
          deltaText={formatDurationDelta(comparison.deltas.durationMs)}
        />
        <MetricRow
          metricKey="cost"
          label={t("compareCost")}
          leftText={formatCost(left.cost)}
          rightText={formatCost(right.cost)}
          deltaText={formatCostDelta(comparison.deltas.cost)}
        />
        <MetricRow
          metricKey="events"
          label={t("compareEvents")}
          leftText={String(comparison.left.events.length)}
          rightText={String(comparison.right.events.length)}
          deltaText={formatEventDelta(comparison.deltas.eventCount)}
        />
      </div>

      <TimelineRows comparison={comparison} t={t} />
      <MemorySection comparison={comparison} t={t} />
    </div>
  );
}
