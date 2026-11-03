/** OpenClaw regressions: openclaw-install-config. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";



// ═══════════════════════════════════════════════════════════
// Install-time runtime-config mutation
// (scripts/lib/register-openclaw-config.mjs, called by
//  scripts/install-openclaw-plugin.sh step 5)
// ═══════════════════════════════════════════════════════════

describe("registerContextModeInOpenclawConfig", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  let tmp: string;
  let runtimePath: string;
  const pluginRoot = "/fake/plugin/root";
  const expectedBundle = `${pluginRoot}/server.bundle.mjs`;

  // Dynamic import avoids a TS `allowJs: false` compile error for the .mjs
  // helper while still running the real implementation under vitest.
  let registerContextModeInOpenclawConfig: (
    runtimePath: string,
    pluginRoot: string,
  ) => {
    pluginsAllow: string[];
    mcpServer: { command: string; args: string[] };
    messages: string[];
  };

  beforeAll(async () => {
    ({ registerContextModeInOpenclawConfig } = (await import(
      "../../scripts/lib/register-openclaw-config.mjs"
    )) as {
      registerContextModeInOpenclawConfig: typeof registerContextModeInOpenclawConfig;
    });
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cfg-"));
    runtimePath = join(tmp, "openclaw.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers mcp.servers.context-mode with an absolute server.bundle.mjs path", () => {
    writeFileSync(runtimePath, "{}");
    registerContextModeInOpenclawConfig(runtimePath, pluginRoot);
    const cfg = JSON.parse(readFileSync(runtimePath, "utf8"));
    expect(cfg.mcp?.servers?.["context-mode"]).toEqual({
      command: "node",
      args: [expectedBundle],
    });
  });

  it("is idempotent — re-running against an already-configured file is a no-op", () => {
    writeFileSync(runtimePath, "{}");
    registerContextModeInOpenclawConfig(runtimePath, pluginRoot);
    const first = readFileSync(runtimePath, "utf8");
    registerContextModeInOpenclawConfig(runtimePath, pluginRoot);
    const second = readFileSync(runtimePath, "utf8");
    expect(second).toEqual(first);
  });

  it("updates a stale MCP server path when pluginRoot changes", () => {
    writeFileSync(
      runtimePath,
      JSON.stringify({
        mcp: {
          servers: {
            "context-mode": { command: "node", args: ["/old/path/server.bundle.mjs"] },
          },
        },
      }),
    );
    registerContextModeInOpenclawConfig(runtimePath, "/new/path");
    const cfg = JSON.parse(readFileSync(runtimePath, "utf8"));
    expect(cfg.mcp.servers["context-mode"].args[0]).toEqual(
      "/new/path/server.bundle.mjs",
    );
  });

  it("keeps the existing plugins.allow / plugins.entries contract", () => {
    writeFileSync(runtimePath, "{}");
    registerContextModeInOpenclawConfig(runtimePath, pluginRoot);
    const cfg = JSON.parse(readFileSync(runtimePath, "utf8"));
    expect(cfg.plugins.allow).toContain("context-mode");
    expect(cfg.plugins.entries["context-mode"]).toEqual({ enabled: true });
  });

  it("removes the legacy plugins.load.paths entry when present", () => {
    writeFileSync(
      runtimePath,
      JSON.stringify({ plugins: { load: { paths: [pluginRoot, "/other/plugin"] } } }),
    );
    registerContextModeInOpenclawConfig(runtimePath, pluginRoot);
    const cfg = JSON.parse(readFileSync(runtimePath, "utf8"));
    expect(cfg.plugins.load?.paths ?? []).not.toContain(pluginRoot);
  });

  it("preserves unrelated fields on the existing mcp.servers entry when refreshing the path", () => {
    writeFileSync(
      runtimePath,
      JSON.stringify({
        mcp: {
          servers: {
            "context-mode": {
              command: "node",
              args: ["/old/path/server.bundle.mjs"],
              env: { CTX_LOG_LEVEL: "debug" },
              cwd: "/opt/custom",
              timeout: 45000,
            },
          },
        },
      }),
    );
    registerContextModeInOpenclawConfig(runtimePath, "/new/path");
    const entry = JSON.parse(readFileSync(runtimePath, "utf8")).mcp.servers["context-mode"];
    expect(entry.args[0]).toEqual("/new/path/server.bundle.mjs");
    expect(entry.env).toEqual({ CTX_LOG_LEVEL: "debug" });
    expect(entry.cwd).toEqual("/opt/custom");
    expect(entry.timeout).toEqual(45000);
  });

  it("throws a useful error when the runtime config is not valid JSON", () => {
    writeFileSync(runtimePath, "{ this is not json");
    expect(() => registerContextModeInOpenclawConfig(runtimePath, pluginRoot)).toThrow(
      /Failed to parse.*valid JSON/,
    );
  });
});
