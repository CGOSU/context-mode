/** Server regressions: upgrade. */


import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// ctx_upgrade: inline fallback for missing CLI files
// ═══════════════════════════════════════════════════════════════════════════

describe("ctx_upgrade tool: inline fallback for missing CLI", () => {
  const serverSrc = readServerSource();
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
  );

  test("tries cli.bundle.mjs first", () => {
    expect(serverSrc).toContain("cli.bundle.mjs");
    // The bundle path should be checked before fallback
    expect(serverSrc).toMatch(/existsSync\(bundlePath\)/);
  });

  test("ctx_doctor and ctx_upgrade prefer the Codex plugin manager runtime root only for Codex", () => {
    expect(serverSrc).toContain("parseCodexContextModePluginRoot");
    expect(serverSrc).toContain("function resolveCodexRuntimePluginRoot");
    expect(serverSrc).toContain("function getRuntimeAwarePackageRoot");

    const helperBody = serverSrc.slice(
      serverSrc.indexOf("function getRuntimeAwarePackageRoot"),
      serverSrc.indexOf("// Prevent silent MCP server death"),
    );
    expect(helperBody).toContain('platformId === "codex"');
    expect(helperBody).toContain("resolveCodexRuntimePluginRoot(packageRoot)");

    const doctorBody = serverSrc.slice(
      serverSrc.indexOf('server.registerTool(\n  "ctx_doctor"'),
      serverSrc.indexOf('server.registerTool(\n  "ctx_upgrade"'),
    );
    const upgradeBody = serverSrc.slice(
      serverSrc.indexOf('server.registerTool(\n  "ctx_upgrade"'),
      serverSrc.indexOf("// ── ctx-purge"),
    );

    expect(doctorBody).toContain("getRuntimeAwarePackageRoot(currentPlatform)");
    expect(upgradeBody).toContain("platformId = signal.platform");
    expect(upgradeBody).toContain("getRuntimeAwarePackageRoot(platformId)");
  });

  test("tries build/cli.js second", () => {
    expect(serverSrc).toContain('resolve(pluginRoot, "build", "cli.js")');
  });

  test("contains inline fallback with git clone when neither CLI file exists", () => {
    // The fallback must generate an inline script with git clone via execFileSync
    expect(serverSrc).toMatch(/git.*clone.*--depth.*1/);
    // The inline script is written to a temp .mjs file
    expect(serverSrc).toMatch(/\.ctx-upgrade-inline\.mjs/);
  });

  test("inline fallback copies package files to plugin root", () => {
    // The inline script must copy the published package payload back, including
    // newly added files such as the statusline bin directory.
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["server.bundle.mjs", "cli.bundle.mjs", "bin"]),
    );
    expect(serverSrc).toContain('readFileSync(join(T,"package.json"),"utf8")');
    expect(serverSrc).toContain("pkg.files");
    expect(serverSrc).toContain("Array.isArray(pkg.files)");
    // The inline cpSync passes `filter:noSymlink` to refuse copying symlinks
    // back into the plugin tree. Anchor on this shape so future drift toward
    // the unfiltered form is caught.
    expect(serverSrc).toContain(
      "cpSync(from,to,{recursive:true,force:true,filter:noSymlink})",
    );
    expect(serverSrc).toMatch(/npm.*install/);
  });

  test("fallback only triggers when neither CLI file exists", () => {
    // There should be an else/fallback branch after checking both paths
    expect(serverSrc).toMatch(/existsSync\(fallbackPath\)/);
  });

  // ── #469 follow-up: insight-cache cleanup must route through the shared
  //    locale-independent helper, not the original inline `for /f`/`findstr`
  //    block (which was the exact bug PR #469 fixed for ctx_insight). The
  //    orphan call site at the top of the ctx_upgrade handler still carried
  //    the broken pattern. Lock that down here.
  describe("ctx_upgrade insight-cache cleanup uses killProcessOnPort (#469 follow-up)", () => {
    // Scope assertions to the ctx_upgrade tool registration body so we don't
    // accidentally match the shared killProcessOnPort helper definition or
    // its tests below in the same file.
    const upgradeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_upgrade"[\s\S]*?^\);/m,
    );
    const upgradeBody = upgradeMatch ? upgradeMatch[0] : "";

    test("ctx_upgrade tool block was located in source", () => {
      expect(upgradeMatch).not.toBeNull();
    });

    test("ctx_upgrade does NOT contain the broken inline 'for /f' netstat parser", () => {
      // The locale-broken Windows pattern PR #469 already removed from
      // killProcessOnPort. Reintroducing it anywhere in ctx_upgrade is a
      // regression on non-English Windows.
      expect(upgradeBody).not.toMatch(/for\s+\/f\s+"tokens=5"/);
      expect(upgradeBody).not.toMatch(/findstr\s+:4747/);
    });

    test("ctx_upgrade does NOT shell out to taskkill / lsof directly", () => {
      // All port-cleanup must go through the shared helper. The handler
      // itself must not hand-roll either Windows or POSIX kill commands.
      expect(upgradeBody).not.toMatch(/taskkill/);
      expect(upgradeBody).not.toMatch(/lsof\s+-ti:4747/);
    });

    test("ctx_upgrade routes insight-cache cleanup through killProcessOnPort(4747)", () => {
      // Positive assertion: the handler must call the shared helper.
      expect(upgradeBody).toMatch(/killProcessOnPort\(\s*4747\s*\)/);
    });

    test("ctx_upgrade preserves best-effort semantics (cleanup wrapped in try/catch)", () => {
      // Cleanup failure must not block the upgrade — the try/catch at the
      // top of the handler with the "best effort" comment must remain.
      expect(upgradeBody).toMatch(/best effort/i);
    });
  });
});
