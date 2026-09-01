"use client";
/**
 * Search input + filter chips for the Agents/Overview tabs — pure presentation over the URL
 * params owned by OrchestrationPageClient (`q`/`state`/`source`/`provider`). No filtering logic
 * lives here; it renders `filter` (an `OrchFilter` already parsed from the URL) and calls
 * `setParams` to mutate it. Spec: task-a6-brief.md (2.3+2.4).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { isEmptyFilter } from "./model/filterSnapshot";
import type { OrchFilter } from "./model/filterSnapshot";
import { ORCH_STATES } from "./model/orchestrationTypes";
import type { OrchSource, OrchState } from "./model/orchestrationTypes";

const SOURCES = ["cloud-agent", "a2a", "conductor"] as const satisfies readonly OrchSource[];

const STATE_KEY: Record<OrchState, string> = {
  queued: "stateQueued",
  running: "stateRunning",
  waiting_approval: "stateWaitingApproval",
  succeeded: "stateSucceeded",
  failed: "stateFailed",
  cancelled: "stateCancelled",
};
const SOURCE_KEY: Record<(typeof SOURCES)[number], string> = {
  "cloud-agent": "sourceCloudAgent",
  a2a: "sourceA2A",
  conductor: "sourceConductor",
};

const SEARCH_DEBOUNCE_MS = 300;

/** Toggle `value` in `current`, returning the next CSV (or `null` to drop the param). */
function toggleCsv<T extends string>(current: ReadonlySet<T>, value: T): string | null {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next.size > 0 ? [...next].sort().join(",") : null;
}

export function OrchestrationToolbar({
  filter,
  providerKeys,
  setParams,
}: {
  filter: OrchFilter;
  providerKeys: string[];
  setParams: (patch: Record<string, string | null>) => void;
}) {
  const t = useTranslations("orchestration");
  const [text, setText] = useState(filter.q);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const handleSearchChange = (v: string) => {
    setText(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setParams({ q: v || null }), SEARCH_DEBOUNCE_MS);
  };

  const handleClear = () => {
    setText("");
    if (timerRef.current) clearTimeout(timerRef.current);
    setParams({ q: null, state: null, source: null, provider: null });
  };

  const chipClass = (active: boolean) =>
    `text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${
      active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
      <input
        type="search"
        value={text}
        onChange={(e) => handleSearchChange(e.target.value)}
        placeholder={t("searchPlaceholder")}
        className="text-xs px-2 py-1 rounded border border-border bg-transparent min-w-[160px]"
      />
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-muted">{t("filterStates")}</span>
        {ORCH_STATES.map((s) => (
          <button
            key={s}
            type="button"
            className={chipClass(filter.states.has(s))}
            aria-pressed={filter.states.has(s)}
            onClick={() => setParams({ state: toggleCsv(filter.states, s) })}
          >
            {t(STATE_KEY[s])}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-muted">{t("filterSources")}</span>
        {SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            className={chipClass(filter.sources.has(s))}
            aria-pressed={filter.sources.has(s)}
            onClick={() => setParams({ source: toggleCsv(filter.sources, s) })}
          >
            {t(SOURCE_KEY[s])}
          </button>
        ))}
      </div>
      {providerKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted">{t("filterProviders")}</span>
          {providerKeys.map((p) => (
            <button
              key={p}
              type="button"
              className={chipClass(filter.providers.has(p))}
              aria-pressed={filter.providers.has(p)}
              onClick={() => setParams({ provider: toggleCsv(filter.providers, p) })}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {!isEmptyFilter(filter) && (
        <button
          type="button"
          className="text-[10px] underline text-muted ml-auto"
          onClick={handleClear}
        >
          {t("clearFilters")}
        </button>
      )}
    </div>
  );
}
