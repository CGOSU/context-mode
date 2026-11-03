/** Hook regressions: security-warning. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useMcpReadyFixture } from "./mcp-ready-fixture.js";
import { SLICE4_DIRNAME, routingUrl, spawnRoutingProbe } from "./routing-probe.js";
useMcpReadyFixture();



// ─────────────────────────────────────────────────────────
// Slice 4 — additionalContext surfacing on security init fail (#558)
// ─────────────────────────────────────────────────────────
//
// The pre-558 silent-fail UX gap: when initSecurity() fails to load the
// security module (marketplace install missing build/security.js AND
// hooks/security.bundle.mjs), the only signal is a stderr WARNING line
// that adapters typically suppress / discard. The user has no in-band
// signal that permissions.deny is fail-open.
//
// Fix: routing.mjs exposes `buildSecurityWarningContext()` — a pure
// helper that returns a structured agent-facing block when
// isSecurityInitFailed() is true, and null otherwise. SessionStart
// hooks call initSecurity() and append the block to their
// additionalContext, so the agent sees the warning in-context (not
// just in suppressed stderr).

describe("buildSecurityWarningContext — agent-facing security warning (#558)", () => {
  it("returns null when security init has not failed (default state)", async () => {
    // Use a subprocess so the module-scoped securityInitFailed flag
    // is in its initial false state — the in-process module from
    // beforeAll() above may have been touched by other tests.
    const r = await spawnRoutingProbe(`
      import { buildSecurityWarningContext, isSecurityInitFailed } from ${routingUrl()};
      process.stdout.write(JSON.stringify({
        failed: isSecurityInitFailed(),
        warning: buildSecurityWarningContext(),
      }));
    `);
    expect(r.parsed.failed).toBe(false);
    expect(r.parsed.warning).toBeNull();
  });

  it("returns a structured warning string when security init has failed", async () => {
    const missingBundle = join(tmpdir(), `ctx-slice4-no-bundle-${Date.now()}.bundle.mjs`);
    const missingBuild = join(tmpdir(), `ctx-slice4-no-build-${Date.now()}`);
    const r = await spawnRoutingProbe(
      `
      import { initSecurity, buildSecurityWarningContext, isSecurityInitFailed } from ${routingUrl()};
      await initSecurity(${JSON.stringify(missingBuild)});
      process.stdout.write(JSON.stringify({
        failed: isSecurityInitFailed(),
        warning: buildSecurityWarningContext(),
      }));
      `,
      {
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: missingBundle,
      },
    );
    expect(r.parsed.failed).toBe(true);
    expect(r.parsed.warning).toBeTruthy();
    expect(typeof r.parsed.warning).toBe("string");
    // Must mention the security gap and the remediation, AND must use
    // a recognizable XML-ish wrapper so the agent can parse / scope it.
    expect(r.parsed.warning).toMatch(/security/i);
    expect(r.parsed.warning).toMatch(/permissions\.deny|deny pattern/i);
    expect(r.parsed.warning).toMatch(/<context_mode_security_warning>|security_warning/);
    // Must point users at the actionable fix.
    expect(r.parsed.warning).toMatch(/npm run bundle|security\.bundle\.mjs|reinstall/i);
  });

  it("hooks/sessionstart.mjs wires initSecurity + buildSecurityWarningContext into the SessionStart additionalContext", () => {
    // Static-source check — the wiring must be present in the
    // top-level Claude Code SessionStart hook so users see the
    // warning in-band on first session of a broken install.
    const src = readFileSync(resolve(SLICE4_DIRNAME, "..", "..", "hooks", "sessionstart.mjs"), "utf-8");
    expect(src).toContain("initSecurity");
    expect(src).toContain("buildSecurityWarningContext");
    expect(src).toContain("isSecurityInitFailed");
  });
});
