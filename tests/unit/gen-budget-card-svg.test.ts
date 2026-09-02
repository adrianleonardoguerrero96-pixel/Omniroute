import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeFreeModelTotals } from "@omniroute/open-sse/config/freeModelCatalog.ts";

const fmt = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : Math.round(n / 1e6) + "M");

test("the budget card prints the catalog's own totals (no regex-parsed subset)", () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "budget-card-")), "card.svg");
  execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "scripts/research/gen-budget-card-svg.mjs", "--out", out],
    { stdio: "pipe" }
  );
  const svg = readFileSync(out, "utf8");
  const t = computeFreeModelTotals();
  assert.ok(svg.includes(`~${fmt(t.steadyRecurringTokens)}`), "steady figure");
  assert.ok(svg.includes(`~${fmt(t.firstMonthRealisticTokens)}`), "first-month figure");
  assert.ok(svg.includes(`${t.uncappedProviders.length} permanently-free`), "uncapped count");
  if (t.gatedRecurringTokens > 0) {
    assert.ok(svg.includes("behind regional identity verification"), "gated line");
  }
});
