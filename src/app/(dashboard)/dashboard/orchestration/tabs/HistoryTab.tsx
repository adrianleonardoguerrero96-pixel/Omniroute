"use client";
/**
 * History tab — Airflow-grid style view over PERSISTED runs (A2A task history from Task C3's
 * `GET /api/a2a/tasks/history`, plus the existing in-memory `GET /api/v1/agents/tasks` for
 * Cloud Agent). Conductor is intentionally absent — its runs are remote and not persisted
 * locally, surfaced to the operator via the `historyConductorNote` banner instead of silently
 * omitted.
 *
 * Selection here (`selected`) is LOCAL component state, NOT the page's `?node=` URL param:
 * `useOrchUrlState`'s `?node=` resolves against the LIVE orchestration snapshot
 * (`useOrchestrationSnapshot`), and a finished/historical run generally does not exist in that
 * snapshot any more (or, for A2A, might exist only via the persisted-history fallback added in
 * C3) — so there is nothing for `?node=` to look up on a page refresh/deep link into this tab.
 * The live snapshot's `OrchestrationToolbar` filters (search/state/source/provider chips) also
 * do not apply here — this tab fetches its own two sources directly, over its own preset time
 * range, independent of the live snapshot filter pipeline.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { OrchestrationDrawer } from "../drawer/OrchestrationDrawer";
import { orchStateColor, type OrchNode } from "../model/orchestrationTypes";
import {
  buildHistoryGrid,
  historyItemFromA2A,
  historyItemFromCloudAgent,
  historyRangeFromPreset,
  type HistoryItem,
} from "../model/historyModel";
import type { CloudAgentTask } from "@/lib/cloudAgent/types";

type Preset = "1d" | "7d" | "30d";
type SourceKind = "a2a" | "cloud-agent";

const PRESETS: Preset[] = ["1d", "7d", "30d"];
const PRESET_KEY: Record<Preset, string> = {
  "1d": "historyRange1d",
  "7d": "historyRange7d",
  "30d": "historyRange30d",
};
// Column count per preset — hourly slices for the 1-day view, daily slices otherwise.
const BUCKET_COUNT: Record<Preset, number> = { "1d": 24, "7d": 7, "30d": 30 };
const SOURCE_LABEL: Record<SourceKind, string> = { a2a: "A2A", "cloud-agent": "Cloud Agent" };

interface A2AHistoryRow {
  id: string;
  state: string;
  skill: string | null;
  createdAt: string;
  completedAt: string | null;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Resets `isLoading` back to `true` synchronously during render when `rangeKey` changes —
 * React's documented "adjust state when a prop changes" idiom (same shape as
 * `useDrawerDetail.ts`'s `useSyncedNodeIdentity`), kept out of the fetch effect below so that
 * effect never calls `setState` synchronously in its own body (`react-hooks/set-state-in-effect`).
 */
function useSyncedRangeReset(rangeKey: string, setIsLoading: (b: boolean) => void) {
  const [syncedKey, setSyncedKey] = useState<string | undefined>(undefined);
  if (rangeKey !== syncedKey) {
    setSyncedKey(rangeKey);
    setIsLoading(true);
  }
}

/**
 * Fetches A2A persisted history + Cloud Agent tasks for `range`, `Promise.allSettled` so one
 * source failing never hides the other. Cloud Agent has no server-side range filter, so it is
 * filtered client-side by `createdAt`. State is only ever set from the settled callback — the
 * effect body itself never calls setState synchronously, keeping it clean under
 * `react-hooks/set-state-in-effect` (same shape as `useDrawerDetail.ts`'s `useFetchDetail`).
 */
