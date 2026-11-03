import { describe, test, expect } from "vitest";

import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";





const ROOT = resolve(import.meta.dirname, "../..");

describe("start.mjs CLI self-heal", () => {
test("start.mjs self-heals cli.bundle.mjs when missing", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    // Must check for cli.bundle.mjs existence
    expect(src).toContain("cli.bundle.mjs");
    // Must reference build/cli.js as fallback source
    expect(src).toContain("build");
    expect(src).toContain("cli.js");
    // Must write a shim
    expect(src).toContain("writeFileSync");
  });

test("start.mjs CLI self-heal is after ensure-deps import and before server import", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    // Anchor on actual statements, not raw filename mentions. The Linux Bun
    // re-exec change in commit f985afa added a documentation comment that
    // names `server.bundle.mjs` near the top of the file; `indexOf` matched
    // THAT comment instead of the actual `await import("./server.bundle.mjs")`,
    // pushing the assertion to compare selfHealIdx=16381 < commentIdx=2347 →
    // FAIL on otherwise-correct ordering. Use uniquely-shaped statement
    // fragments so a future comment cannot shift the test's compass.
    const ensureDepsIdx    = src.indexOf('import "./hooks/ensure-deps.mjs"');
    const selfHealIdx      = src.indexOf('if (!existsSync(resolve(__dirname, "cli.bundle.mjs"))');
    const serverImportIdx  = src.indexOf('await import("./server.bundle.mjs")');
    expect(ensureDepsIdx,   "ensure-deps import statement missing").toBeGreaterThan(-1);
    expect(selfHealIdx,     "cli.bundle.mjs self-heal block missing").toBeGreaterThan(-1);
    expect(serverImportIdx, "server.bundle.mjs await-import missing").toBeGreaterThan(-1);
    // Self-heal must be between ensure-deps import and server import.
    expect(selfHealIdx).toBeGreaterThan(ensureDepsIdx);
    expect(selfHealIdx).toBeLessThan(serverImportIdx);
  });

// ── Algo-D4: plugin-cache integrity from package.json files[] ──
  //
  // #550: partial install (e.g. interrupted npm install, broken
  // marketplace pull) leaves start.mjs spawnable but server.bundle.mjs
  // missing. The MCP child then dies silently downstream — user sees
  // "MCP server failed to start" with no actionable signal. D4 derives
  // the expected sibling tree from package.json files[] (the npm publish
  // source of truth) and exits 2 with a structured stderr block listing
  // the missing files. Algorithmic: adding a new entry to files[] auto-
  // extends the integrity check — no parallel hardcoded list to
  // maintain.
  test("scripts/plugin-cache-integrity.mjs derives expected files from package.json files[]", async () => {
    const { derivePluginManifest } = await import(
      "../../scripts/plugin-cache-integrity.mjs"
    );
    // Synthetic package.json: directories recurse; files are kept as-is.
    const pkg = {
      files: ["server.bundle.mjs", "cli.bundle.mjs", "hooks", "start.mjs"],
    };
    const helperRoot = mkdtempSync(join(tmpdir(), "ctx-mode-pcim-"));
    try {
      // Build a tree shaped like the npm tarball
      writeFileSync(join(helperRoot, "server.bundle.mjs"), "");
      writeFileSync(join(helperRoot, "cli.bundle.mjs"), "");
      writeFileSync(join(helperRoot, "start.mjs"), "");
      mkdirSync(join(helperRoot, "hooks"));
      writeFileSync(join(helperRoot, "hooks", "pretooluse.mjs"), "");
      writeFileSync(join(helperRoot, "hooks", "sessionstart.mjs"), "");

      const manifest = derivePluginManifest({ pkg, pluginRoot: helperRoot });
      // Files in files[] kept as-is; directories recurse to enumerate
      // every file inside.
      expect(manifest).toContain("server.bundle.mjs");
      expect(manifest).toContain("cli.bundle.mjs");
      expect(manifest).toContain("start.mjs");
      expect(manifest).toContain(join("hooks", "pretooluse.mjs"));
      expect(manifest).toContain(join("hooks", "sessionstart.mjs"));
    } finally {
      rmSync(helperRoot, { recursive: true, force: true });
    }
  });

