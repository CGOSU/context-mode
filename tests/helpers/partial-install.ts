import { afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Register isolated cleanup once per partial-install suite. */
export function setupPartialInstallFixture() {
const heallessCleanups: string[] = [];

afterEach(() => {
      while (heallessCleanups.length) {
        const dir = heallessCleanups.pop();
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      }
    });

function makeTmp(prefix = "ctx-heal-partial-"): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      heallessCleanups.push(dir);
      return dir;
    }

// Build a fake CC plugin layout under a fresh tmp dir:
    //   <root>/.claude/plugins/cache/context-mode/context-mode/<version>/
    //   <root>/.claude/plugins/marketplaces/context-mode/
    // The marketplace clone gets a realistic package.json files[] pointing
    // at a few canned dirs + files so the heal has concrete sources to
    // copy. The cache dir starts empty so each test can populate the exact
    // subset it wants to simulate.
    function buildFakeLayout(version = "1.0.150"): {
      pluginRoot: string;
      marketplaceClonePath: string;
    } {
      const root = makeTmp();
      const pluginsDir = resolve(root, ".claude", "plugins");
      const pluginRoot = resolve(
        pluginsDir,
        "cache",
        "context-mode",
        "context-mode",
        version,
      );
      const marketplaceClonePath = resolve(
        pluginsDir,
        "marketplaces",
        "context-mode",
      );
      mkdirSync(marketplaceClonePath, { recursive: true });
      writeFileSync(
        resolve(marketplaceClonePath, "package.json"),
        JSON.stringify(
          {
            name: "context-mode",
            version,
            files: [
              "hooks",
              ".claude-plugin",
              "scripts/postinstall.mjs",
              "scripts/plugin-cache-integrity.mjs",
              "cli.bundle.mjs",
              "server.bundle.mjs",
              "start.mjs",
              "bin",
            ],
          },
          null,
          2,
        ),
      );
      writeFileSync(resolve(marketplaceClonePath, "start.mjs"), "// start\n");
      writeFileSync(
        resolve(marketplaceClonePath, "cli.bundle.mjs"),
        "// cli bundle\n",
      );
      writeFileSync(
        resolve(marketplaceClonePath, "server.bundle.mjs"),
        "// server bundle\n",
      );
      mkdirSync(resolve(marketplaceClonePath, "hooks"), { recursive: true });
      writeFileSync(
        resolve(marketplaceClonePath, "hooks", "sessionstart.mjs"),
        "// hook\n",
      );
      mkdirSync(resolve(marketplaceClonePath, ".claude-plugin"), {
        recursive: true,
      });
      writeFileSync(
        resolve(marketplaceClonePath, ".claude-plugin", "plugin.json"),
        JSON.stringify(
          {
            name: "context-mode",
            version,
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
      mkdirSync(resolve(marketplaceClonePath, "scripts"), { recursive: true });
      writeFileSync(
        resolve(marketplaceClonePath, "scripts", "postinstall.mjs"),
        "// postinstall\n",
      );
      writeFileSync(
        resolve(marketplaceClonePath, "scripts", "plugin-cache-integrity.mjs"),
        "// integrity\n",
      );
      mkdirSync(resolve(marketplaceClonePath, "bin"), { recursive: true });
      writeFileSync(
        resolve(marketplaceClonePath, "bin", "statusline.mjs"),
        "// statusline\n",
      );
      mkdirSync(pluginRoot, { recursive: true });
      return { pluginRoot, marketplaceClonePath };
    }

function readJson(path: string): unknown {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
return { makeTmp, buildFakeLayout, readJson };
}
