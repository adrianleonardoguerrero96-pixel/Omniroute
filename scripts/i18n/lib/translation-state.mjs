import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * Builds a `.i18n-state.json` document from what is on disk, without any
 * translation call. Used to re-bootstrap incremental drift detection after the
 * state file was lost (deleted in v3.8.10) — every existing mirror is adopted
 * as "in sync with the current source".
 */
export async function adoptState({ root, sources, locales, targetPathFor }) {
  const state = { sources: {} };
  for (const rel of sources) {
    const sourceHash = sha256(await fs.readFile(path.join(root, rel)));
    const entry = { source_hash: sourceHash, locales: {} };
    for (const locale of locales) {
      const target = targetPathFor(rel, locale);
      if (!existsSync(target)) continue;
      entry.locales[locale] = {
        source_hash: sourceHash,
        target_hash: sha256(await fs.readFile(target)),
        updated_at: new Date().toISOString(),
      };
    }
    state.sources[rel] = entry;
  }
  return state;
}
