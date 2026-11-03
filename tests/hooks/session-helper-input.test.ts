/** Hook regressions: session-helper-input. */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";


// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════
// resolveConfigDir — respects platform CONFIG_DIR env vars (#289)
// ═══════════════════════════════════════════════════════════════════════

describe("resolveConfigDir (#289)", () => {
  const HELPERS_PATH = join(__dirname, "..", "..", "hooks", "session-helpers.mjs");

  async function loadHelpers(env: Record<string, string> = {}) {
    // Use a subprocess to isolate env var changes
    const code = `
      ${Object.entries(env).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join("\n")}
      const { resolveConfigDir, GEMINI_OPTS, CODEX_OPTS, VSCODE_OPTS, CURSOR_OPTS, KIRO_OPTS } = await import(${JSON.stringify(pathToFileURL(HELPERS_PATH).href)});
      const result = {
        claude_default: resolveConfigDir(),
        gemini_default: resolveConfigDir(GEMINI_OPTS),
        codex_default: resolveConfigDir(CODEX_OPTS),
        vscode_default: resolveConfigDir(VSCODE_OPTS),
        cursor_default: resolveConfigDir(CURSOR_OPTS),
        kiro_default: resolveConfigDir(KIRO_OPTS),
      };
      process.stdout.write(JSON.stringify(result));
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf-8",
      env: { ...process.env, ...env, CONTEXT_MODE_SESSION_SUFFIX: "" },
      timeout: 10000,
    });
    return JSON.parse(r.stdout);
  }

  test("defaults to ~/<configDir> when no env var set", async () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const result = await loadHelpers({
      CLAUDE_CONFIG_DIR: "",
      GEMINI_CLI_HOME: "",
      CODEX_HOME: "",
    });
    expect(result.claude_default).toBe(join(home, ".claude"));
    expect(result.gemini_default).toBe(join(home, ".gemini"));
    expect(result.codex_default).toBe(join(home, ".codex"));
    expect(result.vscode_default).toBe(join(home, ".vscode"));
    expect(result.cursor_default).toBe(join(home, ".cursor"));
    expect(result.kiro_default).toBe(join(home, ".kiro"));
  });

  test("CLAUDE_CONFIG_DIR overrides Claude Code config path", async () => {
    const result = await loadHelpers({ CLAUDE_CONFIG_DIR: "/custom/claude-work" });
    expect(result.claude_default).toBe("/custom/claude-work");
    // Other platforms unaffected
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(result.gemini_default).toBe(join(home, ".gemini"));
  });

  test("GEMINI_CLI_HOME overrides Gemini CLI config path", async () => {
    const result = await loadHelpers({ GEMINI_CLI_HOME: "/custom/gemini" });
    expect(result.gemini_default).toBe("/custom/gemini");
  });

  test("CODEX_HOME overrides Codex CLI config path", async () => {
    const result = await loadHelpers({ CODEX_HOME: "/custom/codex" });
    expect(result.codex_default).toBe("/custom/codex");
  });

  test("tilde expansion works in env var values", async () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const result = await loadHelpers({ CLAUDE_CONFIG_DIR: "~/.claude-work" });
    expect(result.claude_default).toBe(join(home, ".claude-work"));
  });

  test("platforms without configDirEnv ignore env vars", async () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    // VS Code Copilot, Cursor, Kiro have no configDirEnv
    const result = await loadHelpers({});
    expect(result.vscode_default).toBe(join(home, ".vscode"));
    expect(result.cursor_default).toBe(join(home, ".cursor"));
    expect(result.kiro_default).toBe(join(home, ".kiro"));
  });

  test("session DB path uses resolved config dir", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "ctx-config-dir-test-"));
    try {
      const code = `
        process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(customDir)};
        process.env.CLAUDE_PROJECT_DIR = "/test/project";
        process.env.CONTEXT_MODE_SESSION_SUFFIX = "";
        const { getSessionDBPath } = await import(${JSON.stringify(pathToFileURL(HELPERS_PATH).href)});
        process.stdout.write(getSessionDBPath());
      `;
      const r = spawnSync("node", ["--input-type=module", "-e", code], {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: customDir, CLAUDE_PROJECT_DIR: "/test/project", CONTEXT_MODE_SESSION_SUFFIX: "" },
        timeout: 10000,
      });
      expect(r.stdout).toContain(customDir);
      expect(r.stdout).toContain("context-mode");
      expect(r.stdout).toContain("sessions");
      expect(r.stdout).toMatch(/\.db$/);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("session path helpers normalize Windows separators and trailing slashes before hashing", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "ctx-config-dir-test-"));
    try {
      const code = `
        process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(customDir)};
        process.env.CONTEXT_MODE_SESSION_SUFFIX = "";
        const {
          getSessionDBPath,
          getSessionEventsPath,
          getCleanupFlagPath,
        } = await import(${JSON.stringify(pathToFileURL(HELPERS_PATH).href)});
        const opts = { configDir: ".claude", configDirEnv: "CLAUDE_CONFIG_DIR", projectDirEnv: "CLAUDE_PROJECT_DIR" };
        const backslashProject = "C:\\\\Users\\\\me\\\\repo\\\\";
        const slashProject = "C:/Users/me/repo";
        process.stdout.write(JSON.stringify({
          dbA: getSessionDBPath(opts, backslashProject),
          dbB: getSessionDBPath(opts, slashProject),
          eventsA: getSessionEventsPath(opts, backslashProject),
          eventsB: getSessionEventsPath(opts, slashProject),
          cleanupA: getCleanupFlagPath(opts, backslashProject),
          cleanupB: getCleanupFlagPath(opts, slashProject),
        }));
      `;
      const r = spawnSync("node", ["--input-type=module", "-e", code], {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: customDir, CONTEXT_MODE_SESSION_SUFFIX: "" },
        timeout: 10000,
      });
      expect(r.status).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(basename(result.dbA)).toBe(basename(result.dbB));
      expect(basename(result.eventsA)).toBe(basename(result.eventsB));
      expect(basename(result.cleanupA)).toBe(basename(result.cleanupB));
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════
// parseStdin — safe JSON parse for empty/malformed stdin (#322)
// ═══════════════════════════════════════════════════════════════════════

describe("parseStdin (#322)", () => {
  const HELPERS_PATH = join(__dirname, "..", "..", "hooks", "session-helpers.mjs");

  function runParseTest(raw: string): { parsed: boolean; result: unknown; error?: string } {
    const code = `
      const { parseStdin } = await import(${JSON.stringify(pathToFileURL(HELPERS_PATH).href)});
      try {
        const result = parseStdin(${JSON.stringify(raw)});
        process.stdout.write(JSON.stringify({ parsed: true, result }));
      } catch(e) {
        process.stdout.write(JSON.stringify({ parsed: false, error: e.message }));
      }
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return JSON.parse(r.stdout);
  }

  test("empty string returns empty object", () => {
    expect(runParseTest("").result).toEqual({});
  });

  test("whitespace-only returns empty object", () => {
    expect(runParseTest("   \n  ").result).toEqual({});
  });

  test("BOM-only returns empty object", () => {
    expect(runParseTest("\uFEFF").result).toEqual({});
  });

  test("valid JSON parsed correctly", () => {
    expect(runParseTest('{"source":"startup"}').result).toEqual({ source: "startup" });
  });

  test("BOM-prefixed JSON parsed correctly", () => {
    expect(runParseTest('\uFEFF{"source":"compact"}').result).toEqual({ source: "compact" });
  });

  test("malformed JSON throws", () => {
    const out = runParseTest("{broken");
    expect(out.parsed).toBe(false);
  });
});


