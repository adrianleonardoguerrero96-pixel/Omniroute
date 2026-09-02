/**
 * Shared builders for the `🌐 **Languages:** …` bars that head every English
 * doc and every translated mirror. `config` is the parsed `config/i18n.json`
 * (`locales[]` with `code`, `flag`, `native`); all paths are repo-relative POSIX
 * (`docs/guides/USER_GUIDE.md`, `README.md`) and the links are relative to the
 * file that carries the bar.
 *
 *   buildMirrorBar(rel, locale, config)  →  docs/i18n/<locale>/… format:
 *     🌐 **Languages:** 🇺🇸 [English](../../../README.md) · 🇸🇦 [ar](../ar/README.md) · …
 *   buildSourceBar(rel, config)          →  English source format:
 *     🌐 **Languages:** 🇺🇸 [English](./USER_GUIDE.md) | 🇧🇷 [Português (Brasil)](../i18n/pt-BR/docs/guides/USER_GUIDE.md) | …
 *   replaceLanguageBar(markdown, bar)    →  swaps EVERY bar line (any `🌐 **<label>:**`,
 *                                          translated labels included), `null` when there is none.
 */
import path from "node:path";

const DOCS_I18N = "docs/i18n";

function mirrorPath(relSource, locale) {
  return path.posix.join(DOCS_I18N, locale, relSource);
}

export function buildMirrorBar(relSource, locale, config) {
  const targetDir = path.posix.dirname(mirrorPath(relSource, locale));
  const parts = [`🇺🇸 [English](${path.posix.relative(targetDir, relSource)})`];
  for (const entry of config.locales) {
    if (entry.code === "en" || entry.code === locale) continue;
    const peer = path.posix.relative(targetDir, mirrorPath(relSource, entry.code));
    parts.push(`${entry.flag} [${entry.code}](${peer})`);
  }
  return `🌐 **Languages:** ${parts.join(" · ")}`;
}

export function buildSourceBar(relSource, config) {
  const sourceDir = path.posix.dirname(relSource);
  const parts = [`🇺🇸 [English](./${path.posix.basename(relSource)})`];
  for (const entry of config.locales) {
    if (entry.code === "en") continue;
    const peer = path.posix.relative(sourceDir, mirrorPath(relSource, entry.code));
    parts.push(`${entry.flag} [${entry.native ?? entry.name}](${peer})`);
  }
  return `🌐 **Languages:** ${parts.join(" | ")}`;
}

/**
 * A language-bar line: `🌐 **<label>:**  …`. The label is NOT pinned to the
 * canonical English "Languages" — older mirrors carry the label the translation
 * backend produced (`🌐 **Idiomas:**`, `🌐 **語言:**`, `🌐 **Available in:**`, …)
 * and those bars are exactly the ones that still list retired locales. Matching
 * them by prefix (no regex, no backtracking on ~6 KB lines) is what lets
 * syncLanguageBars normalize every bar in the repo instead of only the ones
 * already in canonical form.
 */
const isLanguageBar = (line) => line.startsWith("🌐 **") && line.indexOf("**", 4) !== -1;

export function replaceLanguageBar(markdown, bar) {
  const lines = markdown.split("\n");
  let found = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!isLanguageBar(lines[index])) continue;
    lines[index] = bar;
    found = true;
  }
  // Every bar in the file describes the same file, so they all get the same
  // (correct) list: a stale second bar left in a translated body would otherwise
  // keep pointing at locales that no longer exist.
  return found ? lines.join("\n") : null;
}
