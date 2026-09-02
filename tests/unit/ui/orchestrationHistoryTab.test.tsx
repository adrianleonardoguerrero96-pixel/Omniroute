// @vitest-environment jsdom
/**
 * tests/unit/ui/orchestrationHistoryTab.test.tsx
 * Component tests for the Orchestration Canvas "History" tab (Task C4, PR-B2).
 * Run: npx vitest run tests/unit/ui/orchestrationHistoryTab.test.tsx
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
}));

const drawerCalls: Record<string, unknown>[] = [];
vi.mock("@/app/(dashboard)/dashboard/orchestration/drawer/OrchestrationDrawer", () => ({
  OrchestrationDrawer: (props: Record<string, unknown>) => {
    drawerCalls.push(props);
    return <div data-testid="drawer-stub" />;
  },
}));

import { HistoryTab } from "@/app/(dashboard)/dashboard/orchestration/tabs/HistoryTab";

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

/** Flushes N microtask ticks inside `act`, enough to drain fetch().then().then(Promise.allSettled) chains. */
async function flush(n = 6) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  drawerCalls.length = 0;
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

function mockFetch(opts: {
  a2aTasks?: unknown[];
  cloudAgentTasks?: unknown[];
  a2aFail?: boolean;
  cloudAgentFail?: boolean;
}) {
  const { a2aTasks = [], cloudAgentTasks = [], a2aFail = false, cloudAgentFail = false } = opts;
  const fn = vi.fn((url: string) => {
    const u = String(url);
    if (u.startsWith("/api/a2a/tasks/history")) {
      if (a2aFail) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ tasks: a2aTasks, total: a2aTasks.length, limit: 500, offset: 0 }),
      });
    }
    if (u.startsWith("/api/v1/agents/tasks")) {
      if (cloudAgentFail) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: cloudAgentTasks }) });
    }
    return Promise.reject(new Error(`unexpected url ${u}`));
  });
  return fn;
}

function cloudAgentTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "ca1",
    providerId: "devin",
    status: "completed",
    prompt: "do the thing",
    source: { repoName: "r", repoUrl: "https://x" },
    options: {},
    activities: [],
    createdAt: hoursAgo(45 / 60),
    updatedAt: hoursAgo(20 / 60),
    completedAt: hoursAgo(20 / 60),
    ...overrides,
  };
}

function a2aTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    state: "completed",
    skill: "smart-routing",
    createdAt: hoursAgo(1),
    completedAt: hoursAgo(0.5),
    ...overrides,
  };
}

describe("HistoryTab", () => {
  it("fetches both sources on mount and renders one row per (source, identity)", async () => {
    vi.stubGlobal("fetch", mockFetch({ a2aTasks: [a2aTask()], cloudAgentTasks: [cloudAgentTask()] }));
    const { c, cleanup } = render(<HistoryTab />);
    await flush();
    expect(c.textContent).toContain("smart-routing");
    expect(c.textContent).toContain("devin");
    expect(c.querySelectorAll("tbody tr").length).toBe(2);
    cleanup();
  });

  it("switching the preset re-fetches A2A history with a different from/to range", async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const { c, cleanup } = render(<HistoryTab />);
    await flush();

    const historyCalls = () =>
      fetchMock.mock.calls.map((call) => String(call[0])).filter((u) => u.includes("/api/a2a/tasks/history"));
    const firstCall = historyCalls().at(-1);
    expect(firstCall).toBeTruthy();

    const btn1d = Array.from(c.querySelectorAll("button")).find(
      (b) => b.textContent === "historyRange1d"
    ) as HTMLButtonElement;
    expect(btn1d).toBeTruthy();
    act(() => {
      btn1d.click();
    });
    await flush();

    const secondCall = historyCalls().at(-1);
    expect(secondCall).toBeTruthy();
    expect(secondCall).not.toBe(firstCall);
    cleanup();
  });

  it("clicking a cell opens the drawer with a synthetic OrchNode built from the clicked item", async () => {
    vi.stubGlobal("fetch", mockFetch({ a2aTasks: [a2aTask()] }));
    const { c, cleanup } = render(<HistoryTab />);
    await flush();

    const cell = c.querySelector('button[aria-label*="smart-routing"]') as HTMLButtonElement;
    expect(cell).toBeTruthy();
    act(() => {
      cell.click();
    });
    const last = drawerCalls.at(-1) as { node: { id: string; source: string; kind: string } | null };
    expect(last.node?.id).toBe("a2a:t1");
    expect(last.node?.source).toBe("a2a");
    expect(last.node?.kind).toBe("work");
    cleanup();
  });

  it("shows a source-failed warning for A2A while Cloud Agent rows still render", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ a2aFail: true, cloudAgentTasks: [cloudAgentTask()] })
    );
    const { c, cleanup } = render(<HistoryTab />);
    await flush();
    expect(c.textContent).toContain("historySourceFailed");
    expect(c.textContent).toContain("devin");
    cleanup();
  });

  it("shows the empty state when both sources return no items in range", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const { c, cleanup } = render(<HistoryTab />);
    await flush();
    expect(c.textContent).toContain("historyEmpty");
    cleanup();
  });
});
