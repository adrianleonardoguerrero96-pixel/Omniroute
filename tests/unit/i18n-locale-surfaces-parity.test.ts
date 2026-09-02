import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18nConfig from "../../config/i18n.json" with { type: "json" };

/**
 * Parity guard: every locale declared in config/i18n.json (the single source of
 * truth) must exist on every in-repo surface — dashboard catalog, CLI catalog,
 * docs mirror (README.md / llm.txt / CHANGELOG.md), README flag link and the
 * docs/i18n/README.md index row — and the README headline count must match.
 * Locales listed in `docsExcluded` (the English source) only need the two
 * catalogs.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsExcluded = new Set(i18nConfig.docsExcluded ?? ["en"]);
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const docsIndex = readFileSync(path.join(ROOT, "docs", "i18n", "README.md"), "utf8");

for (const { code } of i18nConfig.locales) {
  test(`locale ${code} exists on every in-repo surface`, () => {
    assert.ok(
      existsSync(path.join(ROOT, "src", "i18n", "messages", `${code}.json`)),
      "dashboard catalog"
    );
    assert.ok(existsSync(path.join(ROOT, "bin", "cli", "locales", `${code}.json`)), "CLI catalog");
    if (docsExcluded.has(code)) return;
    assert.ok(existsSync(path.join(ROOT, "docs", "i18n", code, "README.md")), "docs mirror README");
    assert.ok(existsSync(path.join(ROOT, "docs", "i18n", code, "llm.txt")), "llm.txt mirror");
    assert.ok(
      existsSync(path.join(ROOT, "docs", "i18n", code, "CHANGELOG.md")),
      "CHANGELOG mirror"
    );
    assert.ok(readme.includes(`docs/i18n/${code}/README.md`), "README flag link");
    assert.ok(docsIndex.includes(`(\`${code}\`)`), "docs/i18n/README.md index row");
  });
}

test("README headline count matches config/i18n.json", () => {
  const m = readme.match(/In (\d+) languages/);
  assert.ok(m, "README must carry the 'In N languages' headline");
  assert.equal(Number(m[1]), i18nConfig.locales.length);
});
