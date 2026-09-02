/**
 * `adoptState` (scripts/i18n/lib/translation-state.mjs) rebuilds the
 * `.i18n-state.json` document from what is already on disk — hashing sources
 * and existing mirrors, never calling a translation backend — so incremental
 * drift detection (`npm run i18n:check`) can be re-bootstrapped after the state
 * file was lost. `run-translation.mjs --adopt` is a thin wrapper around it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adoptState } from "../../scripts/i18n/lib/translation-state.mjs";

type LocaleState = { source_hash: string; target_hash: string; updated_at: string };
type AdoptedState = {
  sources: Record<string, { source_hash: string; locales: Record<string, LocaleState> }>;
};

const RUN_TRANSLATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/i18n/run-translation.mjs"
);

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "i18n-adopt-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const mirrorPathFor = (root: string) => (rel: string, locale: string) =>
  path.join(root, "docs", "i18n", locale, rel);

test("adoptState hashes every existing source/target pair and skips missing targets", async () => {
  await withTempRoot(async (root) => {
    writeFileSync(path.join(root, "README.md"), "# A\n");
    mkdirSync(path.join(root, "docs", "i18n", "es"), { recursive: true });
    writeFileSync(path.join(root, "docs", "i18n", "es", "README.md"), "# A (Español)\n");

    const state = (await adoptState({
      root,
      sources: ["README.md"],
      locales: ["es", "de"],
      targetPathFor: mirrorPathFor(root),
    })) as AdoptedState;

    assert.equal(state.sources["README.md"].source_hash, sha("# A\n"));
    assert.equal(state.sources["README.md"].locales.es.target_hash, sha("# A (Español)\n"));
    assert.equal(state.sources["README.md"].locales.es.source_hash, sha("# A\n"));
    assert.equal(state.sources["README.md"].locales.de, undefined);
  });
});

test("adoptState records every source (nested paths too), keeps `locales` empty without mirrors, and stamps ISO timestamps", async () => {
  await withTempRoot(async (root) => {
    mkdirSync(path.join(root, "docs", "guides"), { recursive: true });
    writeFileSync(path.join(root, "README.md"), "# A\n");
    writeFileSync(path.join(root, "docs", "guides", "GUIDE.md"), "# Guide\n");
    mkdirSync(path.join(root, "docs", "i18n", "fr", "docs", "guides"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "i18n", "fr", "docs", "guides", "GUIDE.md"),
      "# Guide (FR)\n"
    );

    const asked: string[] = [];
    const before = Date.now();
    const state = (await adoptState({
      root,
      sources: ["README.md", "docs/guides/GUIDE.md"],
      locales: ["fr", "de"],
      targetPathFor: (rel: string, locale: string) => {
        asked.push(`${rel} → ${locale}`);
        return mirrorPathFor(root)(rel, locale);
      },
    })) as AdoptedState;

    assert.deepEqual(Object.keys(state.sources), ["README.md", "docs/guides/GUIDE.md"]);
    // A source without any mirror on disk is still recorded, with nothing adopted.
    assert.deepEqual(state.sources["README.md"], { source_hash: sha("# A\n"), locales: {} });

    const guide = state.sources["docs/guides/GUIDE.md"];
    assert.equal(guide.source_hash, sha("# Guide\n"));
    assert.deepEqual(Object.keys(guide.locales), ["fr"]);
    assert.equal(guide.locales.fr.source_hash, sha("# Guide\n"));
    assert.equal(guide.locales.fr.target_hash, sha("# Guide (FR)\n"));

    const stamp = Date.parse(guide.locales.fr.updated_at);
    assert.equal(new Date(stamp).toISOString(), guide.locales.fr.updated_at);
    assert.ok(stamp >= before && stamp <= Date.now(), "updated_at is the adoption time");

    // Every (source, locale) pair is resolved through the caller's path mapper.
    assert.deepEqual(asked, [
      "README.md → fr",
      "README.md → de",
      "docs/guides/GUIDE.md → fr",
      "docs/guides/GUIDE.md → de",
    ]);
  });
});

test("adoptState rejects instead of silently skipping a listed source that is missing on disk", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      adoptState({
        root,
        sources: ["MISSING.md"],
        locales: ["es"],
        targetPathFor: mirrorPathFor(root),
      }),
      { code: "ENOENT" }
    );
  });
});

test("run-translation.mjs --help advertises --adopt as a no-API-call state rebuild", () => {
  const out = execFileSync(process.execPath, [RUN_TRANSLATION, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(out, /--adopt\s+Rebuild \.i18n-state\.json from the files on disk \(no API calls\)/);
});
