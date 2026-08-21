/**
 * Regression tests for the Cursor provider "Token expired" false positive and
 * the auto-import credential-discovery misses.
 *
 * Observed live defect (2026-08-04): a `cursor` provider_connection whose stored
 * `expires_at` was 2026-08-02 reported `401 "Token expired"` on
 * /api/providers/<id>/test 8 times over two days, while the SAME connection
 * served a real completion (`cursor/composer-2.5` → HTTP 200). The token's own
 * JWT `exp` claim was 2026-09-25 — i.e. the stored expiry was fabricated by a
 * hardcoded `expiresIn: 86400` at import time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CursorService,
  resolveCursorTokenTtlSeconds,
  CURSOR_FALLBACK_TOKEN_TTL_SECONDS,
} from "../../src/lib/oauth/services/cursor";
import {
  cursorAgentAuthCandidatePaths,
  detectContainerizedHome,
} from "../../src/app/api/oauth/cursor/auto-import/route";

/** Build an unsigned JWT with an arbitrary payload (signature is never checked). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("resolveCursorTokenTtlSeconds (Token-expired false positive)", () => {
  const NOW = Date.UTC(2026, 7, 4, 12, 0, 0); // 2026-08-04T12:00:00Z

  it("derives the real multi-week TTL from the JWT exp claim", () => {
    // The exact shape observed live: token imported Aug 1, exp Sep 25.
    const exp = Math.floor(Date.UTC(2026, 8, 25, 14, 56, 51) / 1000);
    const token = makeJwt({
      sub: "auth0|user_01K4X0C3G7Z1MRG0RMFGMZY2MQ",
      aud: "https://cursor.com",
      exp,
    });

    const ttl = resolveCursorTokenTtlSeconds(token, NOW);

    // THE REGRESSION ASSERTION: the old code returned exactly 86400 here, which
    // is what wrote a bogus ~24h expires_at and produced the false 401.
    assert.notEqual(ttl, CURSOR_FALLBACK_TOKEN_TTL_SECONDS);
    assert.equal(ttl, Math.floor((exp * 1000 - NOW) / 1000));
    assert.ok(ttl > 40 * 24 * 3600, `expected >40 days of TTL, got ${ttl}s`);
  });

  it("persists an expires_at that keeps the connection valid past 24h", () => {
    // Directly models the import route's arithmetic:
    //   expiresAt = now + expiresIn * 1000
    // and the test route's isTokenExpired() 5-minute buffer.
    const exp = Math.floor(Date.UTC(2026, 8, 25, 0, 0, 0) / 1000);
    const token = makeJwt({ exp });

    const expiresAtMs = NOW + resolveCursorTokenTtlSeconds(token, NOW) * 1000;
    const threeDaysLater = NOW + 3 * 24 * 3600 * 1000;
    const buffer = 5 * 60 * 1000;

    // isTokenExpired(): expiresAt <= now + buffer
    assert.equal(
      expiresAtMs <= threeDaysLater + buffer,
      false,
      "token must NOT read as expired 3 days after import"
    );
  });

  it("returns a non-positive TTL for a genuinely expired token (no papering over)", () => {
    const exp = Math.floor(Date.UTC(2026, 7, 1, 0, 0, 0) / 1000); // 3 days before NOW
    const ttl = resolveCursorTokenTtlSeconds(makeJwt({ exp }), NOW);
    assert.ok(ttl < 0, `expected negative TTL, got ${ttl}`);
    // Must not silently become the 24h fallback — a real expiry has to surface.
    assert.notEqual(ttl, CURSOR_FALLBACK_TOKEN_TTL_SECONDS);
  });

  it("falls back to 24h for an opaque (non-JWT) token", () => {
    assert.equal(
      resolveCursorTokenTtlSeconds("not-a-jwt-just-a-long-opaque-string", NOW),
      CURSOR_FALLBACK_TOKEN_TTL_SECONDS
    );
  });

  it("falls back to 24h when the exp claim is missing or non-numeric", () => {
    assert.equal(
      resolveCursorTokenTtlSeconds(makeJwt({ sub: "x" }), NOW),
      CURSOR_FALLBACK_TOKEN_TTL_SECONDS
    );
    assert.equal(
      resolveCursorTokenTtlSeconds(makeJwt({ exp: "soon" }), NOW),
      CURSOR_FALLBACK_TOKEN_TTL_SECONDS
    );
  });

  it("falls back to 24h on undecodable payloads instead of throwing", () => {
    assert.equal(
      resolveCursorTokenTtlSeconds("aaa.!!!not-base64!!!.ccc", NOW),
      CURSOR_FALLBACK_TOKEN_TTL_SECONDS
    );
    assert.equal(resolveCursorTokenTtlSeconds("", NOW), CURSOR_FALLBACK_TOKEN_TTL_SECONDS);
  });
});

describe("CursorService.validateImportToken (call-site wiring)", () => {
  // Guards the WIRING, not just the helper: reverting the call site to a
  // hardcoded `expiresIn: 86400` leaves every helper test green, so without
  // this the regression is invisible.
  it("reports the JWT-derived TTL, not a hardcoded 24h", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // 60 days out
    const token = makeJwt({ sub: "auth0|u", aud: "https://cursor.com", exp });

    const data = await new CursorService().validateImportToken(
      token,
      "67f9471b-61c5-4857-8402-379bcf4f20ac"
    );

    assert.notEqual(data.expiresIn, CURSOR_FALLBACK_TOKEN_TTL_SECONDS);
    assert.ok(data.expiresIn > 50 * 24 * 3600, `expected >50d, got ${data.expiresIn}s`);
    assert.equal(data.authMethod, "imported");
    // And the value the import route actually persists must outlive 24h.
    const expiresAt = Date.now() + data.expiresIn * 1000;
    assert.ok(expiresAt > Date.now() + 2 * 24 * 3600 * 1000);
  });

  it("still falls back to 24h for an opaque token (no exp to read)", async () => {
    const data = await new CursorService().validateImportToken("x".repeat(120));
    assert.equal(data.expiresIn, CURSOR_FALLBACK_TOKEN_TTL_SECONDS);
    assert.equal(data.authMethod, "cursor-agent");
  });
});

describe("cursorAgentAuthCandidatePaths (macOS discovery miss)", () => {
  it("probes ~/.cursor/auth.json FIRST on macOS", () => {
    const paths = cursorAgentAuthCandidatePaths("darwin", { home: "/Users/test" });
    // THE REGRESSION ASSERTION: the old code only ever built the XDG path, so on
    // darwin it probed ~/.config/cursor/auth.json — never written by the CLI.
    assert.equal(paths[0], "/Users/test/.cursor/auth.json");
    assert.ok(
      paths.includes("/Users/test/.config/cursor/auth.json"),
      "XDG path retained as a fallback"
    );
  });

  it("keeps the XDG path canonical on Linux", () => {
    assert.deepEqual(cursorAgentAuthCandidatePaths("linux", { home: "/home/test" }), [
      "/home/test/.config/cursor/auth.json",
    ]);
  });

  it("honours XDG_CONFIG_HOME when set", () => {
    assert.deepEqual(
      cursorAgentAuthCandidatePaths("linux", { home: "/home/test", xdgConfigHome: "/xdg" }),
      ["/xdg/cursor/auth.json"]
    );
  });

  it("uses APPDATA/Cursor on Windows", () => {
    const paths = cursorAgentAuthCandidatePaths("win32", {
      home: "C:/Users/test",
      appdata: "C:/Users/test/AppData/Roaming",
    });
    assert.equal(paths[0], "C:/Users/test/AppData/Roaming/Cursor/auth.json");
  });

  it("never emits duplicate candidates", () => {
    const paths = cursorAgentAuthCandidatePaths("darwin", {
      home: "/Users/test",
      xdgConfigHome: "/Users/test/.config",
    });
    assert.equal(paths.length, new Set(paths).size);
  });
});

describe("detectContainerizedHome (misleading 'Install Cursor IDE' message)", () => {
  const containerNoCursor = (p: string) => p === "/.dockerenv";

  it("detects the Docker deployment where no host home is mounted", () => {
    assert.equal(
      detectContainerizedHome({
        platform: "linux",
        home: "/home/node",
        existsSync: containerNoCursor,
      }),
      true
    );
  });

  it("also honours the podman container marker", () => {
    assert.equal(
      detectContainerizedHome({
        platform: "linux",
        home: "/home/node",
        existsSync: (p) => p === "/run/.containerenv",
      }),
      true
    );
  });

  it("returns false on a bare host (no container marker)", () => {
    assert.equal(
      detectContainerizedHome({
        platform: "darwin",
        home: "/Users/test",
        existsSync: () => false,
      }),
      false
    );
  });

  it("returns false inside a container that DOES have a mounted Cursor config", () => {
    // Guard against over-reach: a containerized setup that bind-mounts the host
    // home is a legitimate auto-import target and must not be short-circuited.
    assert.equal(
      detectContainerizedHome({
        platform: "linux",
        home: "/home/node",
        existsSync: (p) => p === "/.dockerenv" || p === "/home/node/.config/Cursor",
      }),
      false
    );
  });

  it("recognises a mounted macOS-style Cursor footprint too", () => {
    assert.equal(
      detectContainerizedHome({
        platform: "linux",
        home: "/host",
        existsSync: (p) => p === "/.dockerenv" || p === "/host/Library/Application Support/Cursor",
      }),
      false
    );
  });
});
