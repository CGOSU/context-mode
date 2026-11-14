#!/usr/bin/env node
/**
 * context-mode CLI (Pi-focused)
 *
 * Usage:
 *   context-mode                         → Start MCP server (stdio)
 *   context-mode index <path>            → Index a file or directory into FTS5
 *   context-mode search <query...>       → Search the project's FTS5 knowledge base
 *   context-mode doctor                  → Diagnose runtime issues, FTS5, Pi integration
 *   context-mode upgrade                 → Upgrade local checkout/extension
 *   context-mode insight                 → Open hosted Insight dashboard
 */

import * as p from "@clack/prompts";
import color from "picocolors";

import { indexCommand, searchCommand } from "./cli-knowledge.js";
import { doctor } from "./cli-doctor.js";
import { insight } from "./cli-insight.js";
import { upgrade } from "./cli-upgrade.js";
export { toUnixPath, npmExecFile, npmExec, openInBrowser, type ExecFileFn } from "./cli-shared.js";

const args = process.argv.slice(2);

function printHelp(): void {
  console.log([
    "Usage:",
    "  context-mode                         Start MCP server (stdio)",
    "  context-mode index <path>            Index a file or directory into the FTS5 knowledge base",
    "  context-mode search <query...>       Search the current project's FTS5 knowledge base",
    "  context-mode doctor                  Diagnose runtime issues, FTS5, Pi extension",
    "  context-mode upgrade                 Upgrade local package and verify SQLite/runtimes",
    "  context-mode insight                 Open Insight dashboard in browser",
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
  upgrade().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(color.red(message));
    process.exit(1);
  });
} else if (args[0] === "insight") {
  insight();
} else {
  // Default: start MCP server
  import("./server.js");
}
