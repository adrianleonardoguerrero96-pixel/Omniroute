// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
vi.mock("@xyflow/react", async () => {
  const actual = (await vi.importActual("@xyflow/react")) as Record<string, unknown>;
  return { ...actual, Handle: () => null, Position: { Top: "top", Bottom: "bottom" } };
});
vi.mock("next-intl", () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
}));

const flowProps: Record<string, unknown>[] = [];
vi.mock("@/shared/components/flow/FlowCanvas", () => ({
  FlowCanvas: (props: Record<string, unknown>) => {
    flowProps.push(props);
    return <div data-testid="flow-canvas" />;
  },
}));
import { AgentsTab } from "@/app/(dashboard)/dashboard/orchestration/tabs/AgentsTab";

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

describe("AgentsTab", () => {
  it("feeds FlowCanvas with converted nodes and a stable fitKey; empty snapshot shows CTAs", () => {
    const snap = {
      nodes: [{ id: "orchestrator", kind: "orchestrator", label: "OmniRoute" }],
      edges: [],
      sources: [],
      generatedAt: "x",
    };
    const { c, cleanup } = render(
      <AgentsTab
        snapshot={snap as never}
        onNodeClick={() => {}}
        showCompleted={false}
        onToggleCompleted={() => {}}
      />
    );
    expect(c.textContent).toContain("emptyTitle"); // only the root → empty state, no canvas
    cleanup();
    const withWork = {
      ...snap,
      nodes: [
        ...snap.nodes,
        { id: "a2a:1", kind: "work", source: "a2a", state: "running", label: "x" },
      ],
    };
    const r2 = render(
      <AgentsTab
        snapshot={withWork as never}
        onNodeClick={() => {}}
        showCompleted={false}
        onToggleCompleted={() => {}}
      />
    );
    expect(r2.c.querySelector('[data-testid="flow-canvas"]')).toBeTruthy();
    expect(flowProps.at(-1)?.fitKey).toBe("a2a:1");
    expect(r2.c.querySelector(".orchestration-canvas")).toBeTruthy();
    r2.cleanup();
  });
});
