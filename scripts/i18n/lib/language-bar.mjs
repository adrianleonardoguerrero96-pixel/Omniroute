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
 *   replaceLanguageBar(markdown, bar)    →  swaps the first bar line, `null` when there is none.
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

export function replaceLanguageBar(markdown, bar) {
  const lines = markdown.split("\n");
  const index = lines.findIndex((line) => line.startsWith("🌐 **Languages:**"));
  if (index === -1) return null;
  lines[index] = bar;
  return lines.join("\n");
}
