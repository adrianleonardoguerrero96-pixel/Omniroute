/**
 * Pure browser-language detector used to pick an initial locale on first
 * visit, before the user has made an explicit selection (no cookie set).
 *
 * Matching order:
 *  1. Exact match against `navigator.languages` entries (case-insensitive).
 *  2. `zh-HK` / `zh-MO` are treated as `zh-TW` (Traditional Chinese) since
 *     OmniRoute does not ship a dedicated Hong-Kong/Macau locale.
 *  3. Declared alias — `aliases` has the shape of `LOCALE_ALIASES` from
 *     `@/i18n/config` (locale code → lower-case BCP-47 tags) and is matched on
 *     the full tag or on its base language, e.g. `fil`, `fil-PH`, `tl` → `phi`
 *     and `uk` → `uk-UA`. Aliases of locales not in `locales` are ignored.
 *  4. Language-prefix match — e.g. `en-US` matches a supported `en` locale.
 *  5. Bare base language → first supported regional locale of that language,
 *     in `locales` (config) order — e.g. `uk` → `uk-UA`, `zh` → `zh-CN`.
 *  6. No match → `null` (caller should keep the existing default).
 *
 * Kept dependency-free (no DOM/`navigator` access) so it is trivially unit
 * testable and reusable from both client components and future server code.
 */
export function detectBrowserLocale(
  languages: readonly string[],
  locales: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>> = {}
): string | null {
  if (!languages || languages.length === 0 || !locales || locales.length === 0) {
    return null;
  }

  const normalizedLocales = locales.map((locale) => locale.toLowerCase());

  // alias tag (lower-case) → supported locale, only for locales actually offered.
  const aliasIndex = new Map<string, string>();
  for (const [code, tags] of Object.entries(aliases)) {
    const index = normalizedLocales.indexOf(code.toLowerCase());
    if (index === -1) continue;
    for (const tag of tags) aliasIndex.set(tag.toLowerCase(), locales[index]);
  }

  for (const rawLanguage of languages) {
    if (!rawLanguage) continue;
    const language = rawLanguage.toLowerCase();
    const prefix = language.split("-")[0];

    // 1. Exact match.
    const exactIndex = normalizedLocales.indexOf(language);
    if (exactIndex !== -1) {
      return locales[exactIndex];
    }

    // 2. zh-HK / zh-MO fold to zh-TW when zh-TW is supported (kept for callers
    //    that do not pass aliases).
    if (language === "zh-hk" || language === "zh-mo") {
      const zhTwIndex = normalizedLocales.indexOf("zh-tw");
      if (zhTwIndex !== -1) {
        return locales[zhTwIndex];
      }
    }

    // 3. Declared alias, on the full tag or on its base language (fil-PH → phi).
    const aliased = aliasIndex.get(language) ?? aliasIndex.get(prefix);
    if (aliased) {
      return aliased;
    }

    // 4. Language-prefix match (e.g. "en-US" -> "en").
    const prefixIndex = normalizedLocales.indexOf(prefix);
    if (prefixIndex !== -1) {
      return locales[prefixIndex];
    }

    // 5. Bare base language → first supported regional locale of that language
    //    ("uk" -> "uk-UA", "zh" -> "zh-CN"). Config order decides the tie.
    const regionalIndex = normalizedLocales.findIndex(
      (locale) => locale.includes("-") && locale.split("-")[0] === prefix
    );
    if (regionalIndex !== -1) {
      return locales[regionalIndex];
    }
  }

  return null;
}