test("scripts/plugin-cache-integrity.mjs returns OK when all expected siblings exist", async () => {
    const { assertPluginCacheIntegrity } = await import(
      "../../scripts/plugin-cache-integrity.mjs"
    );
    // The actual repo root has every entry from package.json files[]
    // present (it's the source of truth that gets published). So a
    // probe against ROOT must return ok=true.
    const result = assertPluginCacheIntegrity({ pluginRoot: ROOT });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

test("scripts/plugin-cache-integrity.mjs flags missing files as not-ok", async () => {
    const { assertPluginCacheIntegrity } = await import(
      "../../scripts/plugin-cache-integrity.mjs"
    );
    // Empty pluginRoot → every required file is missing.
    const emptyRoot = mkdtempSync(join(tmpdir(), "ctx-mode-pcim-empty-"));
    try {
      const result = assertPluginCacheIntegrity({ pluginRoot: emptyRoot });
      expect(result.ok).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
      // The check must surface the absolute path so users can see
      // exactly where it looked — not a relative segment.
      for (const m of result.missing) {
        expect(m.startsWith(emptyRoot)).toBe(true);
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

test("start.mjs invokes assertPluginCacheIntegrity with stderr + exit 2 on failure (Algo-D4)", () => {
    // Wiring check on the bootstrapper itself: the start.mjs body must
    // import the helper, call it, and on `!ok` write a structured stderr
    // block (CONTEXT_MODE_PARTIAL_INSTALL) then process.exit(2). The
    // structured marker lets external monitoring grep for the exact
    // failure mode without parsing free-form text.
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    expect(src).toContain("plugin-cache-integrity.mjs");
    expect(src).toContain("assertPluginCacheIntegrity");
    expect(src).toContain("CONTEXT_MODE_PARTIAL_INSTALL");
    expect(src).toMatch(/process\.exit\(\s*2\s*\)/);
  });

test("scripts/plugin-cache-integrity.mjs ships in npm tarball (package.json files[])", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("scripts/plugin-cache-integrity.mjs");
  });

// ── Algo-D4 — algorithmic runtime-sibling derivation (#558) ──────────
  //
  // v1.0.126 shipped Algo-D4 with a HARDCODED `REQUIRED_RUNTIME_SIBLINGS`
  // array that omitted `hooks/security.bundle.mjs` (and would omit any
  // future runtime-critical bundle). Result: the integrity check returns
  // `{ ok: true }` on a marketplace install where `hooks/security.bundle.mjs`
  // is missing — exactly the silent fail-open #558 reports. The fix is
  // algorithmic: derive the required-sibling set from `derivePluginManifest`
  // (which itself reads `package.json files[]`), filtered to a runtime-
  // critical pattern. Adding `hooks/security.bundle.mjs` (or any future
  // hooks/*.bundle.mjs) to files[] auto-extends the integrity check.
  test("Algo-D4 algorithmically requires hooks/security.bundle.mjs (#558)", async () => {
    // Synthesize a marketplace-install scenario: every hardcoded boot
    // sibling is present, but hooks/security.bundle.mjs is NOT. The pre-
    // 558 hardcoded check passes vacuously here — that's the regression.
    const { assertPluginCacheIntegrity } = await import(
      "../../scripts/plugin-cache-integrity.mjs"
    );
    const fakeRoot = mkdtempSync(join(tmpdir(), "ctx-mode-d4-algo-"));
    try {
      // Stage every legacy-hardcoded sibling so the test isolates the
      // new requirement: only hooks/security.bundle.mjs is missing.
      writeFileSync(join(fakeRoot, "server.bundle.mjs"), "");
      writeFileSync(join(fakeRoot, "cli.bundle.mjs"), "");
      writeFileSync(join(fakeRoot, "start.mjs"), "");
      mkdirSync(join(fakeRoot, "hooks"));
      writeFileSync(join(fakeRoot, "hooks", "pretooluse.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "posttooluse.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "precompact.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "sessionstart.mjs"), "");
      writeFileSync(join(fakeRoot, "hooks", "userpromptsubmit.mjs"), "");
      // Copy the real package.json so the algorithm reads the same
      // files[] the npm tarball ships with.
      const pkgSrc = readFileSync(resolve(ROOT, "package.json"), "utf-8");
      writeFileSync(join(fakeRoot, "package.json"), pkgSrc);

      const result = assertPluginCacheIntegrity({ pluginRoot: fakeRoot });
      expect(result.ok).toBe(false);
      // Must surface the missing security bundle path so the doctor /
      // boot-fail block tells users exactly what's broken.
      const missingStr = result.missing.join("\n");
      expect(missingStr).toContain("security.bundle.mjs");
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

test("Algo-D4 derivation reads scripts.bundle outfiles — pure-data, no parallel hardcoded list", async () => {
    // Algorithmic guarantee: a future runtime bundle added to
    // `scripts.bundle` (with `--outfile=hooks/foo.bundle.mjs`) is
    // auto-gated by Algo-D4 — no parallel REQUIRED_RUNTIME_SIBLINGS
    // edit needed. Soft-fallback bundles (session-* with
    // bundle-first/build-fallback in session-loaders.mjs) are
    // explicitly whitelisted out.
    const mod: any = await import("../../scripts/plugin-cache-integrity.mjs");
    // The new public surface — algorithm must be inspectable from tests.
    expect(typeof mod.getRequiredRuntimeSiblings).toBe("function");

    const fakeRoot = mkdtempSync(join(tmpdir(), "ctx-mode-d4-pkg-"));
    try {
      // Synthetic package.json: scripts.bundle produces 3 outfiles.
      //   - hooks/security.bundle.mjs is runtime-critical → required.
      //   - hooks/session-db.bundle.mjs is soft-fallback → NOT required.
      //   - hooks/foo.bundle.mjs is a hypothetical future bundle → required
      //     (proves the gate auto-extends without code changes).
      const pkg = {
        files: ["server.bundle.mjs", "cli.bundle.mjs", "hooks", "start.mjs"],
        scripts: {
          bundle:
            "esbuild src/security.ts --outfile=hooks/security.bundle.mjs && " +
            "esbuild src/session/db.ts --outfile=hooks/session-db.bundle.mjs && " +
            "esbuild src/foo.ts --outfile=hooks/foo.bundle.mjs",
        },
      };
      writeFileSync(join(fakeRoot, "package.json"), JSON.stringify(pkg));

      const required: string[] = mod.getRequiredRuntimeSiblings(fakeRoot);
      // Runtime-critical bundle must be in the set:
      expect(required.some((p) => p.endsWith("security.bundle.mjs"))).toBe(true);
      // Hypothetical future bundle auto-included (the algorithmic win):
      expect(required.some((p) => p.endsWith("foo.bundle.mjs"))).toBe(true);
      // Soft-fallback bundle MUST be excluded — its absence is gracefully
      // handled by session-loaders.mjs's bundle-first/build-fallback.
      expect(required.some((p) => p.endsWith("session-db.bundle.mjs"))).toBe(false);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

test("Algo-D4 preserves the legacy hardcoded contract (no regression on existing required siblings)", async () => {
    // Backward-compat guarantee: every entry that used to be in the
    // hardcoded REQUIRED_RUNTIME_SIBLINGS array must still be flagged
    // as required by the algorithmic derivation. This pins the
    // pre-558 contract so the algorithmic refactor is purely additive.
    const mod: any = await import("../../scripts/plugin-cache-integrity.mjs");
    const required: string[] = mod.getRequiredRuntimeSiblings(ROOT);
    const legacy = [
      "server.bundle.mjs",
      "cli.bundle.mjs",
      join("hooks", "pretooluse.mjs"),
      join("hooks", "posttooluse.mjs"),
      join("hooks", "precompact.mjs"),
      join("hooks", "sessionstart.mjs"),
      join("hooks", "userpromptsubmit.mjs"),
    ];
    for (const entry of legacy) {
      expect(
        required.some((p) => p === entry || p.endsWith(entry)),
        `legacy required sibling missing from algorithmic set: ${entry}`,
      ).toBe(true);
    }
  });
});
