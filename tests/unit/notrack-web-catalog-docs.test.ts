/**
 * Unique catalog / docs / i18n lock for notrack-web (#12534).
 *
 * origin/release/v3.8.51 ships 356 providers (SeekAi already landed). This PR
 * adds notrack-web, so live modules + PROVIDER_REFERENCE + AGENTS.md + llm.txt
 * + package.json + i18n llm.txt mirrors must all carry 357. Do not fold this
 * into a generic catalog bump — the dedicated asserts below are the
 * regression lock for this provider.
 *
 * Run: node --import tsx/esm --test tests/unit/notrack-web-catalog-docs.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APIKEY_PROVIDERS, WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers.ts";
import { parseProviderTotal } from "../../scripts/check/check-docs-counts-sync.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_PROVIDER_TOTAL_WITH_NOTRACK_WEB = 357;
const parseTotal = parseProviderTotal as (text: string) => number;

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("notrack-web is in the live web-cookie catalog with alias ntw", () => {
  const entry = WEB_COOKIE_PROVIDERS["notrack-web"];
  assert.ok(entry, "notrack-web missing from WEB_COOKIE_PROVIDERS");
  assert.equal(entry.id, "notrack-web");
  assert.equal(entry.alias, "ntw");
  assert.equal(entry.hasFree, true);
});

test("later catalog SeekAi and eligibility-gated free-tier counts stay alongside notrack-web", () => {
  const entry = APIKEY_PROVIDERS.seekai;
  assert.ok(entry, "seekai missing from APIKEY_PROVIDERS — later catalog must be preserved");
  assert.equal(entry.id, "seekai");

  const readme = readRepo("README.md");
  assert.match(
    readme,
    /\*\*444 per-model rows\*\*/,
    "README.md must keep the later-catalog 444 per-model rows (#12669)"
  );
  assert.match(
    readme,
    /444 cataloged free-tier entries/,
    "README.md must keep the later-catalog 444 free-tier entries"
  );
  assert.match(
    readme,
    /behind regional identity verification/,
    "README.md must keep the eligibility-gated free-tier figure"
  );
});

test("canonical catalog/docs counts include notrack-web (356 + 1 = 357)", () => {
  const reference = readRepo("docs/reference/PROVIDER_REFERENCE.md");
  assert.match(reference, /`notrack-web`/, "PROVIDER_REFERENCE.md must list notrack-web");
  assert.match(reference, /`seekai`/, "PROVIDER_REFERENCE.md must keep SeekAi");
  assert.equal(
    parseTotal(reference),
    LIVE_PROVIDER_TOTAL_WITH_NOTRACK_WEB,
    "PROVIDER_REFERENCE.md total must be the unique 357 that includes notrack-web"
  );

  const agents = readRepo("AGENTS.md");
  assert.match(agents, /357 LLM providers/, "AGENTS.md must mention 357 LLM providers");

  const llm = readRepo("llm.txt");
  assert.match(llm, /across 357 AI providers/, "llm.txt intro must mention 357 AI providers");
  assert.match(
    llm,
    /\*\*357 AI providers\*\*/,
    "llm.txt feature list must mention 357 AI providers"
  );

  const pkg = JSON.parse(readRepo("package.json")) as { description?: string };
  assert.match(
    String(pkg.description ?? ""),
    /357 providers/,
    "package.json description must mention 357 providers"
  );

  const readme = readRepo("README.md");
  assert.match(
    readme,
    /\*\*357 registered providers\*\*/,
    "README.md must mention 357 registered providers"
  );
});

test("i18n llm.txt mirrors carry the unique 357 count that includes notrack-web", () => {
  const i18nDir = path.join(ROOT, "docs", "i18n");
  const locales = fs
    .readdirSync(i18nDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(locales.length >= 40, `expected 40+ i18n locales, got ${locales.length}`);

  for (const locale of locales) {
    const mirror = path.join(i18nDir, locale, "llm.txt");
    assert.equal(fs.existsSync(mirror), true, `docs/i18n/${locale}/llm.txt is missing`);
    const text = fs.readFileSync(mirror, "utf8");
    assert.match(
      text,
      /across 357 AI providers/,
      `docs/i18n/${locale}/llm.txt must mention 357 AI providers (notrack-web unique count)`
    );
    assert.match(
      text,
      /\*\*357 AI providers\*\*/,
      `docs/i18n/${locale}/llm.txt feature list must mention 357 AI providers`
    );
  }
});
