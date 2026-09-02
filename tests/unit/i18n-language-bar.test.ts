import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMirrorBar,
  buildSourceBar,
  replaceLanguageBar,
} from "../../scripts/i18n/lib/language-bar.mjs";
import { syncLanguageBars } from "../../scripts/i18n/sync-language-bars.mjs";

const config = {
  locales: [
    { code: "en", flag: "🇺🇸", native: "English" },
    { code: "ar", flag: "🇸🇦", native: "العربية" },
    { code: "pt-BR", flag: "🇧🇷", native: "Português (Brasil)" },
  ],
};

test("buildMirrorBar links English back to the source and every other locale sideways", () => {
  // Every link is the minimal relative path (path.posix.relative), the same form the
  // pre-refactor buildLanguageBar in run-translation.mjs emitted: from
  // docs/i18n/ar/docs/guides/ the English source is four levels up, not "<root>/docs/…".
  assert.equal(
    buildMirrorBar("docs/guides/USER_GUIDE.md", "ar", config),
    "🌐 **Languages:** 🇺🇸 [English](../../../../guides/USER_GUIDE.md) · 🇧🇷 [pt-BR](../../../pt-BR/docs/guides/USER_GUIDE.md)"
  );
  assert.equal(
    buildMirrorBar("README.md", "pt-BR", config),
    "🌐 **Languages:** 🇺🇸 [English](../../../README.md) · 🇸🇦 [ar](../ar/README.md)"
  );
});

test("buildSourceBar lists every locale with its native name and a pipe separator", () => {
  assert.equal(
    buildSourceBar("docs/guides/USER_GUIDE.md", config),
    "🌐 **Languages:** 🇺🇸 [English](./USER_GUIDE.md) | 🇸🇦 [العربية](../i18n/ar/docs/guides/USER_GUIDE.md) | 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/guides/USER_GUIDE.md)"
  );
});

test("replaceLanguageBar swaps only the bar line and returns null when there is none", () => {
  const md = "# T\n\n🌐 **Languages:** old\n\n---\nbody\n";
  assert.equal(
    replaceLanguageBar(md, "🌐 **Languages:** new"),
    "# T\n\n🌐 **Languages:** new\n\n---\nbody\n"
  );
  assert.equal(replaceLanguageBar("# T\n\nbody\n", "x"), null);
});

test("syncLanguageBars rewrites stale bars from config, lists them in dry-run and leaves bar-less files alone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "i18n-language-bar-"));
  try {
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "i18n.json"), JSON.stringify(config), "utf8");

    // English source with a stale bar.
    const enDoc = path.join(root, "docs", "guides", "X.md");
    mkdirSync(path.dirname(enDoc), { recursive: true });
    const enBefore = "# X\n\n🌐 **Languages:** stale\n\n---\n\nbody\n";
    writeFileSync(enDoc, enBefore, "utf8");

    // Mirror with a stale bar.
    const arDoc = path.join(root, "docs", "i18n", "ar", "docs", "guides", "X.md");
    mkdirSync(path.dirname(arDoc), { recursive: true });
    const arBefore = "# X (العربية)\n\n🌐 **Languages:** stale\n\n---\n\ncorpo\n";
    writeFileSync(arDoc, arBefore, "utf8");

    // Mirror without any bar — must never gain one.
    const bareDoc = path.join(root, "docs", "i18n", "pt-BR", "docs", "guides", "X.md");
    mkdirSync(path.dirname(bareDoc), { recursive: true });
    const bareText = "# X (Português)\n\nsem barra\n";
    writeFileSync(bareDoc, bareText, "utf8");

    const expectedChanged = ["docs/guides/X.md", "docs/i18n/ar/docs/guides/X.md"];

    // Dry-run: reports the stale files and writes nothing.
    assert.deepEqual(await syncLanguageBars({ root, dryRun: true }), expectedChanged);
    assert.equal(readFileSync(enDoc, "utf8"), enBefore);
    assert.equal(readFileSync(arDoc, "utf8"), arBefore);
    assert.equal(readFileSync(bareDoc, "utf8"), bareText);

    // Apply: both stale bars are regenerated in place, the rest of each file is untouched.
    assert.deepEqual(await syncLanguageBars({ root, dryRun: false }), expectedChanged);
    assert.equal(
      readFileSync(enDoc, "utf8"),
      "# X\n\n🌐 **Languages:** 🇺🇸 [English](./X.md) | 🇸🇦 [العربية](../i18n/ar/docs/guides/X.md) | 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/guides/X.md)\n\n---\n\nbody\n"
    );
    assert.equal(
      readFileSync(arDoc, "utf8"),
      "# X (العربية)\n\n🌐 **Languages:** 🇺🇸 [English](../../../../guides/X.md) · 🇧🇷 [pt-BR](../../../pt-BR/docs/guides/X.md)\n\n---\n\ncorpo\n"
    );
    assert.equal(readFileSync(bareDoc, "utf8"), bareText);

    // Idempotent: a second pass finds nothing left to update.
    assert.deepEqual(await syncLanguageBars({ root, dryRun: true }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
