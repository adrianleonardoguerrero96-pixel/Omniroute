/** Run: node --import tsx/esm --test tests/unit/ui/orchestrationToFlow.test.ts */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrationToFlow } from "../../../src/app/(dashboard)/dashboard/orchestration/model/orchestrationToFlow.ts";
import type { OrchSnapshot } from "../../../src/app/(dashboard)/dashboard/orchestration/model/orchestrationTypes.ts";

const snap: OrchSnapshot = {
  nodes: [
    { id: "orchestrator", kind: "orchestrator", label: "OmniRoute" },
    { id: "source:a2a", kind: "source", source: "a2a", label: "A2A" },
    { id: "a2a:t1", kind: "work", source: "a2a", state: "running", label: "smart-routing" },
    { id: "a2a:t2", kind: "work", source: "a2a", state: "failed", label: "cost-analysis" },
  ],
  edges: [
    { id: "e1", from: "orchestrator", to: "source:a2a", kind: "owns", active: false },
    { id: "e2", from: "source:a2a", to: "a2a:t1", kind: "owns", active: true },
    { id: "e3", from: "source:a2a", to: "a2a:t2", kind: "owns", active: false },
  ],
  sources: [],
  generatedAt: "2026-08-30T12:00:00Z",
};

const multiSourceSnap: OrchSnapshot = {
  nodes: [
    { id: "orchestrator", kind: "orchestrator", label: "OmniRoute" },
    { id: "source:a2a", kind: "source", source: "a2a", label: "A2A" },
    { id: "a2a:t1", kind: "work", source: "a2a", state: "running", label: "smart-routing" },
    {
      id: "a2a:t1:activity",
      kind: "activity",
      source: "a2a",
      state: "running",
      label: "thinking",
    },
    { id: "source:cloud-agent", kind: "source", source: "cloud-agent", label: "Cloud Agent" },
    {
      id: "cloud-agent:t1",
      kind: "work",
      source: "cloud-agent",
      state: "queued",
      label: "build",
    },
  ],
  edges: [
    { id: "e1", from: "orchestrator", to: "source:a2a", kind: "owns", active: false },
    { id: "e2", from: "source:a2a", to: "a2a:t1", kind: "owns", active: true },
    { id: "e3", from: "a2a:t1", to: "a2a:t1:activity", kind: "owns", active: true },
    { id: "e4", from: "orchestrator", to: "source:cloud-agent", kind: "owns", active: false },
    { id: "e5", from: "source:cloud-agent", to: "cloud-agent:t1", kind: "owns", active: false },
  ],
  sources: [],
  generatedAt: "2026-08-30T12:00:00Z",
};

describe("orchestrationToFlow", () => {
  it("puts each kind on its own Y layer and is deterministic", () => {
    const a = orchestrationToFlow(snap);
    const b = orchestrationToFlow(snap);
    assert.deepEqual(
      a.nodes.map((n) => n.position),
      b.nodes.map((n) => n.position)
    );
    const ys = new Map(a.nodes.map((n) => [n.id, n.position.y]));
    assert.equal(ys.get("orchestrator"), 0);
    assert.equal(ys.get("source:a2a"), 150);
    assert.equal(ys.get("a2a:t1"), 320);
  });
  it("active edge is animated; edge to failed work is red", () => {
    const { edges } = orchestrationToFlow(snap);
    assert.equal(edges.find((e) => e.id === "e2")?.animated, true);
    const failedEdge = edges.find((e) => e.id === "e3");
    assert.equal((failedEdge?.style as { stroke?: string })?.stroke, "#ef4444");
  });
  it("fitKey only tracks the set of work ids", () => {
    const k1 = orchestrationToFlow(snap).fitKey;
    const stateChanged = {
      ...snap,
      nodes: snap.nodes.map((n) => (n.id === "a2a:t1" ? { ...n, state: "succeeded" as const } : n)),
    };
    assert.equal(orchestrationToFlow(stateChanged).fitKey, k1);
    const nodeRemoved = {
      ...snap,
      nodes: snap.nodes.filter((n) => n.id !== "a2a:t2"),
      edges: snap.edges.filter((e) => e.to !== "a2a:t2"),
    };
    assert.notEqual(orchestrationToFlow(nodeRemoved).fitKey, k1);
  });

  it("opts omitted preserves current behavior (all nodes/edges kept, no collapsed data)", () => {
    const { nodes, edges, fitKey } = orchestrationToFlow(multiSourceSnap);
    assert.equal(nodes.length, multiSourceSnap.nodes.length);
    assert.equal(edges.length, multiSourceSnap.edges.length);
    assert.ok(!fitKey.includes("::collapsed="));
    const sourceA2a = nodes.find((n) => n.id === "source:a2a");
    assert.equal((sourceA2a?.data as { collapsed?: boolean }).collapsed, undefined);
  });

  it("collapsing a source removes its work/activity nodes and their edges, keeps other sources", () => {
    const { nodes, edges } = orchestrationToFlow(multiSourceSnap, {
      collapsed: new Set(["a2a"]),
    });
    const ids = nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ["cloud-agent:t1", "orchestrator", "source:a2a", "source:cloud-agent"]);
    const edgeIds = edges.map((e) => e.id).sort();
    assert.deepEqual(edgeIds, ["e1", "e4", "e5"]);
  });

  it("SourceNode for a collapsed source carries data.collapsed === true; others do not", () => {
    const { nodes } = orchestrationToFlow(multiSourceSnap, { collapsed: new Set(["a2a"]) });
    const sourceA2a = nodes.find((n) => n.id === "source:a2a");
    const sourceCloudAgent = nodes.find((n) => n.id === "source:cloud-agent");
    assert.equal((sourceA2a?.data as { collapsed?: boolean }).collapsed, true);
    assert.equal((sourceCloudAgent?.data as { collapsed?: boolean }).collapsed, undefined);
  });

  it("fitKey changes when the collapsed set changes and is stable otherwise", () => {
    const base = orchestrationToFlow(multiSourceSnap).fitKey;
    const k1 = orchestrationToFlow(multiSourceSnap, { collapsed: new Set(["a2a"]) }).fitKey;
    const k1Again = orchestrationToFlow(multiSourceSnap, { collapsed: new Set(["a2a"]) }).fitKey;
    const k2 = orchestrationToFlow(multiSourceSnap, {
      collapsed: new Set(["cloud-agent"]),
    }).fitKey;
    assert.equal(k1, k1Again);
    assert.notEqual(k1, base);
    assert.notEqual(k1, k2);
  });
});
