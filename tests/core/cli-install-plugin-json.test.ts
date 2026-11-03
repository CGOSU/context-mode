import { describe, it, expect } from "vitest";

import { readFileSync, mkdirSync, writeFileSync, cpSync, symlinkSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";




import { setupPartialInstallFixture } from "../helpers/partial-install.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("hooks/heal-partial-install.mjs (plugin-json)", () => {
const { makeTmp, buildFakeLayout, readJson } = setupPartialInstallFixture();
it("healPartialInstallFromMarketplace rewrites carry-forward stale args[0] in plugin.json", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");

      // Seed pluginRoot with the user-observed carry-forward state:
      // plugin.json copied from 1.0.146 with bun + an absolute args[0].
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
                  "/home/u/.claude/plugins/cache/context-mode/context-mode/1.0.146/start.mjs",
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.argsRewritten).toBe(true);
      const fixed = readJson(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      ) as {
        mcpServers: { "context-mode": { args: string[] } };
      };
      expect(fixed.mcpServers["context-mode"].args[0]).toContain("1.0.150");
      expect(fixed.mcpServers["context-mode"].args[0]).not.toContain("1.0.146");
    });

it.skipIf(process.platform === "win32")("healPartialInstallFromMarketplace refuses to rewrite plugin.json when it's a symlink", async () => {
      // Defense-in-depth flagged by round-4 adversarial review: a
      // same-user-planted symlink at .claude-plugin/plugin.json would
      // otherwise feed attacker JSON into readFileSync, and the
      // atomic writeFileSync+renameSync below would replace the
      // symlink with a regular file containing attacker mcpServers
      // config. POSIX 0700 on ~/.claude scopes this to same-user
      // threats, but the heal mirrors the source/destination
      // symlink refusals applied elsewhere.
      //
      // Skipped on Windows: the defense uses openSync(O_NOFOLLOW),
      // and libuv silently drops O_NOFOLLOW on Windows (the constant
      // exists for portability but maps to no underlying NT flag).
      // Real-world Windows users typically don't have Developer Mode
      // enabled and so can't plant the symlink in the first place,
      // but on CI runners (which DO have Developer Mode) the
      // production defense degrades to no-op and the test would
      // fail. Re-enable when Node ships a NoOpenReparsePoint
      // translation in libuv (tracked nodejs/node#XYZ — TODO).
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");

      // Stage attacker-controlled mcpServers JSON outside the cache
      // tree. The args[0] points at a since-deleted version dir so a
      // naive rewrite (the carry-forward stale-version code path)
      // would mutate it AND write the result into the canonical
      // plugin.json location, materializing the attacker config.
      const attackerRoot = mkdtempSync(join(tmpdir(), "plugin-json-attack-"));
      const attackerJsonPath = join(attackerRoot, "plugin.json");
      writeFileSync(
        attackerJsonPath,
        JSON.stringify({
          name: "context-mode",
          version: "1.0.150",
          mcpServers: {
            "context-mode": {
              command: "/attacker/payload.sh",
              args: [
                "/home/u/.claude/plugins/cache/context-mode/context-mode/1.0.146/start.mjs",
              ],
            },
          },
        }),
      );

      // Plant the symlink at the canonical location. readFileSync
      // would follow this; the lstatSync guard must refuse.
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      symlinkSync(
        attackerJsonPath,
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The rewrite was refused.
      expect(result.argsRewritten).toBe(false);
      // plugin.json on disk is still a symlink; it was not replaced
      // by a regular file with attacker mcpServers.
      const stPj = lstatSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      );
      expect(stPj.isSymbolicLink()).toBe(true);
      // The attacker JSON at the symlink target was not modified
      // either (renameSync would have left it intact even if the
      // guard had failed, but assert anyway as a tripwire for any
      // future implementation that decides to write through the
      // symlink path).
      const attackerStillThere = JSON.parse(
        readFileSync(attackerJsonPath, "utf-8"),
      );
      expect(attackerStillThere.mcpServers["context-mode"].command).toBe(
        "/attacker/payload.sh",
      );
    });

it("healPartialInstallFromMarketplace resolves the ${CLAUDE_PLUGIN_ROOT} placeholder", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "context-mode",
            version: "1.0.150",
            mcpServers: {
              "context-mode": {
                command: "node",
                args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
              },
            },
          },
          null,
          2,
        ),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.argsRewritten).toBe(true);
      const fixed = readJson(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
      ) as {
        mcpServers: { "context-mode": { args: string[] } };
      };
      expect(fixed.mcpServers["context-mode"].args[0]).not.toContain(
        "${CLAUDE_PLUGIN_ROOT}",
      );
      expect(fixed.mcpServers["context-mode"].args[0]).toContain("start.mjs");
    });

it("healPartialInstallFromMarketplace leaves a healthy plugin.json alone", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout("1.0.150");
      // Seed a healthy plugin.json directly: no placeholder, args[0] is
      // an absolute path under the current pluginRoot. The rewrite path
      // should all branches decline to mutate.
      mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
      const healthyArgs0 = join(pluginRoot, "start.mjs").replace(/\\/g, "/");
      writeFileSync(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "context-mode",
            version: "1.0.150",
            mcpServers: {
              "context-mode": {
                command: "node",
                args: [healthyArgs0],
              },
            },
          },
          null,
          2,
        ),
      );
      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });
      expect(result.healed).toContain("start.mjs");
      expect(result.argsRewritten).toBe(false);
    });
});
