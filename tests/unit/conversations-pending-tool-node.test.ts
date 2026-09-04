/**
 * Regression test for /dashboard/conversations's live-turn rendering.
 *
 * conversation_turn_nodes rows record identity (role/blockKind) synchronously
 * the moment a turn is recorded; display content (textPreview) resolves
 * lazily from the owning call-log artifact (resolveTurnDisplayContent). While
 * that resolution is still in flight, /api/conversations/[id]/tree's own
 * `blockKind ?? "text"` fallback makes a genuinely-in-progress tool node
 * indistinguishable from a permanently-empty one at the API layer -- but the
 * node's own persisted `role` ("tool", set at record time, independent of
 * content resolution) does distinguish them. toTurn() previously rendered
 * both as a bare "_(empty)_" text bubble, which read as broken rather than
 * in progress. This proves the tool+no-content case now maps to a distinct
 * `pending` block instead, without changing any other mapping.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { toTurn } = await import("../../src/app/(dashboard)/dashboard/conversations/toTurn.ts");

function node(overrides: Partial<Parameters<typeof toTurn>[0]>) {
  return {
    seq: 1,
    id: "01234567890123456789",
    parentId: null,
    role: "assistant",
    textPreview: "",
    blockKind: "text",
    toolName: null,
    firstSeenAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("toTurn renders an unresolved tool node as pending, not a bare empty text bubble", () => {
  const turn = toTurn(node({ role: "tool", blockKind: "text", textPreview: "" }));
  assert.deepEqual(turn.blocks, [{ type: "pending" }]);
});

test("toTurn still renders a genuinely empty assistant reply as empty text, not pending", () => {
  const turn = toTurn(node({ role: "assistant", blockKind: "text", textPreview: "" }));
  assert.deepEqual(turn.blocks, [{ type: "text", text: "_(empty)_" }]);
});

test("toTurn renders a resolved tool node's real content once textPreview lands, not pending", () => {
  const turn = toTurn(node({ role: "tool", blockKind: "text", textPreview: "the real result" }));
  assert.deepEqual(turn.blocks, [{ type: "text", text: "the real result" }]);
});

test("toTurn leaves tool_use/tool_result mapping unaffected", () => {
  const toolUse = toTurn(
    node({ role: "tool", blockKind: "tool_use", toolName: "search", textPreview: '{"q":"x"}' })
  );
  assert.equal(toolUse.blocks[0]!.type, "tool_use");

  const toolResult = toTurn(
    node({ role: "tool", blockKind: "tool_result", textPreview: '{"ok":true}' })
  );
  assert.equal(toolResult.blocks[0]!.type, "tool_result");
});
