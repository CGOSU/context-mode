import { existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { hasBunRuntime } from "./runtime.js";
import { describeStorageDirectorySource, resolveContentStorageDir, resolveSessionStorageDir, resolveStatsStorageDir } from "./session/db.js";
import { buildNodeCommand, type PlatformId, isInProcessPluginPlatform } from "./adapters/types.js";
import { detectPlatform } from "./adapters/detect.js";
import { getHookScriptPaths } from "./util/hook-config.js";
import { loadDatabase } from "./db-base.js";
import { killProcessOnPort, openBrowserSync } from "./server-browser.js";
import type { ServerToolContext } from "./server.js";


// ── ctx-insight: open the hosted Insight dashboard ───────────────────────────
// Insight pivoted from a locally-built dashboard to the hosted B2B product at
// context-mode.com/insight (the landing page is the single source of truth).
// The tool now simply opens that URL in the user default browser via the same
// cross-platform helper (openBrowserSync) used elsewhere.
const INSIGHT_URL = "https://context-mode.com/insight";

export function registerMaintenanceTools(context: ServerToolContext): void {
  const { server, getRuntimeAwarePackageRoot, available, getDefaultSessionDir, getDiagnosticAdapter, VERSION, trackResponse, runtimes, getSessionDir } = context;


// ── ctx-doctor: diagnostics (server-side) ─────────────────────────────────
server.registerTool(
  "ctx_doctor",
  {
    title: "Run Diagnostics",
    // #846: read-only diagnostics (runs an internal self-test, mutates nothing).
    // Was cancelled by Codex when unannotated.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Diagnose context-mode installation. Runs all checks server-side and " +
      "returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes " +
      "(renderer-safe across MCP clients). No CLI execution needed.",
    inputSchema: z.object({}),
  },
  async () => {
    // Renderer-safe output (Mickey #3 — Z.ai GLM 4.7 ReferenceError):
    // Z.ai's MCP renderer mounts a custom React component for GitHub-flavored
    // markdown task-list syntax (`- [x]` / `- [ ]` / `- [-]`) that depends on
    // a missing `client` context, throwing `ReferenceError: client is not
    // defined`. We avoid both task-list syntax AND `## ` h2 headings to stay
    // safe across all MCP renderers — using plain-text status prefixes
    // (`[OK]` / `[FAIL]` / `[WARN]`) instead.
    const lines: string[] = ["context-mode doctor", ""];
    let currentPlatform: PlatformId | undefined;
    try {
      currentPlatform = detectPlatform(server.server.getClientVersion() ?? undefined).platform;
    } catch {
      currentPlatform = detectPlatform().platform;
    }
    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
    // Codex is special: when plugin-manager runtime root differs from the
    // current package root, diagnose the root Codex will actually execute.
    const pluginRoot = getRuntimeAwarePackageRoot(currentPlatform);

    // Runtimes
    const total = 11;
    const pct = ((available.length / total) * 100).toFixed(0);
    lines.push(`[OK] Runtimes: ${available.length}/${total} (${pct}%) — ${available.join(", ")}`);

    // Performance
    if (hasBunRuntime()) {
      lines.push("[OK] Performance: FAST (Bun)");
    } else {
      lines.push("[WARN] Performance: NORMAL — install Bun for 3-5x speed boost");
    }

    const sessionStorage = resolveSessionStorageDir(getDefaultSessionDir);
    const contentStorage = resolveContentStorageDir(getDefaultSessionDir);
    const statsStorage = resolveStatsStorageDir(getDefaultSessionDir);
    lines.push(`[OK] Storage sessions: ${sessionStorage.path} (${describeStorageDirectorySource(sessionStorage)})`);
    lines.push(`[OK] Storage content: ${contentStorage.path} (${describeStorageDirectorySource(contentStorage)})`);
    lines.push(`[OK] Storage stats: ${statsStorage.path} (${describeStorageDirectorySource(statsStorage)})`);

    // Server test — cleanup executor to prevent resource leaks (#247)
    {
      const testExecutor = new PolyglotExecutor({ runtimes });
      try {
        const result = await testExecutor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
        if (result.exitCode === 0 && result.stdout.trim() === "ok") {
          lines.push("[OK] Server test: PASS");
        } else {
          const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
          lines.push(`[FAIL] Server test: FAIL — exit ${result.exitCode}${detail}`);
        }
      } catch (err: unknown) {
        lines.push(`[FAIL] Server test: FAIL — ${err instanceof Error ? err.message : err}`);
      } finally {
        testExecutor.cleanupBackgrounded();
      }
    }

    // FTS5 / SQLite — close in finally to prevent GC segfault (#247)
    {
      let testDb: ReturnType<typeof loadDatabase> extends (...args: any[]) => infer R ? R : never;
      try {
        const Database = loadDatabase();
        testDb = new Database(":memory:");
        testDb.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
        testDb.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
        const row = testDb.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
        if (row && row.content === "hello world") {
          lines.push("[OK] FTS5 / SQLite: PASS — native module works");
        } else {
          lines.push("[FAIL] FTS5 / SQLite: FAIL — unexpected result");
        }
      } catch (err: unknown) {
        lines.push(`[FAIL] FTS5 / SQLite: FAIL — ${err instanceof Error ? err.message : err}`);
      } finally {
        try { testDb!?.close(); } catch { /* best effort */ }
      }
    }

    // Hooks
    const diagnosticAdapter = await getDiagnosticAdapter();
    if (diagnosticAdapter) {
      for (const result of diagnosticAdapter.validateHooks(pluginRoot)) {
        const prefix = result.status === "pass" ? "[OK]" : result.status === "warn" ? "[WARN]" : "[FAIL]";
        const fix = result.fix ? ` — fix: ${result.fix}` : "";
        lines.push(`${prefix} ${result.check}: ${result.message}${fix}`);
      }

      const hookScriptPaths = getHookScriptPaths(diagnosticAdapter, pluginRoot);
      if (hookScriptPaths.length === 0) {
        lines.push("[OK] Hook scripts: no direct .mjs script paths to verify");
      }
      for (const scriptPath of hookScriptPaths) {
        const hookPath = resolve(pluginRoot, scriptPath);
        if (existsSync(hookPath)) {
          lines.push(`[OK] Hook script: PASS — ${hookPath}`);
        } else {
          lines.push(`[FAIL] Hook script: FAIL — not found at ${hookPath}`);
        }
      }
    } else {
      lines.push("[WARN] Hooks: adapter detection unavailable");
    }

    // Version
    lines.push(`[OK] Version: v${VERSION}`);

    return trackResponse("ctx_doctor", {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    });
  },
);


// ── ctx-upgrade: upgrade meta-tool ─────────────────────────────────────────
server.registerTool(
  "ctx_upgrade",
  {
    title: "Upgrade Plugin",
    // #846: an action tool (returns an upgrade command to run); not read-only,
    // but non-destructive and idempotent. No direct network from the call.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Upgrade context-mode to the latest version. Returns a shell command to execute. " +
      "You MUST run the returned command using your shell tool (Bash, shell_execute, " +
      "run_in_terminal, etc.) and display the output as a checklist. " +
      "Tell the user to restart their session after upgrade.",
    inputSchema: z.object({}),
  },
  async () => {
    // Issue #542 — thread MCP clientInfo into the spawned upgrade
    // process. detectPlatform() runs IN-PROCESS here (no spawn boundary)
    // so clientInfo from the MCP handshake is the highest-confidence
    // signal available. We forward the resolved PlatformId as a
    // --platform flag (cross-shell safe on POSIX, Git Bash, PowerShell,
    // and cmd.exe — unlike env-var prefixes). If detection fails we
    // skip the flag and let upgrade()'s own detectPlatform() fall back.
    let platformFlag = "";
    let nodeOpts: { platform: string; jsRuntime: string } | undefined =
      undefined;
    let platformId: PlatformId | undefined;
    try {
      const clientInfo = server.server.getClientVersion();
      const signal = detectPlatform(clientInfo ?? undefined);
      platformId = signal.platform;
      platformFlag = ` --platform ${signal.platform}`;
      nodeOpts = isInProcessPluginPlatform(signal.platform) && runtimes.javascript
        ? { platform: signal.platform, jsRuntime: runtimes.javascript }
        : undefined;
    } catch {
      try { platformId = detectPlatform().platform; } catch { /* best effort — fall back to upgrade()'s own detect */ }
    }

    // __pkg_dir is build/ for tsc, plugin root for bundle — resolve to plugin root.
    // Only Codex may replace it with the plugin-manager runtime root; other
    // adapters can coexist with Codex on the same machine.
    const pluginRoot = getRuntimeAwarePackageRoot(platformId);
    const bundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const fallbackPath = resolve(pluginRoot, "build", "cli.js");

    // Insight pivoted to the hosted dashboard (context-mode.com/insight), so
    // ctx_insight no longer builds a local cache. On upgrade, sweep the legacy
    // insight-cache and stop any stale local dashboard left from old versions.
    try {
      const sessDir = getSessionDir();
      const insightCacheDir = join(dirname(sessDir), "insight-cache");
      if (existsSync(insightCacheDir)) {
        // Kill any running insight server first via the shared helper —
        // this is locale-independent on Windows (PR #469) and isolates per-pid
        // failures. We ignore the structured result: cache cleanup is
        // best-effort and must never block ctx_upgrade.
        killProcessOnPort(4747);
        rmSync(insightCacheDir, { recursive: true, force: true });
      }
    } catch { /* best effort — don't block upgrade */ }


    let cmd: string;

    if (existsSync(bundlePath)) {
      cmd = `${buildNodeCommand(bundlePath, nodeOpts)} upgrade${platformFlag}`;
    } else if (existsSync(fallbackPath)) {
      cmd = `${buildNodeCommand(fallbackPath, nodeOpts)} upgrade${platformFlag}`;
    } else {
      // Inline fallback: neither CLI file exists (e.g. marketplace installs).
      // Generate a self-contained node -e script that performs the upgrade.
      const repoUrl = "https://github.com/mksglu/context-mode.git";
      // Write inline script to a temp .mjs file — avoids quote-escaping issues
      // across cmd.exe, PowerShell, and bash (node -e '...' breaks on Windows).
      const scriptLines = [
        `import{execFileSync}from"node:child_process";`,
        `import{cpSync,rmSync,existsSync,mkdtempSync,readFileSync,writeFileSync,lstatSync}from"node:fs";`,
        `import{join,resolve,sep}from"node:path";`,
        `import{tmpdir}from"node:os";`,
        `const P=${JSON.stringify(pluginRoot)};`,
        `const T=mkdtempSync(join(tmpdir(),"ctx-upgrade-"));`,
        `try{`,
        `console.log("- [x] Starting inline upgrade (no CLI found)");`,
        `execFileSync("git",["clone","--depth","1","${repoUrl}",T],{stdio:"inherit"});`,
        `console.log("- [x] Cloned latest source");`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["run","build"],{cwd:T,stdio:"inherit",shell:process.platform==="win32"});`,
        `console.log("- [x] Built from source");`,
        `const pkg=JSON.parse(readFileSync(join(T,"package.json"),"utf8"));`,
        `const items=[...(Array.isArray(pkg.files)?pkg.files:[]),"src","package.json"];`,
        // Supply-chain containment on items[]. Mirror the cli.ts upgrade()
        // guard: a compromised upstream package.json with files:["../etc"]
        // would otherwise let path.join follow ".." out of pluginRoot.
        // path.resolve normalizes "..", so the lexical startsWith catches
        // both relative-".." traversal and absolute-path bypass. Plus a
        // symlink filter so a committed symlink inside the clone can't
        // plant itself in pluginRoot (cpSync default preserves source
        // symlinks; a planted symlink in pluginRoot/src then redirects
        // every subsequent load through to an attacker target).
        `const PW=resolve(P)+sep;const TW=resolve(T)+sep;`,
        `const noSymlink=(src)=>{try{return !lstatSync(src).isSymbolicLink()}catch{return false}};`,
        `for(const item of items){const from=resolve(T,item);const to=resolve(P,item);if(!(to+sep).startsWith(PW))continue;if(!(from+sep).startsWith(TW))continue;if(!noSymlink(from))continue;if(existsSync(from)){rmSync(to,{recursive:true,force:true});cpSync(from,to,{recursive:true,force:true,filter:noSymlink});}}`,
        // Issue #609: do NOT write .mcp.json into the cache dir. Claude Code reads
        // .claude-plugin/plugin.json.mcpServers as the canonical MCP source — the
        // per-version .mcp.json file is a stale-write vector. Same architectural
        // fix as the cli.ts upgrade() path; both writers were the only producers.
        `console.log("- [x] Copied package files");`,
        `execFileSync(process.platform==="win32"?"npm.cmd":"npm",["install","--production"],{cwd:P,stdio:"inherit",shell:process.platform==="win32"});`,
        `console.log("- [x] Installed production dependencies");`,
        `console.log("## context-mode upgrade complete");`,
        `}catch(e){`,
        `console.error("- [ ] Upgrade failed:",e.message);`,
        `process.exit(1);`,
        `}finally{`,
        `try{rmSync(T,{recursive:true,force:true})}catch{}`,
        `}`,
      ].join("\n");

      // Server writes the temp script file — avoids shell quoting issues entirely
      const tmpScript = resolve(pluginRoot, ".ctx-upgrade-inline.mjs");
      const { writeFileSync: writeTmp } = await import("node:fs");
      writeTmp(tmpScript, scriptLines);
      cmd = buildNodeCommand(tmpScript, nodeOpts);
    }

    const text = [
      "## ctx-upgrade",
      "",
      "Run this command using your shell execution tool:",
      "",
      "```",
      cmd,
      "```",
      "",
      "After the command completes, display results as a markdown checklist:",
      "- `[x]` for success, `[ ]` for failure",
      "- Example format:",
      "  ```",
      "  ## context-mode upgrade",
      "  - [x] Pulled latest from GitHub",
      "  - [x] Built and installed v0.9.24",
      "  - [x] npm global updated",
      "  - [x] Hooks configured",
      "  - [x] Doctor: all checks PASS",
      "  ```",
      "- Tell the user to restart their session to pick up the new version.",
    ].join("\n");

    return trackResponse("ctx_upgrade", {
      content: [{ type: "text" as const, text }],
    });
  },
);

}

export function registerInsightTool(context: ServerToolContext): void {
  const { server, trackResponse } = context;

server.registerTool(
  "ctx_insight",
  {
    title: "Open Insight Dashboard",
    // #846: opens a hosted dashboard URL in the browser — an external side
    // effect (open world), not a read-only query; safe to repeat.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "Opens the context-mode Insight dashboard (https://context-mode.com/insight) in your " +
      "default browser — a dashboard launcher for the hosted analytics layer, not a Q&A engine. " +
      "Insight surfaces per-engineer productive rate, retry waste, blocker detection, and " +
      "role-narrowed views for CTO, EM, IC, CISO, FinOps, and DevOps. " +
      "For natural-language queries over your indexed content, use ctx_search.",
    inputSchema: z.object({}),
  },
  async () => {
    const open = openBrowserSync(INSIGHT_URL);
    const text = open.ok
      ? `Opening Insight in your browser: ${INSIGHT_URL}`
      : `Could not auto-open your browser (${open.reason}).\nOpen Insight manually: ${INSIGHT_URL}`;
    return trackResponse("ctx_insight", {
      content: [{ type: "text" as const, text }],
    });
  },
);
}