function useHistoryData(range: { fromMs: number; toMs: number }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [failedSources, setFailedSources] = useState<ReadonlySet<SourceKind>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  useSyncedRangeReset(`${range.fromMs}:${range.toMs}`, setIsLoading);

  useEffect(() => {
    const controller = new AbortController();
    const from = new Date(range.fromMs).toISOString();
    const to = new Date(range.toMs).toISOString();

    const a2aReq = fetch(
      `/api/a2a/tasks/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`,
      { signal: controller.signal, cache: "no-store" }
    ).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))));
    const cloudAgentReq = fetch("/api/v1/agents/tasks?limit=100", {
      signal: controller.signal,
      cache: "no-store",
    }).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))));

    Promise.allSettled([a2aReq, cloudAgentReq]).then(([a2aResult, cloudAgentResult]) => {
      if (controller.signal.aborted) return;
      const failed = new Set<SourceKind>();
      const nextItems: HistoryItem[] = [];

      if (a2aResult.status === "fulfilled") {
        const rows = (a2aResult.value as { tasks?: A2AHistoryRow[] })?.tasks ?? [];
        for (const row of rows) nextItems.push(historyItemFromA2A(row));
      } else {
        failed.add("a2a");
      }

      if (cloudAgentResult.status === "fulfilled") {
        const tasks = (cloudAgentResult.value as { data?: CloudAgentTask[] })?.data ?? [];
        for (const t of tasks) {
          const createdMs = Date.parse(t.createdAt);
          if (Number.isFinite(createdMs) && createdMs >= range.fromMs && createdMs <= range.toMs) {
            nextItems.push(historyItemFromCloudAgent(t));
          }
        }
      } else {
        failed.add("cloud-agent");
      }

      setItems(nextItems);
      setFailedSources(failed);
      setIsLoading(false);
    });

    return () => controller.abort();
  }, [range.fromMs, range.toMs]);

  return { items, failedSources, isLoading };
}

/** Turns a clicked HistoryItem into the synthetic OrchNode OrchestrationDrawer expects — the
 * `a2a:`/`cloud-agent:` id prefix is preserved so `useDrawerDetail`'s `routeFor` resolves the
 * right detail endpoint (the A2A one falls back to persisted history per Task C3). */
function nodeFromHistoryItem(item: HistoryItem): OrchNode {
  return {
    id: item.id,
    kind: "work",
    source: item.source,
    state: item.state,
    label: item.label,
    raw: item.raw,
  };
}

export function HistoryTab() {
  const t = useTranslations("orchestration");
  const [preset, setPreset] = useState<Preset>("7d");
  // Sampled at mount (lazy initializer, runs once) and re-sampled directly inside the
  // button's onClick below (a real DOM event handler, which — unlike a plain closure
  // referenced by one — the `react-hooks/purity` rule permits to be impure). Never sampled
  // during render or inside a `useEffect` body: this codebase's established idiom
  // (`useOrchestrationSnapshot.ts`'s `polledAt`, `OverviewTab.tsx`'s `now`) only calls
  // `Date.now()` from a lazy initializer or from inside a nested async/timer callback.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selected, setSelected] = useState<OrchNode | null>(null);

  const range = useMemo(() => historyRangeFromPreset(preset, nowMs), [preset, nowMs]);
  const { items, failedSources, isLoading } = useHistoryData(range);
  const grid = useMemo(
    () => buildHistoryGrid(items, range, BUCKET_COUNT[preset]),
    [items, range, preset]
  );

  return (
    <div className="flex flex-col h-full min-h-0 gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              className={`px-2 py-1 text-xs rounded border ${
                preset === p
                  ? "border-primary bg-primary/10 font-medium"
                  : "border-border text-muted"
              }`}
              onClick={() => {
                setPreset(p);
                setNowMs(Date.now());
              }}
            >
              {t(PRESET_KEY[p])}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-muted">{t("historyConductorNote")}</span>
      </div>

      {[...failedSources].map((source) => (
        <div key={source} role="alert" className="text-xs text-error">
          {t("historySourceFailed", { source: SOURCE_LABEL[source] })}
        </div>
      ))}

      {!isLoading && grid.rows.length === 0 ? (
        <div className="text-xs text-muted p-4">{t("historyEmpty")}</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto border border-border rounded">
          <table className="text-xs border-collapse w-full">
            <tbody>
              {grid.rows.map((row) => (
                <tr key={`${row.source}:${row.identity}`} className="border-b border-border">
                  <th
                    scope="row"
                    className="text-left px-2 py-1 sticky left-0 bg-surface whitespace-nowrap font-normal"
                  >
                    <span className="font-medium">{row.identity}</span>{" "}
                    <span className="text-[9px] uppercase text-muted">
                      {SOURCE_LABEL[row.source]}
                    </span>
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={i} className="p-0.5 align-top">
                      <div className="flex flex-wrap gap-0.5">
                        {cell.map((item) => {
                          const meta = `${item.label} · ${formatDuration(item.durationMs)} · ${item.state}`;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className="w-3 h-3 rounded-sm motion-reduce:transition-none"
                              style={{ backgroundColor: orchStateColor(item.state) }}
                              title={meta}
                              aria-label={meta}
                              onClick={() => setSelected(nodeFromHistoryItem(item))}
                            />
                          );
                        })}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OrchestrationDrawer
        node={selected}
        onClose={() => setSelected(null)}
        onActionDone={() => setSelected(null)}
      />
    </div>
  );
}
