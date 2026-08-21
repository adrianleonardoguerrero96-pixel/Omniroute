// Regression: the specificity detectors must read Anthropic-format `content`
// arrays, not just plain strings.
//
// `/v1/messages` (and OpenAI multimodal) send `content` as an array of typed
// blocks: `[{ type: "text", text: "..." }]`. Every detector in
// specificityRules.ts previously extracted text with
// `typeof m.content === "string" ? m.content : ""`, which yields "" for that
// shape — so codeComplexity/mathComplexity/domainSpecificity all scored 0 and
// EVERY Anthropic-format request classified as `trivial`, defeating
// complexity-aware routing (#5811) on the entire native Claude path.
//
// `estimateMessageTokens` already handled the array shape, so `contextSize`
// kept scoring — which masked the bug behind a partially-working classifier.
import test from "node:test";
import assert from "node:assert/strict";

const { classifyRequestComplexity } = await import(
  "../../open-sse/services/autoCombo/complexityRouter.ts"
);
const { analyzeSpecificity } = await import("../../open-sse/services/specificityDetector.ts");

const CODE_PROMPT =
  "Fix this:\n```rust\nfn push(&self) { let x = self.head.load(Ordering::Acquire); }\n```\n" +
  "class Ring interface Slot const HEAD = 1";

const asString = { messages: [{ role: "user", content: CODE_PROMPT }] } as never;
const asBlocks = {
  messages: [{ role: "user", content: [{ type: "text", text: CODE_PROMPT }] }],
} as never;

test("content-array messages score the same as the equivalent string message", () => {
  const s = analyzeSpecificity(asString);
  const b = analyzeSpecificity(asBlocks);

  assert.ok(
    b.breakdown.codeComplexity > 0,
    "Anthropic content-array must produce a non-zero codeComplexity (was 0 before the fix)"
  );
  assert.equal(
    b.breakdown.codeComplexity,
    s.breakdown.codeComplexity,
    "content-array and string shapes must score identically"
  );
  assert.equal(b.score, s.score, "total specificity score must not depend on content shape");
});

test("a code-bearing content-array request is not classified as trivial", () => {
  const cls = classifyRequestComplexity(asBlocks);
  assert.notEqual(
    cls.level,
    "trivial",
    "code-bearing Anthropic request must not fall through as trivial"
  );
});

test("multi-block content concatenates every text block", () => {
  const multi = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "```js\nconst a = 1;\n```" },
          { type: "image", source: {} }, // non-text block contributes nothing
          { type: "text", text: "class Foo interface Bar" },
        ],
      },
    ],
  } as never;
  assert.ok(
    analyzeSpecificity(multi).breakdown.codeComplexity > 0,
    "text blocks after a non-text block must still be scored"
  );
});

test("unknown / null content shapes stay inert (fail-safe, no throw)", () => {
  for (const content of [null, undefined, 42, { text: "not-an-array" }]) {
    const input = { messages: [{ role: "user", content }] } as never;
    assert.doesNotThrow(() => analyzeSpecificity(input));
    assert.equal(analyzeSpecificity(input).breakdown.codeComplexity, 0);
  }
});
