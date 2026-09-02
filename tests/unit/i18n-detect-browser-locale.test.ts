import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBrowserLocale } from "../../src/i18n/detectBrowserLocale";

const SUPPORTED_LOCALES = ["en", "pt-BR", "es", "zh-TW", "fr", "de"] as const;

describe("detectBrowserLocale", () => {
  it("returns the exact match when a browser language equals a supported locale", () => {
    assert.equal(detectBrowserLocale(["pt-BR"], SUPPORTED_LOCALES), "pt-BR");
  });

  it("folds zh-HK to zh-TW when zh-TW is supported", () => {
    assert.equal(detectBrowserLocale(["zh-HK"], SUPPORTED_LOCALES), "zh-TW");
  });

  it("folds zh-MO to zh-TW when zh-TW is supported", () => {
    assert.equal(detectBrowserLocale(["zh-MO"], SUPPORTED_LOCALES), "zh-TW");
  });

  it("falls back to a language-prefix match when no exact match exists", () => {
    assert.equal(detectBrowserLocale(["en-US"], SUPPORTED_LOCALES), "en");
  });

  it("returns null when nothing matches", () => {
    assert.equal(detectBrowserLocale(["ja-JP"], SUPPORTED_LOCALES), null);
  });

  it("returns null for an empty languages list", () => {
    assert.equal(detectBrowserLocale([], SUPPORTED_LOCALES), null);
  });

  it("returns null for an empty locales list", () => {
    assert.equal(detectBrowserLocale(["en-US"], []), null);
  });

  it("tries each browser language in order until one matches", () => {
    assert.equal(detectBrowserLocale(["ja-JP", "fr-CA"], SUPPORTED_LOCALES), "fr");
  });

  it("is case-insensitive", () => {
    assert.equal(detectBrowserLocale(["PT-br"], SUPPORTED_LOCALES), "pt-BR");
  });

  // Regional-code locales (`uk-UA`, `phi`) plus the alias map shape exported by
  // `@/i18n/config` (`LOCALE_ALIASES`) — browsers send `uk`, `fil`/`tl`.
  const REGIONAL_LOCALES = ["en", "uk-UA", "phi", "pt", "pt-BR", "zh-CN", "zh-TW"] as const;
  const ALIASES = { "uk-UA": ["uk"], phi: ["fil", "tl"] } as const;

  it("resolves a declared alias (fil → phi)", () => {
    assert.equal(detectBrowserLocale(["fil"], REGIONAL_LOCALES, ALIASES), "phi");
  });

  it("resolves an alias carried by a regional tag (fil-PH → phi, TL → phi)", () => {
    assert.equal(detectBrowserLocale(["fil-PH"], REGIONAL_LOCALES, ALIASES), "phi");
    assert.equal(detectBrowserLocale(["TL"], REGIONAL_LOCALES, ALIASES), "phi");
  });

  it("matches a bare base language to a regional locale of that language (uk → uk-UA) without aliases", () => {
    assert.equal(detectBrowserLocale(["uk"], REGIONAL_LOCALES), "uk-UA");
  });

  it("picks the first regional locale in config order for a bare base language (zh → zh-CN)", () => {
    assert.equal(detectBrowserLocale(["zh"], REGIONAL_LOCALES), "zh-CN");
  });

  it("keeps the exact/prefix precedence: pt-PT → pt, pt-BR → pt-BR", () => {
    assert.equal(detectBrowserLocale(["pt-PT"], REGIONAL_LOCALES, ALIASES), "pt");
    assert.equal(detectBrowserLocale(["pt-BR"], REGIONAL_LOCALES, ALIASES), "pt-BR");
  });

  it("still returns null when nothing matches, even with aliases", () => {
    assert.equal(detectBrowserLocale(["ja-JP"], REGIONAL_LOCALES, ALIASES), null);
  });
});
