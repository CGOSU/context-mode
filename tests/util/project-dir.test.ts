import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isPluginInstallPath,
  resolveProjectDir,
} from "../../src/util/project-dir.js";

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

function compiledResolverScript(): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), "build/util/project-dir.js")).href;
  return `
    import { resolveProjectDir } from ${JSON.stringify(moduleUrl)};
    const result = resolveProjectDir({
      env: {},
      cwd: "/Users/x/fallback",
      pwd: undefined,
    });
    console.log(result);
  `;
}

function runCompiledResolver(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    env: { ...process.env, PWD: "" },
  }).trim();
}

describe("isPluginInstallPath", () => {
  it("matches macOS / Linux plugin cache and marketplace paths", () => {
    expect(isPluginInstallPath("/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.112")).toBe(true);
    expect(isPluginInstallPath("/home/x/.codex/plugins/cache/foo/foo/1.0.0")).toBe(true);
    expect(isPluginInstallPath("/Users/x/.claude/plugins/marketplaces/context-mode")).toBe(true);
    expect(isPluginInstallPath("C:\\Users\\x\\.claude\\plugins\\cache\\foo\\foo\\1.0.0")).toBe(true);
  });

  it("returns false for ordinary project paths and non-plugin storage paths", () => {
    expect(isPluginInstallPath("/Users/x/Server/proj")).toBe(false);
    expect(isPluginInstallPath("/Users/x/.claude/context-mode/sessions/abc.db")).toBe(false);
    expect(isPluginInstallPath("")).toBe(false);
    expect(isPluginInstallPath("/")).toBe(false);
  });
});

describe("resolveProjectDir (Pi-only cascade)", () => {
  it("prefers PI_WORKSPACE_DIR > PI_PROJECT_DIR > CONTEXT_MODE_PROJECT_DIR > PWD > cwd", () => {
    expect(resolveProjectDir({
      env: {
        PI_WORKSPACE_DIR: "/Users/x/ws",
        PI_PROJECT_DIR: "/Users/x/pi",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/ctx",
      },
      cwd: "/some/cwd",
      pwd: "/Users/x/pwd",
    })).toBe("/Users/x/ws");

    expect(resolveProjectDir({
      env: {
        PI_PROJECT_DIR: "/Users/x/pi",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/ctx",
      },
      cwd: "/some/cwd",
      pwd: "/Users/x/pwd",
    })).toBe("/Users/x/pi");

    expect(resolveProjectDir({
      env: {
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/ctx",
      },
      cwd: "/some/cwd",
      pwd: "/Users/x/pwd",
    })).toBe("/Users/x/ctx");
  });

  it("ignores foreign host env vars such as CLAUDE_PROJECT_DIR, GEMINI_PROJECT_DIR, and CURSOR_CWD", () => {
    const result = resolveProjectDir({
      env: {
        CLAUDE_PROJECT_DIR: "/leak/from/claude",
        GEMINI_PROJECT_DIR: "/leak/from/gemini",
        CURSOR_CWD: "/leak/from/cursor",
        PI_PROJECT_DIR: "/Users/x/own-pi-project",
      },
      cwd: "/some/cwd",
      pwd: undefined,
    });
    expect(result).toBe("/Users/x/own-pi-project");
  });

  it("rejects plugin path env vars and falls through to PWD / cwd", () => {
    const result = resolveProjectDir({
      env: {
        PI_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
        CONTEXT_MODE_PROJECT_DIR: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      },
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: "/Users/x/Server/realproj",
    });
    expect(result).toBe("/Users/x/Server/realproj");
  });

  it("falls back to cwd when env + PWD are missing", () => {
    expect(resolveProjectDir({ env: {}, cwd: "/Users/x/proj", pwd: undefined })).toBe("/Users/x/proj");
    expect(resolveProjectDir({
      env: {},
      cwd: "/Users/x/.claude/plugins/cache/foo/foo/1.0.0",
      pwd: undefined,
    })).toBe("/Users/x/.claude/plugins/cache/foo/foo/1.0.0");
  });

  it("compiled ESM resolver runs under Node without CommonJS require", () => {
    const output = runCompiledResolver(process.execPath, [
      "--input-type=module",
      "-e",
      compiledResolverScript(),
    ]);
    expect(output).toBe("/Users/x/fallback");
  });

  it.runIf(bunAvailable)("compiled ESM resolver runs under Bun without CommonJS require", () => {
    const output = runCompiledResolver("bun", ["-e", compiledResolverScript()]);
    expect(output).toBe("/Users/x/fallback");
  });
});
