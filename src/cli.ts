#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode                              → Start MCP server (stdio)
 *   context-mode doctor                       → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode upgrade                      → Fix hooks, permissions, and settings
 *   context-mode hook <platform> <event>      → Dispatch a hook script (used by platform hook configs)
 *   CONTEXT_MODE_DIR=/abs/path context-mode   → Override sessions/content storage root
 *     Empty/whitespace is ignored; non-empty values must be absolute.
 *
 * Platform auto-detection: CLI detects which platform is running
 * (Claude Code, Gemini CLI, OpenCode, etc.) and uses the appropriate adapter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";

import { hookDispatch } from "./cli-hooks.js";
import { indexCommand, searchCommand } from "./cli-knowledge.js";
import { doctor } from "./cli-doctor.js";
import { insight } from "./cli-insight.js";
import { upgrade } from "./cli-upgrade.js";
import { statuslineForward } from "./cli-statusline.js";
export { toUnixPath, npmExecFile, npmExec, openInBrowser, type ExecFileFn } from "./cli-shared.js";

/* -------------------------------------------------------
 * Entry point
 * ------------------------------------------------------- */

const args = process.argv.slice(2);

function printHelp(): void {
  console.log([
    "Usage:",
    "  context-mode                         Start MCP server (stdio)",
    "  context-mode index <path>            Index a file or directory into the FTS5 knowledge base",
    "  context-mode search <query...>       Search the current project's FTS5 knowledge base",
    "  context-mode doctor                  Diagnose runtime issues, hooks, FTS5, version",
    "  context-mode upgrade                 Fix hooks, permissions, and settings",
    "  context-mode hook <platform> <event> Dispatch a configured hook script",
    "  context-mode statusline              Print Claude Code status line",
    "",
    "Index options:",
    "  --source <label>                     Source label (default: project:<directory-name> or path)",
    "  --project <path>                     Project identity for the content DB (default: indexed dir or cwd)",
    "  --max-depth <n>                      Directory recursion depth (default: 5)",
    "  --max-files <n>                      Directory file cap (default: 200)",
    "  --ext <.ts,.md>                      Comma-separated extension allowlist",
    "  --include <glob>                     Directory include pattern (repeatable)",
    "  --exclude <glob>                     Directory exclude pattern (repeatable)",
    "  --no-gitignore                       Do not apply .gitignore during directory walks",
    "  --follow-symlinks                    Follow directory symlinks inside the root",
    "",
    "Search options:",
    "  --project <path>                     Project identity for the content DB (default: cwd)",
    "  --source <label>                     Filter to a source label (partial match)",
    "  --limit <n>                          Results to show (default: 3)",
    "  --type <code|prose>                  Filter by content type",
    "",
    "Environment:",
    "  CONTEXT_MODE_DIR=/absolute/path      Override sessions/content storage root; empty is ignored, non-empty must be absolute",
  ].join("\n"));
}

if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
  printHelp();
} else if (args[0] === "index") {
  indexCommand(args.slice(1)).then((code) => process.exit(code));
} else if (args[0] === "search") {
  searchCommand(args.slice(1)).then((code) => process.exit(code));
} else if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "upgrade") {
  // Issue #542 — accept --platform <id> from the ctx_upgrade MCP handler,
  // which forwards the live MCP clientInfo's resolved PlatformId. The flag
  // wins over upgrade()'s own detectPlatform() heuristic chain so an
  // ambiguous config-dir collision (e.g. ~/.cursor + ~/.pi both present)
  // can never misroute the upgrade.
  const platformFlagIdx = args.indexOf("--platform");
  const platformArg =
    platformFlagIdx >= 0 && args[platformFlagIdx + 1]
      ? args[platformFlagIdx + 1]
      : undefined;
  upgrade(platformArg ? { platform: platformArg } : undefined).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(color.red(message));
    process.exit(1);
  });
} else if (args[0] === "hook") {
  hookDispatch(args[1], args[2]);
} else if (args[0] === "insight") {
  insight();
} else if (args[0] === "statusline") {
  // Status line implementation lives in bin/statusline.mjs to keep it
  // dependency-free and fast. Forward stdin and exit with its result.
  statuslineForward();
} else {
  // Default: start MCP server
  import("./server.js");
}
