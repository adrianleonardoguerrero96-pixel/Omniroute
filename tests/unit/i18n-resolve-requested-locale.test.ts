import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequestedLocale } from "../../src/i18n/resolveRequestedLocale.ts";

const LOCALES = ["en", "id", "uk-UA", "phi"] as const;
const ALIASES = { id: ["in"], "uk-UA": ["uk"], phi: ["fil", "tl"] } as const;

test("returns the locale itself when it is configured", () => {
  assert.equal(resolveRequestedLocale("uk-UA", LOCALES, ALIASES, "en"), "uk-UA");
});

test("resolves a legacy or bare alias stored in the cookie (in → id, uk → uk-UA)", () => {
  assert.equal(resolveRequestedLocale("in", LOCALES, ALIASES, "en"), "id");
  assert.equal(resolveRequestedLocale("uk", LOCALES, ALIASES, "en"), "uk-UA");
});

test("is case-insensitive and falls back when unknown or empty", () => {
  assert.equal(resolveRequestedLocale("UK-ua", LOCALES, ALIASES, "en"), "uk-UA");
  assert.equal(resolveRequestedLocale("xx", LOCALES, ALIASES, "en"), "en");
  assert.equal(resolveRequestedLocale("", LOCALES, ALIASES, "en"), "en");
});
