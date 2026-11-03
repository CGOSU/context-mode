import { describe, it, expect } from "vitest";

import { readFileSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { resolve, join, sep } from "node:path";






import { setupPartialInstallFixture } from "../helpers/partial-install.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("hooks/heal-partial-install.mjs (recovery)", () => {
const { makeTmp, buildFakeLayout, readJson } = setupPartialInstallFixture();
// ── healPartialInstallFromMarketplace full heal ──

    it("healPartialInstallFromMarketplace early-returns on a healthy install", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBe("not-partial");
      expect(result.healed).toEqual([]);
    });

it("healPartialInstallFromMarketplace skips when the marketplace clone is missing", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot } = buildFakeLayout();
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath: resolve(pluginRoot, "..", "..", "..", "no-such-mp"),
        log: false,
      });
      expect(result.skipped).toBe("no-marketplace");
    });

it("healPartialInstallFromMarketplace copies missing files from the marketplace clone", async () => {
      const { healPartialInstallFromMarketplace, isPartialInstall } =
        await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Replicate the user-observed partial install: hooks/ and
      // .claude-plugin/ made it across, the rest didn't.
      cpSync(
        join(marketplaceClonePath, "hooks"),
        join(pluginRoot, "hooks"),
        { recursive: true, force: true },
      );
      cpSync(
        join(marketplaceClonePath, ".claude-plugin"),
        join(pluginRoot, ".claude-plugin"),
        { recursive: true, force: true },
      );
      expect(isPartialInstall(pluginRoot)).toBe(true);

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBeUndefined();
      expect(result.stillMissing).toEqual([]);
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
      expect(result.healed).toContain("server.bundle.mjs");
      expect(result.healed).toContain("package.json");
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

it("healPartialInstallFromMarketplace falls back to the marketplace's package.json when pluginRoot's is missing", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      // Empty pluginRoot, no package.json.
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBeUndefined();
      expect(result.pkgSource).toBe("marketplace");
      expect(result.healed).toContain("package.json");
    });

it("healPartialInstallFromMarketplace is idempotent across re-runs", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      const first = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(first.healed.length).toBeGreaterThan(0);
      const second = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(second.skipped).toBe("not-partial");
      expect(second.healed).toEqual([]);
    });

it("healPartialInstallFromMarketplace short-circuits with not-claude-code for non-CC pluginRoots", async () => {
      // The heal is scoped to Claude Code's per-version cache layout
      // (~/.claude/plugins/cache/<owner>/<plugin>/<version>/). Other
      // clients (Codex, Cursor, OpenCode, Kiro, gemini-cli, ...) ship
      // their own SessionStart wrappers under hooks/<client>/ and
      // never call this module. The module also guards its scope at
      // runtime: any pluginRoot that doesn't match the CC cache layout
      // bails with skipped="not-claude-code" before any filesystem
      // work runs.
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );

      // npm-global-style layout: no /plugins/cache/ segment.
      const npmGlobalRoot = makeTmp();
      const npmGlobalPlugin = resolve(
        npmGlobalRoot,
        "lib",
        "node_modules",
        "context-mode",
      );
      mkdirSync(npmGlobalPlugin, { recursive: true });
      const r1 = healPartialInstallFromMarketplace({
        pluginRoot: npmGlobalPlugin,
        log: false,
      });
      expect(r1.skipped).toBe("not-claude-code");
      expect(r1.healed).toEqual([]);
      expect(r1.stillMissing).toEqual([]);

      // Codex-style layout: under ~/.codex, no /plugins/cache/.
      const codexRoot = makeTmp();
      const codexPlugin = resolve(
        codexRoot,
        ".codex",
        "plugins",
        "context-mode",
      );
      mkdirSync(codexPlugin, { recursive: true });
      const r2 = healPartialInstallFromMarketplace({
        pluginRoot: codexPlugin,
        log: false,
      });
      expect(r2.skipped).toBe("not-claude-code");
    });

it("healPartialInstallFromMarketplace doesn't overwrite files that already exist", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      // Seed pluginRoot with hooks/sessionstart.mjs holding a custom
      // override. The heal only restores missing paths, so the override
      // should survive.
      mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
      const custom = "// custom user override\n";
      writeFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), custom);
      healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(
        readFileSync(join(pluginRoot, "hooks", "sessionstart.mjs"), "utf-8"),
      ).toBe(custom);
    });

it("healPartialInstallFromMarketplace reproduces and heals the v1.0.150 partial install", async () => {
      const { healPartialInstallFromMarketplace, isPartialInstall } =
        await import("../../hooks/heal-partial-install.mjs");
      // Mirrors the exact failure shape captured in the wild:
      //   - hooks/ and .claude-plugin/ survived
      //   - plus a few non-files[] extras (web/, CONTRIBUTING.md) from an
      //     earlier install moment
      //   - .claude-plugin/plugin.json carry-forwarded from 1.0.146 with
      //     command "/usr/bin/bun" and args[0] pointing at the stale
      //     1.0.146/start.mjs absolute path
      //   - everything else missing
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");
      cpSync(
        join(marketplaceClonePath, "hooks"),
        join(pluginRoot, "hooks"),
        { recursive: true, force: true },
      );
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "context-mode",
            version: "1.0.150",
            mcpServers: {
              "context-mode": {
                command: "/usr/bin/bun",
                args: [
                  pluginRoot.replace("1.0.150", "1.0.146") + sep + "start.mjs",
                ],
              },
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(pluginRoot, "CONTRIBUTING.md"), "# Contributing\n");
      mkdirSync(join(pluginRoot, "web"), { recursive: true });
      writeFileSync(join(pluginRoot, "web", "index.html"), "<!doctype html>");

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // Full recovery: every files[] entry restored, args[0] re-pointed
      // at 1.0.150, and the cheap probe agrees we're healthy.
      expect(result.stillMissing).toEqual([]);
      expect(result.argsRewritten).toBe(true);
      expect(isPartialInstall(pluginRoot)).toBe(false);

      const plugin = readJson(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      ) as {
        mcpServers: { "context-mode": { args: string[] } };
      };
      expect(plugin.mcpServers["context-mode"].args[0]).toContain("1.0.150");
      expect(plugin.mcpServers["context-mode"].args[0]).not.toContain("1.0.146");

      // Non-files[] extras left alone.
      expect(
        readFileSync(join(pluginRoot, "CONTRIBUTING.md"), "utf-8"),
      ).toBe("# Contributing\n");
    });
});
