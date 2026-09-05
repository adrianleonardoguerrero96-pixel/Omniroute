import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildChecks } from "../../scripts/check/check-docs-counts-sync.mjs";

describe("free provider rankings sort key + catalog date", () => {
  it("freeProviderRankings.ts declares sortBy elo|reliability and MIN_USAGE_REQUESTS=5", () => {
    const txt = readFileSync("src/lib/freeProviderRankings.ts", "utf8");
    assert.match(txt, /MIN_USAGE_REQUESTS\s*=\s*5/);
    assert.match(txt, /sortBy\?\s*:\s*"elo"\s*\|\s*"reliability"/);
  });
  it("free-provider-rankings route carries z.enum elo/reliability", () => {
    const txt = readFileSync("src/app/api/free-provider-rankings/route.ts", "utf8");
    assert.match(txt, /z\.enum\(\["elo",\s*"reliability"\]\)/);
  });
  it("freeModelCatalog.data.ts carries FREE_CATALOG_CURATED_AT literal", () => {
    const txt = readFileSync("open-sse/config/freeModelCatalog.data.ts", "utf8");
    assert.match(txt.split("\n")[18], /FREE_CATALOG_CURATED_AT\s*=\s*"2026-08-30"/);
  });
  it("buildChecks exposes rankings sortBy strict + FREE_CATALOG_CURATED_AT soft", () => {
    const checks = buildChecks() as any[];
    const n3 = checks.find((c) => String(c.docKey ?? "").includes("rankings sortBy") || String(c.label ?? "").includes("rankings sortBy"));
    const n27 = checks.find((c) => String(c.docKey ?? "").includes("FREE_CATALOG_CURATED_AT") || String(c.label ?? "").includes("FREE_CATALOG_CURATED_AT"));
    assert.ok(n3, "rankings sortBy entry missing");
    assert.equal(n3.strict, true, "rankings sortBy must be strict");
    assert.ok(n27, "FREE_CATALOG_CURATED_AT entry missing");
    assert.equal(n27.strict, false, "catalog date must be soft");
  });
  it("summary route references FREE_CATALOG_CURATED_AT with slice(0, 10)", () => {
    const txt = readFileSync("src/app/api/free-tier/summary/route.ts", "utf8");
    assert.match(txt, /FREE_CATALOG_CURATED_AT/);
    assert.match(txt, /slice\(0,\s*10\)/);
  });
});
