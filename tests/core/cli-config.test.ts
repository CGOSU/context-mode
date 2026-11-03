import { readCliSource } from "../helpers/cli-source.js";
import { describe, it, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";


import { execSync } from "node:child_process";
import { toUnixPath } from "../../src/cli-shared.js";



const ROOT = resolve(import.meta.dirname, "../..");

// ── cli.bundle.mjs — marketplace install support ──────────────────────

describe("cli.bundle.mjs — marketplace install support", () => {
  // ── Package configuration ─────────────────────────────────

  it("package.json files field includes cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("cli.bundle.mjs");
  });

  it("package.json files field includes statusline bin", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain("bin");
  });

  it("package.json files field includes Codex plugin files", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toContain(".codex-plugin");
  });

  it("Codex plugin MCP manifest approves context-mode tools by default", () => {
    const mcp = JSON.parse(readFileSync(resolve(ROOT, ".codex-plugin", "mcp.json"), "utf-8"));
    expect(mcp.mcpServers["context-mode"].default_tools_approval_mode).toBe("approve");
  });

  it("package.json bundle script builds cli.bundle.mjs", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts.bundle).toContain("cli.bundle.mjs");
    expect(pkg.scripts.bundle).toContain("src/cli.ts");
  });

  // ── Bundle artifact ────────────────────────────────────────

  it("cli.bundle.mjs exists after npm run bundle", () => {
    expect(existsSync(resolve(ROOT, "cli.bundle.mjs"))).toBe(true);
  });

  it("cli.bundle.mjs is readable", () => {
    expect(() => accessSync(resolve(ROOT, "cli.bundle.mjs"), constants.R_OK)).not.toThrow();
  });

  it("cli.bundle.mjs has shebang only on line 1 (Node.js strips it)", () => {
    const content = readFileSync(resolve(ROOT, "cli.bundle.mjs"), "utf-8");
    const lines = content.split("\n");
    expect(lines[0].startsWith("#!")).toBe(true);
    // No shebang on any other line (would cause SyntaxError)
    const shebangsAfterLine1 = lines.slice(1).filter(l => l.startsWith("#!"));
    expect(shebangsAfterLine1).toHaveLength(0);
  });

  // ── Source code contracts ──────────────────────────────────

  it("cli.ts getPluginRoot handles both build/ and root locations", () => {
    const src = readCliSource();
    // Must detect build/ subdirectory and go up, or stay at root
    expect(src).toContain('endsWith("/build")');
    expect(src).toContain('endsWith("\\\\build")');
  });

  it("cli.ts upgrade copies cli.bundle.mjs to target", () => {
    const src = readCliSource();
    expect(src).toContain('"cli.bundle.mjs"');
    // Must be in the items array for in-place update
    expect(src).toMatch(/items\s*=\s*\[[\s\S]*?"cli\.bundle\.mjs"/);
  });

  it("cli.ts exposes index/search commands for terminal knowledge-base access", () => {
    const src = readCliSource();
    expect(src).toContain("context-mode index <path>");
    expect(src).toContain("context-mode search <query...>");
    expect(src).toContain('args[0] === "index"');
    expect(src).toContain('args[0] === "search"');
    expect(src).toContain("resolveContentStorePath");
    expect(src).toContain("searchWithFallback");
  });

  it("cli.ts upgrade doctor call prefers cli.bundle.mjs with fallback", () => {
    const src = readCliSource();
    expect(src).toContain("cli.bundle.mjs");
    expect(src).toContain("build");
    expect(src).toContain("cli.js");
    // Must use existsSync for fallback
    expect(src).toContain("existsSync");
  });

  it("cli.ts upgrade refreshes better-sqlite3 native addon after deps install", () => {
    const src = readCliSource();
    // Extract only the upgrade function body (starts with "async function upgrade")
    const upgradeStart = src.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeSrc = src.slice(upgradeStart);
    // Must refresh native addons between production deps and global install.
    // Compatibility must be delegated to hooks/ensure-deps.mjs so stale ABI
    // binaries are repaired before upgrade declares native addons healthy.
    const depsIdx = upgradeSrc.indexOf('"install", "--production"');
    const refreshIdx = upgradeSrc.indexOf('"sqlite-health.mjs"');
    const globalIdx = upgradeSrc.indexOf('"install", "-g"');
    expect(depsIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    // refresh step must come after deps and before global install
    expect(refreshIdx).toBeGreaterThan(depsIdx);
    expect(refreshIdx).toBeLessThan(globalIdx);
  });

  it("cli.ts upgrade chmod handles both cli binaries", () => {
    const src = readCliSource();
    // Must chmod both build/cli.js and cli.bundle.mjs
    expect(src).toMatch(/for\s*\(.*\["build\/cli\.js",\s*"cli\.bundle\.mjs"\]/);
  });

  // ── Skill files ────────────────────────────────────────────

  it("ctx-upgrade skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    // Fallback pattern: try bundle first, then build
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  it("ctx-doctor skill uses cli.bundle.mjs with fallback", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    expect(skill).toContain("cli.bundle.mjs");
    expect(skill).toContain("build/cli.js");
    expect(skill).toMatch(/CLI=.*cli\.bundle\.mjs.*\[ ! -f.*\].*build\/cli\.js/);
  });

  it("ctx-index and ctx-search skills expose slash-style triggers", () => {
    const indexSkill = readFileSync(resolve(ROOT, "skills", "ctx-index", "SKILL.md"), "utf-8");
    const searchSkill = readFileSync(resolve(ROOT, "skills", "ctx-search", "SKILL.md"), "utf-8");
    expect(indexSkill).toContain("Trigger: /context-mode:ctx-index");
    expect(indexSkill).toContain("user-invocable: true");
    expect(indexSkill).toContain("context-mode index");
    expect(searchSkill).toContain("Trigger: /context-mode:ctx-search");
    expect(searchSkill).toContain("user-invocable: true");
    expect(searchSkill).toContain("context-mode search");
  });

  // ── .gitignore ─────────────────────────────────────────────

  it(".gitignore excludes bundle files (CI uses git add -f)", () => {
    const gitignore = readFileSync(resolve(ROOT, ".gitignore"), "utf-8");
    expect(gitignore).toContain("server.bundle.mjs");
    expect(gitignore).toContain("cli.bundle.mjs");
  });
});

// ── .mcp.json — MCP server config ────────────────────────────────────

describe(".mcp.json — MCP server config", () => {
  it("upgrade MUST NOT write `.mcp.json` into the plugin cache dir (Issue #609 architectural lock)", () => {
    // Bug-class history this lock protects:
    //   #411 introduced a `.mcp.json` write here with a CLAUDE_PLUGIN_ROOT
    //   placeholder. That solved an absolute-path-bake symptom but kept the
    //   write itself in place. Every /ctx-upgrade since then re-baked a
    //   per-version .mcp.json. When Claude Code's native plugin auto-update
    //   later copies the previous version's .mcp.json forward into the new
    //   cache dir, the path goes stale → MODULE_NOT_FOUND on every MCP boot,
    //   while ctx-doctor stays green (#609).
    //
    // Architectural fix: STOP writing `.mcp.json` from cli.ts entirely. The
    // canonical MCP source is `.claude-plugin/plugin.json.mcpServers`
    // (Claude Code upstream: mcpPluginIntegration.ts:131-212 reads it first).
    // The post-bump `sweepStaleMcpJson` call removes any pre-existing files
    // so the carry-forward vector cannot replay.
    //
    // This test enforces the architectural decision. Re-introducing the write
    // would re-open the bug class regardless of which path shape is used
    // (placeholder OR absolute) — the write itself is the surface area.
    const src = readCliSource();
    const upgradeStart = src.indexOf("async function upgrade");
    const upgradeSrc = src.slice(upgradeStart);
    // The items[] copy list must still NOT include .mcp.json (kept from #531).
    const itemsMatch = upgradeSrc.match(/const items\s*=\s*\[([\s\S]*?)\];/);
    expect(itemsMatch).not.toBeNull();
    expect(itemsMatch![1]).not.toContain(".mcp.json");
    // cli.ts upgrade() MUST NOT write `.mcp.json` to pluginRoot. Any
    // resolve(pluginRoot, ".mcp.json") + writeFileSync chain is forbidden.
    expect(upgradeSrc).not.toMatch(/writeFileSync\(\s*resolve\(\s*pluginRoot\s*,\s*["']\.mcp\.json["']/);
  });

  it("upgrade MUST sweep stale .mcp.json files post-bump (Issue #609)", () => {
    // Belt-and-braces partner to the no-write lock above: cli.ts MUST call
    // `sweepStaleMcpJson` after `updatePluginRegistry` so any pre-existing
    // copies left by prior versions (or carried forward by Claude Code's
    // auto-update) are removed before the upgrade is declared successful.
    const src = readCliSource();
    // Import from the shared heal module — single source of truth.
    expect(src).toMatch(
      /sweepStaleMcpJson[^;]*from\s+["']\.\.\/scripts\/heal-installed-plugins\.mjs["']/,
    );
    const upgradeStart = src.indexOf("async function upgrade");
    // Slice the whole upgrade region rather than a fixed-width window so
    // pattern lookups stay valid as the function grows under feature work.
    const upgradeSrc = src.slice(upgradeStart);
    // Order constraint: sweep runs AFTER updatePluginRegistry so the
    // cleanup operates against the final on-disk shape.
    const updateIdx = upgradeSrc.indexOf("updatePluginRegistry");
    const sweepIdx = upgradeSrc.indexOf("sweepStaleMcpJson");
    expect(updateIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(updateIdx);
    // Belt-and-braces second-call assertion: if first sweep removed files,
    // a second pass MUST report removed:[] or upgrade() throws.
    const block = upgradeSrc.slice(sweepIdx, sweepIdx + 1500);
    expect(block).toMatch(/sweep drift|sweep check failed/i);
    expect(block).toMatch(/throw new Error/);
  });

  it("plugin manifest keeps ${CLAUDE_PLUGIN_ROOT} for marketplace compatibility", () => {
    // Marketplace installs read .claude-plugin/plugin.json, not repo-root
    // .mcp.json. The plugin manifest is the one that must retain the
    // ${CLAUDE_PLUGIN_ROOT} placeholder so installed plugins resolve their
    // bundled server path. Repo-root .mcp.json is for contributors opening
    // the repo as a regular project and uses a relative path to avoid the
    // "Missing environment variable: CLAUDE_PLUGIN_ROOT" warning.
    //
    // We read the COMMITTED file via `git show HEAD:` rather than the
    // working-tree copy because hooks/normalize-hooks.mjs intentionally
    // rewrites the on-disk plugin.json to absolute paths on Windows after
    // postinstall (#378 — MSYS path mangling). The marketplace assertion
    // is about what we SHIP, not about what local install scripts mutate.
    const committed = execSync("git show HEAD:.claude-plugin/plugin.json", {
      cwd: ROOT,
      encoding: "utf-8",
    });
    const plugin = JSON.parse(committed);
    const args = plugin.mcpServers["context-mode"].args;
    expect(args[0]).toContain("CLAUDE_PLUGIN_ROOT");
  });

  it(".mcp.json.example template MUST use ${CLAUDE_PLUGIN_ROOT} placeholder (closes #531)", () => {
    // Architectural lock-in after PR #253 (aea633c) regression:
    // .mcp.json is no longer tracked in source. The canonical template lives
    // at .mcp.json.example so contributors who copy it locally still get
    // the marketplace-correct placeholder form. End-user MCP launch flows
    // through `.claude-plugin/plugin.json.mcpServers` only — cli.ts no longer
    // writes `.mcp.json` into the plugin cache (Issue #609 fix).
    const example = JSON.parse(
      readFileSync(resolve(ROOT, ".mcp.json.example"), "utf-8"),
    );
    const args = example.mcpServers["context-mode"].args;
    expect(args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(args[0]).toContain("start.mjs");
  });

  it("package.json files[] MUST NOT ship .mcp.json (architectural lock — closes #531)", () => {
    // PR #253 flip-flop: source .mcp.json kept switching between the
    // placeholder form (correct for end-users via marketplace install) and
    // the relative form (correct for contributors opening the repo as a
    // regular project). Stop shipping it in the tarball so the two roles
    // never collide again. End users get MCP via .claude-plugin/plugin.json
    // — cli.ts no longer writes `.mcp.json` to the plugin cache (#609).
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.files).toBeDefined();
    expect(pkg.files).not.toContain(".mcp.json");
  });
});

// ── CLI Hook Path Tests ───────────────────────────────────────────────

describe("CLI Hook Path Tests", () => {
  test("toUnixPath: converts backslashes to forward slashes", () => {
    const input = "C:\\Users\\xxx\\AppData\\Local\\npm-cache\\_npx\\hooks\\pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(
      !result.includes("\\"),
      `Expected no backslashes, got: ${result}`,
    );
    assert.equal(
      result,
      "C:/Users/xxx/AppData/Local/npm-cache/_npx/hooks/pretooluse.mjs",
    );
  });

  test("toUnixPath: leaves forward-slash paths unchanged", () => {
    const input = "/home/user/.claude/plugins/context-mode/hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.equal(result, input);
  });

  test("toUnixPath: handles mixed slashes", () => {
    const input = "C:/Users\\xxx/AppData\\Local\\hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(!result.includes("\\"), `Expected no backslashes, got: ${result}`);
  });

  test("toUnixPath: hook command string has no backslashes", () => {
    // Simulate what upgrade() does: "node " + resolve(...)
    // On Windows, resolve() returns backslashes — toUnixPath must normalize them
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\pretooluse.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `Hook command must not contain backslashes: ${command}`,
    );
  });

  test("toUnixPath: sessionstart path has no backslashes", () => {
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\sessionstart.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `SessionStart command must not contain backslashes: ${command}`,
    );
  });
});
