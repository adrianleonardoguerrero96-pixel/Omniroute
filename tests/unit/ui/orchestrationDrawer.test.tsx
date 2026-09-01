// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
}));

import { OrchestrationDrawer } from "@/app/(dashboard)/dashboard/orchestration/drawer/OrchestrationDrawer";

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
afterEach(() => {
  document.body.innerHTML = "";
});

describe("OrchestrationDrawer", () => {
  it("fetches cloud-agent detail on open and shows approve only when waiting_approval", async () => {
    const detail = {
      data: {
        id: "t1",
        providerId: "devin",
        status: "awaiting_approval",
        prompt: "big plan",
        source: { repoName: "r", repoUrl: "https://x" },
        options: {},
        activities: [
          { id: "a1", type: "plan", content: "the plan", timestamp: "2026-08-30T10:00:00Z" },
        ],
        createdAt: "x",
        updatedAt: "y",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(detail) }))
    );
    const node = {
      id: "cloud-agent:t1",
      kind: "work",
      source: "cloud-agent",
      state: "waiting_approval",
      label: "big plan",
      raw: detail.data,
    };
    const { c, cleanup } = render(
      <OrchestrationDrawer node={node as never} onClose={() => {}} onActionDone={() => {}} />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(c.textContent).toContain("drawerTimeline");
    expect(c.textContent).toContain("actionApprove");
    cleanup();
  });

  it("approve POSTs {action:'approve'} and fires onActionDone", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            init?.method === "POST"
              ? { data: {} }
              : {
                  data: {
                    id: "t1",
                    status: "awaiting_approval",
                    activities: [],
                    prompt: "",
                    providerId: "devin",
                    source: { repoName: "r", repoUrl: "https://x" },
                    options: {},
                    createdAt: "x",
                    updatedAt: "y",
                  },
                }
          ),
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    let done = false;
    const node = {
      id: "cloud-agent:t1",
      kind: "work",
      source: "cloud-agent",
      state: "waiting_approval",
      label: "x",
    };
    const { c, cleanup } = render(
      <OrchestrationDrawer
        node={node as never}
        onClose={() => {}}
        onActionDone={() => {
          done = true;
        }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    const btn = Array.from(c.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("actionApprove")
    );
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ action: "approve" });
    expect(done).toBe(true);
    cleanup();
  });

  it("renders nothing for a null node", () => {
    const { c, cleanup } = render(
      <OrchestrationDrawer node={null} onClose={() => {}} onActionDone={() => {}} />
    );
    expect(c.textContent).toBe("");
    cleanup();
  });
});
