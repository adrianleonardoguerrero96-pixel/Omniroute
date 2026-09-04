// @vitest-environment jsdom
/**
 * tests/unit/ui/orchestrationComparePanel.test.tsx
 * Component tests for the Orchestration Canvas History tab's side-by-side comparison panel
 * (Task A3, PR-A). Kept in its own file — not `orchestrationHistoryTab.test.tsx` — to stay
 * under the 1200-line `check:file-size` cap (see global-constraints.md).
 * Run: npx vitest run tests/unit/ui/orchestrationComparePanel.test.tsx
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
}));

import { CompareRunsPanel } from "@/app/(dashboard)/dashboard/orchestration/tabs/CompareRunsPanel";
import type { HistoryItem } from "@/app/(dashboard)/dashboard/orchestration/model/historyModel";

function render(el: React.ReactElement) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const root = createRoot(c);
  act(() => root.render(el));
  return {
    c,
    cleanup: () => {
      act(() => root.unmount());
      c.remove();
    },
  };
}

/** Flushes N microtask ticks inside `act`, enough to drain the two parallel
 * fetch().then().then(Promise.allSettled) chains (same idiom as orchestrationHistoryTab.test.tsx). */
async function flush(n = 6) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function historyItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: "a2a:t1",
    source: "a2a",
    identity: "smart-routing",
    state: "succeeded",
    label: "smart-routing",
    createdAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T10:00:30.000Z",
    durationMs: 30000,
    cost: null,
    raw: {},
    ...overrides,
  };
}

/** Mocks `GET /api/a2a/tasks/t1` and `/t2` — the two ids used by every test's left/right
 * items below. Each side defaults to an empty-events success response so a test only has to
 * override the side it cares about. */
function mockDetailFetch(opts: {
  left?: { ok: boolean; body?: unknown };
  right?: { ok: boolean; body?: unknown };
}) {
  const leftResp = opts.left ?? { ok: true, body: { task: { events: [] } } };
  const rightResp = opts.right ?? { ok: true, body: { task: { events: [] } } };
  return vi.fn((url: string) => {
    const u = String(url);
    const resp = u.includes("/t1") ? leftResp : u.includes("/t2") ? rightResp : null;
    if (!resp) return Promise.reject(new Error(`unexpected url ${u}`));
    if (!resp.ok) return Promise.resolve({ ok: false, status: 500 });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(resp.body) });
  });
}

describe("CompareRunsPanel", () => {
  it("renders both headers and a metrics row with the signed delta", async () => {
    const left = historyItem({ id: "a2a:t1", identity: "smart-routing", durationMs: 30000 });
    const right = historyItem({
      id: "a2a:t2",
      identity: "smart-routing",
      durationMs: 45000,
      cost: 0.5,
    });
    vi.stubGlobal("fetch", mockDetailFetch({}));
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();

    expect(c.querySelector('[data-testid="orchestration-history-compare-panel"]')).toBeTruthy();
    expect(c.textContent).toContain("smart-routing");
    expect(c.textContent).toContain("compareTitle");
    expect(c.textContent).toContain("compareDuration");
    expect(c.textContent).toContain("compareCost");
    // right.durationMs - left.durationMs = 45000 - 30000 = 15000ms → "+15s".
    expect(c.textContent).toContain("+15s");
    cleanup();
  });

  it("one side failing its fetch shows compareDetailFailed for that side while the other continues rendering", async () => {
    const left = historyItem({ id: "a2a:t1", identity: "smart-routing" });
    const right = historyItem({ id: "a2a:t2", identity: "eval-suite" });
    vi.stubGlobal(
      "fetch",
      mockDetailFetch({
        left: { ok: true, body: { task: { events: [{ state: "submitted", timestamp: null }] } } },
        right: { ok: false },
      })
    );
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();

    expect(c.textContent).toContain("compareDetailFailed");
    // Both headers keep rendering — the failing side is not blanked out.
    expect(c.textContent).toContain("smart-routing");
    expect(c.textContent).toContain("eval-suite");
    cleanup();
  });

  it("shows compareDifferentIdentity when the two runs are not the same (source, identity) pair", async () => {
    const left = historyItem({ id: "a2a:t1", identity: "smart-routing" });
    const right = historyItem({ id: "a2a:t2", identity: "eval-suite" });
    vi.stubGlobal("fetch", mockDetailFetch({}));
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();
    expect(c.textContent).toContain("compareDifferentIdentity");
    cleanup();
  });

  it("does not show compareDifferentIdentity when both sides share the same (source, identity) pair", async () => {
    const left = historyItem({ id: "a2a:t1", identity: "smart-routing" });
    const right = historyItem({ id: "a2a:t2", identity: "smart-routing" });
    vi.stubGlobal("fetch", mockDetailFetch({}));
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();
    expect(c.textContent).not.toContain("compareDifferentIdentity");
    cleanup();
  });

  it("renders — instead of NaN when a delta cannot be computed (one side missing the value)", async () => {
    const left = historyItem({ id: "a2a:t1", identity: "smart-routing", cost: null });
    const right = historyItem({ id: "a2a:t2", identity: "smart-routing", cost: null });
    vi.stubGlobal("fetch", mockDetailFetch({}));
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();
    expect(c.textContent).not.toContain("NaN");
    expect(c.textContent).toContain("—");
    cleanup();
  });

  it("aligns the timeline by index, rendering one row per event of the longer side", async () => {
    const left = historyItem({ id: "a2a:t1", identity: "smart-routing" });
    const right = historyItem({ id: "a2a:t2", identity: "smart-routing" });
    vi.stubGlobal(
      "fetch",
      mockDetailFetch({
        left: {
          ok: true,
          body: {
            task: {
              events: [
                { state: "submitted", timestamp: "2026-09-01T10:00:00.000Z" },
                { state: "working", timestamp: "2026-09-01T10:00:05.000Z" },
                { state: "completed", timestamp: "2026-09-01T10:00:30.000Z" },
              ],
            },
          },
        },
        right: {
          ok: true,
          body: {
            task: { events: [{ state: "submitted", timestamp: "2026-09-01T10:00:00.000Z" }] },
          },
        },
      })
    );
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();

    const rows = c.querySelectorAll('[data-testid="orchestration-compare-timeline-row"]');
    expect(rows.length).toBe(3);
    cleanup();
  });

  it("calls onClose when the close button is clicked", async () => {
    const left = historyItem({ id: "a2a:t1" });
    const right = historyItem({ id: "a2a:t2", identity: "eval-suite" });
    vi.stubGlobal("fetch", mockDetailFetch({}));
    let closed = false;
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => (closed = true)} />
    );
    await flush();
    const closeBtn = c.querySelector(
      '[data-testid="orchestration-compare-close"]'
    ) as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    act(() => closeBtn.click());
    expect(closed).toBe(true);
    cleanup();
  });

  it("scrolls its own container instead of expanding it (overflow-x-auto on the panel)", async () => {
    const left = historyItem({ id: "a2a:t1" });
    const right = historyItem({ id: "a2a:t2", identity: "eval-suite" });
    vi.stubGlobal("fetch", mockDetailFetch({}));
    const { c, cleanup } = render(
      <CompareRunsPanel left={left} right={right} onClose={() => {}} />
    );
    await flush();
    const panel = c.querySelector('[data-testid="orchestration-history-compare-panel"]');
    expect(panel?.className).toContain("overflow-x-auto");
    cleanup();
  });
});
