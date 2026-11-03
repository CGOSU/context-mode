/** CLI hooks implementation; importing this module never dispatches commands. */

import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { devNull } from "node:os";
import { pathToFileURL } from "node:url";
import { getPluginRoot } from "./cli-shared.js";


/* -------------------------------------------------------
 * Hook dispatcher — `context-mode hook <platform> <event>`
 * ------------------------------------------------------- */

const HOOK_MAP: Record<string, Record<string, string>> = {
  "claude-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
    stop: "hooks/stop.mjs",
  },
  "gemini-cli": {
    beforeagent: "hooks/gemini-cli/beforeagent.mjs",
    beforetool: "hooks/gemini-cli/beforetool.mjs",
    aftertool: "hooks/gemini-cli/aftertool.mjs",
    precompress: "hooks/gemini-cli/precompress.mjs",
    sessionstart: "hooks/gemini-cli/sessionstart.mjs",
  },
  "vscode-copilot": {
    pretooluse: "hooks/vscode-copilot/pretooluse.mjs",
    posttooluse: "hooks/vscode-copilot/posttooluse.mjs",
    precompact: "hooks/vscode-copilot/precompact.mjs",
    sessionstart: "hooks/vscode-copilot/sessionstart.mjs",
  },
  "cursor": {
    pretooluse: "hooks/cursor/pretooluse.mjs",
    posttooluse: "hooks/cursor/posttooluse.mjs",
    sessionstart: "hooks/cursor/sessionstart.mjs",
    stop: "hooks/cursor/stop.mjs",
    afteragentresponse: "hooks/cursor/afteragentresponse.mjs",
  },
  "codex": {
    pretooluse: "hooks/codex/pretooluse.mjs",
    posttooluse: "hooks/codex/posttooluse.mjs",
    precompact: "hooks/codex/precompact.mjs",
    sessionstart: "hooks/codex/sessionstart.mjs",
    userpromptsubmit: "hooks/codex/userpromptsubmit.mjs",
    stop: "hooks/codex/stop.mjs",
  },
  "kiro": {
    pretooluse: "hooks/kiro/pretooluse.mjs",
    posttooluse: "hooks/kiro/posttooluse.mjs",
  },
  "jetbrains-copilot": {
    pretooluse: "hooks/jetbrains-copilot/pretooluse.mjs",
    posttooluse: "hooks/jetbrains-copilot/posttooluse.mjs",
    precompact: "hooks/jetbrains-copilot/precompact.mjs",
    sessionstart: "hooks/jetbrains-copilot/sessionstart.mjs",
  },
  "copilot-cli": {
    pretooluse: "hooks/copilot-cli/pretooluse.mjs",
    posttooluse: "hooks/copilot-cli/posttooluse.mjs",
    precompact: "hooks/copilot-cli/precompact.mjs",
    sessionstart: "hooks/copilot-cli/sessionstart.mjs",
    userpromptsubmit: "hooks/copilot-cli/userpromptsubmit.mjs",
    stop: "hooks/copilot-cli/stop.mjs",
  },
  // Antigravity CLI (`agy`) — bounded PreToolUse enforcement plus capture-only
  // PostToolUse/Stop hooks. Configured via an installed agy plugin's
  // hooks/hooks.json or ~/.gemini/config/hooks.json.
  "antigravity-cli": {
    pretooluse: "hooks/antigravity-cli/pretooluse.mjs",
    posttooluse: "hooks/antigravity-cli/posttooluse.mjs",
    stop: "hooks/antigravity-cli/stop.mjs",
  },
  "kimi": {
    pretooluse: "hooks/kimi/pretooluse.mjs",
    posttooluse: "hooks/kimi/posttooluse.mjs",
    precompact: "hooks/kimi/precompact.mjs",
    sessionstart: "hooks/kimi/sessionstart.mjs",
    sessionend: "hooks/kimi/sessionend.mjs",
    userpromptsubmit: "hooks/kimi/userpromptsubmit.mjs",
    stop: "hooks/kimi/stop.mjs",
  },
  "qwen-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
};

async function hookDispatch(platform: string, event: string): Promise<void> {
  // Suppress stderr at OS fd level — native C++ modules (better-sqlite3) write
  // directly to fd 2 during initialization, bypassing Node.js process.stderr.
  // Platforms like Claude Code interpret ANY stderr output as hook failure.
  // Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows). See: #68
  try {
    closeSync(2);
    openSync(devNull, "w"); // Acquires fd 2 (lowest available)
  } catch {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }

  const scriptPath = HOOK_MAP[platform]?.[event];
  if (!scriptPath) {
    // Fail OPEN. context-mode has no hook for this platform/event — most often
    // because a newer adapter's hook command (`context-mode hook copilot-cli …`)
    // is running against an OLDER global binary that predates that adapter
    // (version skew). Exit 0 (no decision) so the host ALLOWS the tool. Exiting
    // non-zero here makes some hosts treat it as a hook ERROR and DENY the tool:
    // verified against GitHub Copilot CLI 1.0.59, where an exit-1 + empty-stdout
    // PreToolUse hook blocks EVERY tool ("Denied by preToolUse hook (hook
    // errored)") — bricking the agent during a skew instead of just disabling
    // context-mode's instrumentation.
    process.exit(0);
  }
  const pluginRoot = getPluginRoot();
  await import(pathToFileURL(join(pluginRoot, scriptPath)).href);
}

export { hookDispatch };