describe("empty stdin resilience (#322)", () => {
  const PROJECT_ROOT = join(__dirname, "..", "..");

  function runHookWithEmptyStdin(hookPath: string): { exitCode: number } {
    const fakeHome = mkdtempSync(join(tmpdir(), "ctx-empty-stdin-"));
    const fakeProject = mkdtempSync(join(tmpdir(), "ctx-empty-project-"));
    try {
      const r = spawnSync("node", [join(PROJECT_ROOT, "hooks", hookPath)], {
        input: "",
        encoding: "utf-8",
        timeout: 15000,
        env: {
          ...process.env,
          HOME: fakeHome,
          CLAUDE_PROJECT_DIR: fakeProject,
          GEMINI_PROJECT_DIR: fakeProject,
          VSCODE_CWD: fakeProject,
          CURSOR_CWD: fakeProject,
          CONTEXT_MODE_SESSION_SUFFIX: "",
        },
      });
      return { exitCode: r.status ?? -1 };
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(fakeProject, { recursive: true, force: true });
    }
  }

  // All 6 adapters × their hook files
  const hooks = [
    "sessionstart.mjs", "precompact.mjs", "posttooluse.mjs", "userpromptsubmit.mjs",
    "gemini-cli/sessionstart.mjs", "gemini-cli/beforetool.mjs", "gemini-cli/aftertool.mjs", "gemini-cli/precompress.mjs",
    "vscode-copilot/sessionstart.mjs", "vscode-copilot/pretooluse.mjs", "vscode-copilot/posttooluse.mjs", "vscode-copilot/precompact.mjs",
    "cursor/sessionstart.mjs", "cursor/pretooluse.mjs", "cursor/posttooluse.mjs", "cursor/stop.mjs",
    "codex/sessionstart.mjs", "codex/pretooluse.mjs", "codex/posttooluse.mjs",
    "kiro/pretooluse.mjs", "kiro/posttooluse.mjs",
  ];

  for (const hook of hooks) {
    test(`${hook} exits 0 on empty stdin`, () => {
      expect(runHookWithEmptyStdin(hook).exitCode).toBe(0);
    });
  }
});
