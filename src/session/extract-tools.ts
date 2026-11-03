import type { HookInput, SessionEvent } from "./extract-types.js";
import { isToolError, safeString, safeStringAny } from "./extract-common.js";
import { extractAgentUsage } from "./extract-usage.js";
import { extractErrorResolution, extractIterationLoop } from "./extract-tool-state.js";

interface ApplyPatchTarget {
  path: string;
  type: "file_write" | "file_edit";
}

function extractApplyPatchTargets(command: string): ApplyPatchTarget[] {
  if (!command) return [];

  const targets: ApplyPatchTarget[] = [];
  for (const line of command.split(/\r?\n/)) {
    if (line.startsWith("*** Add File: ")) {
      targets.push({ path: line.slice(14).trim(), type: "file_write" });
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      targets.push({ path: line.slice(17).trim(), type: "file_edit" });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      targets.push({ path: line.slice(17).trim(), type: "file_edit" });
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      targets.push({ path: line.slice(13).trim(), type: "file_edit" });
    }
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    if (!target.path) return false;
    const key = `${target.type}:${target.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPlanFilePath(filePath: string): boolean {
  return /(?:^|[/\\])\.claude[/\\]plans[/\\]/.test(filePath);
}

// ── Category extractors ────────────────────────────────────────────────────

/**
 * Category 1 & 2: rule + file
 *
 * CLAUDE.md / .claude/ reads → emit both a "rule" event (priority 1) AND a
 * "file_read" event (priority 1) because the file is being actively accessed.
 *
 * Other Edit/Write/Read tool calls → emit a file_edit / file_write / file_read
 * event (priority 1).
 */
function extractFileAndRule(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  const events: SessionEvent[] = [];

  if (tool_name === "Read") {
    const filePath = String(tool_input["file_path"] ?? "");

    // Rule detection — covers every supported platform's instruction
    // file convention plus per-user memory directories. Hardcoding here
    // (instead of dispatching through the adapter) keeps extract.ts
    // pure / sync / hot-path-safe — the tradeoff is that adding a new
    // platform requires updating this regex.
    //
    //   Filenames: CLAUDE.md, AGENTS.md, AGENTS.override.md, GEMINI.md,
    //              QWEN.md, KIRO.md, copilot-instructions.md,
    //              context-mode.mdc
    //   Directories: .claude/, .codex/memories/, .qwen/memory/,
    //                .gemini/memory/, .config/<plat>/memory/, .cursor/memory/,
    //                .github/memory/, .kiro/memory/, etc.
    const isRuleFile =
      /(?:CLAUDE|AGENTS(?:\.override)?|GEMINI|QWEN|KIRO)\.md$/i.test(filePath)
      || /\/copilot-instructions\.md$/i.test(filePath)
      || /\/context-mode\.mdc$/i.test(filePath)
      || /\.claude[\\/]/i.test(filePath)
      || /[\\/]memor(?:y|ies)[\\/][^\\/]+\.md$/i.test(filePath);
    if (isRuleFile) {
      events.push({
        type: "rule",
        category: "rule",
        data: safeString(filePath),
        priority: 1,
      });

      // Capture rule content so it survives context compaction
      if (tool_response && tool_response.length > 0) {
        events.push({
          type: "rule_content",
          category: "rule",
          data: safeString(tool_response),
          priority: 1,
        });
      }
    }

    // Always emit file_read for any Read call
    events.push({
      type: "file_read",
      category: "file",
      data: safeString(filePath),
      priority: 1,
    });

    return events;
  }

  if (tool_name === "Edit") {
    const filePath = String(tool_input["file_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: safeString(filePath),
      priority: 1,
    });
    return events;
  }

  if (tool_name === "NotebookEdit") {
    const notebookPath = String(tool_input["notebook_path"] ?? "");
    events.push({
      type: "file_edit",
      category: "file",
      data: safeString(notebookPath),
      priority: 1,
    });
    return events;
  }

  if (tool_name === "Write") {
    const filePath = String(tool_input["file_path"] ?? "");
    events.push({
      type: "file_write",
      category: "file",
      data: safeString(filePath),
      priority: 1,
    });
    return events;
  }

  if (tool_name === "apply_patch") {
    if (isToolError(input)) return [];
    const patchTargets = extractApplyPatchTargets(
      String(tool_input["command"] ?? tool_input["patch"] ?? ""),
    );
    for (const target of patchTargets) {
      events.push({
        type: target.type,
        category: "file",
        data: safeString(target.path),
        priority: 1,
      });
    }
    return events;
  }

  // Glob — file pattern exploration
  if (tool_name === "Glob") {
    const pattern = String(tool_input["pattern"] ?? "");
    events.push({
      type: "file_glob",
      category: "file",
      data: safeString(pattern),
      priority: 3,
    });
    return events;
  }

  // Grep — code search
  if (tool_name === "Grep") {
    const searchPattern = String(tool_input["pattern"] ?? "");
    const searchPath = String(tool_input["path"] ?? "");
    events.push({
      type: "file_search",
      category: "file",
      data: safeString(`${searchPattern} in ${searchPath}`),
      priority: 3,
    });
    return events;
  }

  return events;
}

/**
 * Category 4: cwd
 * Matches the first `cd <path>` in a Bash command (handles quoted paths).
 */
function extractCwd(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  // Match: cd "path" | cd 'path' | cd path
  const cdMatch = cmd.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!cdMatch) return [];

  const dir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4] ?? "";
  return [{
    type: "cwd",
    category: "cwd",
    data: safeString(dir),
    priority: 2,
  }];
}

/**
 * Category 5: error
 * Detects failures from bash exit codes / error patterns, or an explicit
 * isError flag in tool_output.
 */
function extractError(input: HookInput): SessionEvent[] {
  const { tool_response } = input;
  const response = String(tool_response ?? "");
  if (!isToolError(input)) return [];

  return [{
    type: "error_tool",
    category: "error",
    data: safeString(response),
    priority: 2,
  }];
}

/**
 * Category 11: git
 * Matches common git operations from Bash commands.
 */

const GIT_PATTERNS: Array<{ pattern: RegExp; operation: string }> = [
  { pattern: /\bgit\s+checkout\b/, operation: "branch" },
  { pattern: /\bgit\s+commit\b/, operation: "commit" },
  { pattern: /\bgit\s+merge\s+\S+/, operation: "merge" },
  { pattern: /\bgit\s+rebase\b/, operation: "rebase" },
  { pattern: /\bgit\s+stash\b/, operation: "stash" },
  { pattern: /\bgit\s+push\b/, operation: "push" },
  { pattern: /\bgit\s+pull\b/, operation: "pull" },
  { pattern: /\bgit\s+log\b/, operation: "log" },
  { pattern: /\bgit\s+diff\b/, operation: "diff" },
  { pattern: /\bgit\s+status\b/, operation: "status" },
  { pattern: /\bgit\s+branch\b/, operation: "branch" },
  { pattern: /\bgit\s+reset\b/, operation: "reset" },
  { pattern: /\bgit\s+add\b/, operation: "add" },
  { pattern: /\bgit\s+cherry-pick\b/, operation: "cherry-pick" },
  { pattern: /\bgit\s+tag\b/, operation: "tag" },
  { pattern: /\bgit\s+fetch\b/, operation: "fetch" },
  { pattern: /\bgit\s+clone\b/, operation: "clone" },
  { pattern: /\bgit\s+worktree\b/, operation: "worktree" },
];

function extractGit(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");

  // Bug 8 (v1.0.162) — parse the git invocation algorithmically so flags
  // between `git` and the operation token are tolerated (`git -C /path
  // status`, `git --no-pager log`, etc.). Falls back to the legacy regex
  // pattern scan when the algorithmic parse cannot locate a `git` token —
  // preserves backward compat for commands like `cd /repo && git status`
  // where the algorithmic parse sees `cd` as the first token instead.
  const parsed = parseGitInvocation(cmd);
  let match: { pattern: RegExp; operation: string } | undefined;
  if (parsed && parsed.operation) {
    match = GIT_PATTERNS.find(p => p.operation === parsed.operation);
  }
  if (!match) {
    match = GIT_PATTERNS.find(p => p.pattern.test(cmd));
  }
  if (!match) return [];

  // Bug 1 (v1.0.161) — for `git commit` operations, parse -m / -am / --message=
  // from the Bash command via shell-like argv tokenization so downstream
  // consumers receive the actual commit subject in `data`. Falls back to the
  // operation name when no message argument is present (--amend / --no-edit /
  // -F file / interactive editor flow). Tokenizer is hand-rolled char-by-char
  // (no regex) to mirror real shell quoting/cluster-flag semantics.
  //
  // When a message is captured, the event surfaces as type='git_commit' so the
  // rollup aggregator can distinguish ACTUAL commits from other git operations
  // (status/diff/log were inflating has_commit on every event — see
  // session-loaders.mjs rollup stamp + Bug 2).
  // Bug 8 cwd hint — when `-C <dir>` is present in the git invocation, emit
  // a leading cwd event so the attribution carry-forward (LAST_SEEN source)
  // routes downstream events in the same batch to the scoped directory's
  // project. Without the hint, `git -C /projB status` while cwd=/projA
  // misattributes to /projA.
  const out: SessionEvent[] = [];
  if (parsed?.scopedDir) {
    out.push({
      type: "cwd",
      category: "cwd",
      data: safeString(parsed.scopedDir),
      priority: 2,
    });
  }

  if (match.operation === "commit") {
    const msg = extractCommitMessageFromCommand(cmd);
    if (msg) {
      out.push({
        type: "git_commit",
        category: "git",
        data: safeString(msg),
        priority: 2,
      });
      return out;
    }
  }

  out.push({
    type: "git",
    category: "git",
    data: safeString(match.operation),
    priority: 2,
  });
  return out;
}

// Algorithmic git invocation parser — tokenizes the Bash command and walks
// argv to extract the `-C <dir>` scope hint and the operation subcommand.
// Tolerates env-prefix assignments and any number of flags between `git`
// and the operation. Returns null when no `git` token is found (caller
// falls back to the legacy regex pattern scan).
interface ParsedGit {
  scopedDir: string | null;
  operation: string | null;
}

/**
 * Gap #2 (16-oss-verify-gap-prd) — expand leading `~` / `~/` to homedir.
 * Does NOT support `~user/path` (no current-user resolution at bridge
 * layer; that requires a passwd lookup). Returns input unchanged when
 * there is no tilde or the path starts with `~<otheruser>`.
 */
function expandHomeTilde(path: string): string {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return getHomedirSafe();
  if (path.startsWith("~/")) return getHomedirSafe() + path.slice(1);
  return path;
}

/**
 * Lazily-resolved homedir — avoids a require/import at module init time.
 * Falls back to "~" (no-op expansion) when the environment is sandboxed
 * without HOME / USERPROFILE.
 */
function getHomedirSafe(): string {
  try {
    const home = process.env.HOME
      || process.env.USERPROFILE
      || (process.env.HOMEDRIVE && process.env.HOMEPATH
          ? process.env.HOMEDRIVE + process.env.HOMEPATH
          : "");
    return home || "~";
  } catch {
    return "~";
  }
}

function parseGitInvocation(cmd: string): ParsedGit | null {
  const tokens = tokenizeCommand(cmd);
  let i = 0;
  // Skip env-style assignments at the head (FOO=bar git ...)
  while (i < tokens.length && isEnvAssignment(tokens[i])) i++;
  // Locate the `git` token (allow common runners like `sudo git ...`)
  while (i < tokens.length && tokens[i] !== "git" && !tokens[i].endsWith("/git")) {
    // Stop runner-skipping at the first non-assignment, non-runner token
    if (!isCommonRunner(tokens[i])) break;
    i++;
  }
  if (i >= tokens.length) return null;
  if (tokens[i] !== "git" && !tokens[i].endsWith("/git")) return null;
  i++; // consume `git`

  let scopedDir: string | null = null;
  let operation: string | null = null;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "--directory") {
      scopedDir = tokens[i + 1] ?? null;
      i += 2;
      continue;
    }
    // Gap #2 — `--directory=/path` equals-form (tokenizer keeps it as one)
    if (t.startsWith("--directory=")) {
      scopedDir = t.slice("--directory=".length);
      i++;
      continue;
    }
    if (t.length > 0 && t[0] === "-") {
      // Generic flag — skip the flag itself. We do NOT consume the next
      // token as its value generically because git's per-flag arg shape
      // varies; the dedicated extractCommitMessageFromCommand handles -m
      // separately.
      i++;
      continue;
    }
    // First bare (non-flag) token after `git` = operation
    operation = t;
    break;
  }
  if (scopedDir) scopedDir = expandHomeTilde(scopedDir);
  return { scopedDir, operation };
}

function isEnvAssignment(token: string): boolean {
  if (token.length === 0) return false;
  // FOO=bar shape: starts with an uppercase letter, contains an `=`
  let sawEq = false;
  for (let j = 0; j < token.length; j++) {
    const c = token.charCodeAt(j);
    if (j === 0) {
      // First char must be A-Z or underscore
      if (!((c >= 65 && c <= 90) || c === 95)) return false;
    } else if (c === 61 /* = */) {
      sawEq = true;
      break;
    } else if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)) {
      // Body chars must be A-Z, 0-9, or _
      return false;
    }
  }
  return sawEq;
}

function isCommonRunner(token: string): boolean {
  // Runners that wrap real commands. We skip them when locating `git`
  // so `sudo git status` works the same as `git status`.
  switch (token) {
    case "sudo":
    case "doas":
    case "env":
    case "exec":
    case "time":
      return true;
    default:
      return false;
  }
}

// Shell-like argv tokenizer — handles single/double quotes, backslash escapes,
// and merges adjacent quoted/unquoted segments per POSIX shell behavior
// (`echo a"b c"d` → ["ab cd"]). Pure char loop; no regex.
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const n = cmd.length;
  let i = 0;
  while (i < n) {
    while (i < n && (cmd[i] === " " || cmd[i] === "\t")) i++;
    if (i >= n) break;
    let buf = "";
    while (i < n && cmd[i] !== " " && cmd[i] !== "\t") {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < n && cmd[i] !== quote) {
          if (cmd[i] === "\\" && i + 1 < n) {
            buf += cmd[i + 1];
            i += 2;
          } else {
            buf += cmd[i];
            i++;
          }
        }
        if (i < n) i++; // consume closing quote
      } else if (ch === "\\" && i + 1 < n) {
        buf += cmd[i + 1];
        i += 2;
      } else {
        buf += ch;
        i++;
      }
    }
    tokens.push(buf);
  }
  return tokens;
}

// Linear scan over argv looking for a commit-message-bearing flag:
//   --message=<value>   long form, attached value
//   --message <value>   long form, separate token
//   -m / -am / -cm ...  short cluster ending in 'm', value in next token
// Returns null when no message arg is present — caller falls back to
// operation name. Pure char checks; no regex.
function extractCommitMessageFromCommand(cmd: string): string | null {
  const argv = tokenizeCommand(cmd);
  const longPrefix = "--message=";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Long form: --message=VALUE
    if (arg.length > longPrefix.length && arg.startsWith(longPrefix)) {
      const v = arg.slice(longPrefix.length);
      return v.length > 0 ? v : null;
    }
    // Long form: --message VALUE
    if (arg === "--message") {
      const v = argv[i + 1];
      return v && v.length > 0 ? v : null;
    }
    // Short cluster ending in 'm' (e.g. -m, -am, -cm). Cluster must be
    // single-dash followed by only lowercase letters, last letter 'm'.
    if (
      arg.length >= 2 &&
      arg[0] === "-" &&
      arg[1] !== "-" &&
      arg[arg.length - 1] === "m" &&
      isLowerAlphaRun(arg, 1)
    ) {
      const v = argv[i + 1];
      return v && v.length > 0 ? v : null;
    }
  }
  return null;
}

function isLowerAlphaRun(s: string, start: number): boolean {
  if (start >= s.length) return false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 97 || c > 122) return false; // not a-z
  }
  return true;
}

/**
 * Category 3: task
 * TodoWrite / TaskCreate / TaskUpdate tool calls.
 */
function extractTask(input: HookInput): SessionEvent[] {
  const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
  if (!TASK_TOOLS.has(input.tool_name)) return [];

  // Store tool name as type so create vs update can be reliably distinguished
  const type = input.tool_name === "TaskUpdate" ? "task_update"
    : input.tool_name === "TaskCreate" ? "task_create"
    : "task"; // TodoWrite fallback

  return [{
    type,
    category: "task",
    data: safeString(JSON.stringify(input.tool_input)),
    priority: 1,
  }];
}

/**
 * Category 15: plan
 * Tracks the full plan mode lifecycle:
 * - EnterPlanMode → plan_enter
 * - Write/Edit to ~/.claude/plans/ → plan_file_write
 * - ExitPlanMode → plan_exit (with allowedPrompts)
 * - ExitPlanMode tool_response → plan_approved / plan_rejected
 *
 * Note: Shift+Tab and /plan command do NOT fire PostToolUse hooks
 * (Claude Code bug #15660). Only programmatic EnterPlanMode is tracked.
 */
/**
 * FNV-1a 32-bit hash → 8-char lowercase hex. Stable across runs/platforms.
 * Used for plan_hash so identical plans dedupe at the platform side.
 */
function fnv1a32Hex(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Read the plan text from the ExitPlanMode envelope. SDK carries it on
 * the OUTPUT (ExitPlanModeOutput @ :2222), but the PRD body cites input.
 * Try both so we are spec-flexible.
 */
function extractExitPlanText(input: HookInput): string | null {
  const inputPlan = input.tool_input["plan"];
  if (typeof inputPlan === "string" && inputPlan.length > 0) return inputPlan;
  const resp = input.tool_response;
  if (typeof resp === "string" && resp.length > 0) {
    try {
      const parsed = JSON.parse(resp);
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).plan === "string") {
        return (parsed as Record<string, unknown>).plan as string;
      }
    } catch { /* fall through */ }
  }
  return null;
}

function extractPlan(input: HookInput): SessionEvent[] {
  if (input.tool_name === "EnterPlanMode") {
    return [{
      type: "plan_enter",
      category: "plan",
      data: "entered plan mode",
      priority: 2,
    }];
  }

  if (input.tool_name === "ExitPlanMode") {
    const events: SessionEvent[] = [];

    // Plan exit event with allowedPrompts detail
    const prompts = input.tool_input["allowedPrompts"];
    let detail = Array.isArray(prompts) && prompts.length > 0
      ? `exited plan mode (allowed: ${safeStringAny(prompts.map((p: unknown) => {
          if (typeof p === "object" && p !== null && "prompt" in p) return String((p as Record<string, unknown>).prompt);
          return String(p);
        }).join(", "))})`
      : "exited plan mode";

    // §11 / PRD #6 — append plan_bytes + plan_hash so the platform can
    // dedupe identical plans across sessions and JOIN plan_mode_authorized
    // writes against a stable plan id. Plan source: tool_input.plan first
    // (per PRD), fall back to tool_response.plan (SDK actually carries it
    // there per ExitPlanModeOutput @ sdk-tools.d.ts:2222).
    const plan = extractExitPlanText(input);
    if (typeof plan === "string" && plan.length > 0) {
      detail += ` plan_bytes:${plan.length} plan_hash:${fnv1a32Hex(plan)}`;
    }

    events.push({
      type: "plan_exit",
      category: "plan",
      data: safeString(detail),
      priority: 2,
    });

    // Detect approval/rejection from tool_response
    const response = String(input.tool_response ?? "").toLowerCase();
    if (response.includes("approved") || response.includes("approve")) {
      events.push({
        type: "plan_approved",
        category: "plan",
        data: "plan approved by user",
        priority: 1,
      });
    } else if (response.includes("rejected") || response.includes("decline") || response.includes("denied")) {
      events.push({
        type: "plan_rejected",
        category: "plan",
        data: safeString(`plan rejected: ${input.tool_response ?? ""}`),
        priority: 2,
      });
    }

    return events;
  }

  // Detect plan file writes (Write/Edit to ~/.claude/plans/)
  if (input.tool_name === "Write" || input.tool_name === "Edit") {
    const filePath = String(input.tool_input["file_path"] ?? "");
    if (isPlanFilePath(filePath)) {
      return [{
        type: "plan_file_write",
        category: "plan",
        data: safeString(`plan file: ${filePath.split(/[/\\]/).pop() ?? filePath}`),
        priority: 2,
      }];
    }
  }

  if (input.tool_name === "apply_patch") {
    if (isToolError(input)) return [];
    const patchTargets = extractApplyPatchTargets(
      String(input.tool_input["command"] ?? input.tool_input["patch"] ?? ""),
    );
    return patchTargets
      .filter((target) => isPlanFilePath(target.path))
      .map((target) => ({
        type: "plan_file_write",
        category: "plan",
        data: safeString(`plan file: ${target.path.split(/[/\\]/).pop() ?? target.path}`),
        priority: 2,
      }));
  }

  return [];
}

/**
 * Category 8: env
 * Environment setup commands in Bash: venv, export, nvm, pyenv, conda, rbenv.
 */

const ENV_PATTERNS: RegExp[] = [
  /\bsource\s+\S*activate\b/,
  /\bexport\s+\w+=/,
  /\bnvm\s+use\b/,
  /\bpyenv\s+(shell|local|global)\b/,
  /\bconda\s+activate\b/,
  /\brbenv\s+(shell|local|global)\b/,
  /\bnpm\s+install\b/,
  /\bnpm\s+ci\b/,
  /\bpip\s+install\b/,
  /\bbun\s+install\b/,
  /\byarn\s+(add|install)\b/,
  /\bpnpm\s+(add|install)\b/,
  /\bcargo\s+(install|add)\b/,
  /\bgo\s+(install|get)\b/,
  /\brustup\b/,
  /\basdf\b/,
  /\bvolta\b/,
  /\bdeno\s+install\b/,
];

function extractEnv(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];

  const cmd = String(input.tool_input["command"] ?? "");
  const isEnvCmd = ENV_PATTERNS.some(p => p.test(cmd));
  if (!isEnvCmd) return [];

  // Sanitize export commands to prevent secret leakage
  const sanitized = cmd.replace(/\bexport\s+(\w+)=\S*/g, "export $1=***");

  return [{
    type: "env",
    category: "env",
    data: safeString(sanitized),
    priority: 2,
  }];
}

/**
 * Category 10: skill
 * Skill tool invocations.
 */
function extractSkill(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Skill") return [];

  const skillName = String(input.tool_input["skill"] ?? "");
  return [{
    type: "skill",
    category: "skill",
    data: safeString(skillName),
    priority: 2,
  }];
}

/**
 * Category 16: constraint
 * Constraints discovered through error events — tool failures reveal
 * platform/environment limitations worth remembering.
 */
function extractConstraint(input: HookInput): SessionEvent[] {
  // Only fire on error events — constraints are discovered through failures
  if (!input.tool_response?.includes("Error") && !input.tool_output?.isError) return [];

  const response = String(input.tool_response || "");
  const patterns = [/not supported/i, /cannot/i, /does not support/i, /FAIL/i, /refused/i, /permission denied/i, /incompatible/i];

  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match) {
      // Extract context around the match
      const idx = response.toLowerCase().indexOf(match[0].toLowerCase());
      const context = response.slice(Math.max(0, idx - 50), Math.min(response.length, idx + 200)).trim();
      return [{
        type: "constraint_discovered",
        category: "constraint",
        data: safeString(context),
        priority: 2,
      }];
    }
  }
  return [];
}

/**
 * Category 9: subagent
 * Agent tool calls — tracks both launch and completion.
 * When tool_response is present, the agent has completed and the result
 * is captured at higher priority (P2) so it survives budget trimming.
 */
function extractSubagent(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Agent") return [];

  const prompt = safeString(String(input.tool_input["prompt"] ?? input.tool_input["description"] ?? ""));
  const response = input.tool_response ? safeString(String(input.tool_response)) : "";
  const isCompleted = response.length > 0;

  return [{
    type: isCompleted ? "subagent_completed" : "subagent_launched",
    category: "subagent",
    data: isCompleted
      ? safeString(`[completed] ${prompt} → ${response}`)
      : safeString(`[launched] ${prompt}`),
    priority: isCompleted ? 2 : 3,
  }];
}

/**
 * Category 14: mcp
 * MCP tool calls (context7, playwright, claude-mem, ctx-stats, etc.).
 */
function extractMcp(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input, tool_response } = input;
  if (!tool_name.startsWith("mcp__")) return [];

  // Extract readable tool name: last segment after __
  const parts = tool_name.split("__");
  const toolShort = parts[parts.length - 1] || tool_name;

  // Extract first string argument for context
  const firstArg = Object.values(tool_input).find((v): v is string => typeof v === "string");
  const argStr = firstArg ? `: ${safeString(String(firstArg))}` : "";

  // Append tool_response so ctx_search can find what the MCP returned — not
  // just the call shape. Without this, bodies from external MCPs (jira tickets,
  // grafana loki lines, sentry issues, context7 docs) are invisible to search.
  // No truncation: matches the rule_content precedent above — SQLite TEXT is
  // unbounded and large responses are the ones a cache most wants to preserve.
  const responseStr = tool_response && tool_response.length > 0
    ? `\nresponse: ${safeString(tool_response)}`
    : "";

  return [{
    type: "mcp",
    category: "mcp",
    data: safeString(`${toolShort}${argStr}${responseStr}`),
    priority: 3,
  }];
}

/**
 * Category 27: mcp_tool_call
 * Records the raw MCP call shape (tool_name + tool_input) so analytics
 * can compute usage patterns like batch concurrency.
 *
 * Distinct from `extractMcp` (category "mcp"), which captures the textual
 * call+response for FTS5 search. This emits a structured JSON payload
 * keyed by tool_name + params, capped to ~2KB to keep SQLite rows small.
 *
 * Priority 4 (informational) — should not crowd out high-signal events
 * during FIFO eviction.
 */
const MCP_PARAMS_BUDGET_BYTES = 2048;

/**
 * UTF-8-aware string truncation. Returns the longest prefix of `s` whose
 * UTF-8 byte length is <= `maxBytes`, never landing mid-multibyte-codepoint.
 *
 * Naive `s.slice(0, N)` operates on UTF-16 code units, so a 2KB cap could
 * either over-shoot (multi-byte codepoints occupy fewer code units than
 * bytes — e.g. a chunk of CJK / emoji-heavy JSON would silently exceed
 * the byte budget) or land mid surrogate pair (corrupt JSON downstream).
 */
function truncateToBytes(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { value: s, truncated: false };
  const buf = Buffer.from(s, "utf8");
  // Walk back from maxBytes until the byte starts a fresh codepoint:
  //   0xxxxxxx → ASCII (start)
  //   11xxxxxx → start of multi-byte
  //   10xxxxxx → continuation; keep walking
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { value: buf.subarray(0, cut).toString("utf8"), truncated: true };
}

/**
 * Keys whose VALUES must be redacted before persisting tool_input — secrets,
 * tokens, credentials, signatures. Match is on the LAST path segment of the
 * key (case-insensitive substring), so `headers.Authorization`, `auth.token`,
 * `apiKey`, `API_KEY`, `password`, `secret`, `cookie`, `set-cookie`, `signature`,
 * `private_key`, etc. all redact. False-positive risk acceptable — we'd rather
 * over-redact than ship a Bearer token to SQLite.
 */
const SECRET_KEY_PATTERN =
  /(authorization|auth_token|access_token|refresh_token|bearer|token|secret|password|passwd|pwd|api[-_]?key|apikey|cookie|set-cookie|signature|private[-_]?key|client[-_]?secret|x[-_]?api[-_]?key)/i;

const REDACTED = "[REDACTED]";

/**
 * Walk an arbitrary JSON-serializable value and return a clone with values
 * redacted under any key matching SECRET_KEY_PATTERN. Cycle-safe.
 */
function redactSecrets(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (value == null || typeof value !== "object") return value;
  // Path-based ancestor check: only flag TRUE cycles, not DAG / shared refs
  // (e.g., a single `headers` object passed to multiple sub-requests must
  // be processed at every reference site, not flagged as circular).
  if (ancestors.has(value as object)) return "[CIRCULAR]";
  ancestors.add(value as object);

  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => redactSecrets(v, ancestors));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        obj[k] = REDACTED;
      } else {
        obj[k] = redactSecrets(v, ancestors);
      }
    }
    out = obj;
  }

  ancestors.delete(value as object); // pop ancestor — siblings can re-visit
  return out;
}

function extractMcpToolCall(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input } = input;
  if (!tool_name.startsWith("mcp__")) return [];

  // Redact secrets BEFORE serialization. Any `tool_input` carrying
  // `Authorization: Bearer …`, `api_key: "sk-…"`, cookies, signatures, etc.
  // is masked before it touches SQLite. Over-redaction acceptable — under-
  // redaction is a credential leak to SessionDB.
  const redactedInput = redactSecrets(tool_input ?? {});

  // Serialize the redacted shape, then truncate the *string* (not the object)
  // so the diagnosable shape survives huge payloads.
  let paramsStr: string;
  try {
    paramsStr = JSON.stringify(redactedInput);
  } catch {
    paramsStr = "{}";
  }
  const { value: cappedStr, truncated } = truncateToBytes(paramsStr, MCP_PARAMS_BUDGET_BYTES);

  const payload = truncated
    ? `{"tool_name":${JSON.stringify(tool_name)},"params_raw":${JSON.stringify(cappedStr)},"truncated":true}`
    : `{"tool_name":${JSON.stringify(tool_name)},"params":${cappedStr}}`;

  const event: SessionEvent = {
    type: "mcp_tool_call",
    category: "mcp_tool_call",
    data: safeString(payload),
    priority: 4,
  };

  // Retrieval cost (the OTHER half of the with/without ratio): when this MCP
  // call is a `ctx_search` or `ctx_fetch_and_index` retrieval, the tool_response
  // IS the kept-out content the model paid to access — record its byte length.
  // Sandbox compute (ctx_execute/batch/file) is work-output, NOT retrieval, so
  // it is intentionally excluded. Match by suffix char-algorithmically (host
  // prefixes the name like `mcp__plugin_…__ctx_search`); NO regex.
  if (isRetrievalToolName(tool_name)) {
    const response = safeString(input.tool_response);
    if (response.length > 0) {
      event.bytes_retrieved = Buffer.byteLength(response, "utf8");
    }
  }

  return [event];
}

/** Tool-name suffixes that denote a RETRIEVAL call (kept-out content accessed). */
const RETRIEVAL_TOOL_SUFFIXES = ["ctx_search", "ctx_fetch_and_index"];

/**
 * True when `toolName` ends with one of the retrieval suffixes. Char-level
 * suffix comparison via String.prototype.endsWith — no regex. MCP host names
 * arrive prefixed (e.g. `mcp__plugin_context-mode_context-mode__ctx_search`),
 * so an exact-name check would miss them; suffix match is host-agnostic.
 */
function isRetrievalToolName(toolName: string): boolean {
  for (const suffix of RETRIEVAL_TOOL_SUFFIXES) {
    if (toolName.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Category 6 (tool-based): decision
 * AskUserQuestion tool — tracks questions posed to user and their answers.
 */
function extractDecision(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "AskUserQuestion") return [];

  const questions = input.tool_input["questions"];
  const questionText = Array.isArray(questions) && questions.length > 0
    ? String((questions[0] as Record<string, unknown>)["question"] ?? "")
    : "";

  // tool_response is a JSON string that echoes the full request payload
  // alongside the answers map: {"questions":[...],"answers":{"<q>":"<label>"}}.
  // Stringifying the raw blob leaks the echoed questions/options into the
  // event row and surfaces as "Unhandled case: [object Object]" downstream.
  const rawResponse = String(input.tool_response ?? "");
  let answerText = "";
  try {
    const parsed = JSON.parse(rawResponse) as { answers?: Record<string, unknown> };
    const answers = parsed?.answers;
    if (answers && typeof answers === "object") {
      // multiSelect: true answers arrive as string[]; single-select arrive as
      // string. Normalize both into a `" | "`-joined string so neither shape
      // silently produces an empty answer.
      const toAnswerText = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) {
          return value.filter((v): v is string => typeof v === "string").join(" | ");
        }
        return "";
      };

      const matched = questionText ? toAnswerText(answers[questionText]) : "";
      if (matched) {
        answerText = matched;
      } else {
        const values = Object.values(answers)
          .map(toAnswerText)
          .filter((v) => v.length > 0);
        answerText = values.join(" | ");
      }
    }
  } catch {
    // Non-JSON tool_response — fail safe with empty answer rather than
    // leaking the raw text (which would re-introduce the original bug
    // for any future caller that sends a non-JSON payload).
  }

  const answer = safeString(answerText);
  const summary = questionText
    ? `Q: ${safeString(questionText)} → A: ${answer}`
    : `answer: ${answer}`;

  return [{
    type: "decision_question",
    category: "decision",
    data: safeString(summary),
    priority: 2,
  }];
}

/**
 * Category 22: agent-finding
 * When the Agent tool completes (subagent returns), capture a structured
 * summary of its findings (first 500 chars of tool_response).
 */
function extractAgentFinding(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Agent") return [];
  if (!input.tool_response || input.tool_response.length === 0) return [];

  const summary = input.tool_response.length > 500
    ? input.tool_response.slice(0, 500)
    : input.tool_response;

  return [{
    type: "agent_finding",
    category: "agent-finding",
    data: safeString(summary),
    priority: 2,
  }];
}

/**
 * Category 24: external-ref
 * Scan tool_input and tool_response for external URLs, GitHub issues, and PRs.
 * Deduplicates found refs and skips internal URLs (localhost, 127.0.0.1).
 */
function extractExternalRef(input: HookInput): SessionEvent[] {
  const haystack = [
    safeStringAny(input.tool_input),
    safeString(input.tool_response),
  ].join(" ");

  if (haystack.length === 0) return [];

  const refs = new Set<string>();

  // URLs — skip localhost / 127.0.0.1
  const urlMatches = haystack.match(/https?:\/\/[^\s)]+/g);
  if (urlMatches) {
    for (let url of urlMatches) {
      // Strip trailing punctuation that gets captured from JSON/prose
      url = url.replace(/["'})\],;.]+$/, "");
      if (!/localhost|127\.0\.0\.1/i.test(url)) {
        refs.add(url);
      }
    }
  }

  // Full GitHub issue/PR URLs are already captured above.
  // Shorthand GitHub issue refs: #123 (only bare, not inside a URL)
  const issueMatches = haystack.match(/(?<!\w)#(\d+)/g);
  if (issueMatches) {
    for (const m of issueMatches) {
      refs.add(m);
    }
  }

  if (refs.size === 0) return [];

  // ctx_fetch_and_index returns a preamble like
  //   "Fetched and indexed **5 sections** (47.50KB) from: <label>"
  // Parse the size to credit bytes_avoided on the event so per-session
  // honest-savings stats reflect what was kept out of the context window.
  // KB literal in the preamble is decimal (KB = 1024 bytes per the formatter).
  let bytesAvoided: number | undefined;
  const preambleMatch = safeString(input.tool_response).match(
    /Fetched and indexed[^\(]*\(([\d.]+)\s*KB\)/i,
  );
  if (preambleMatch) {
    const kb = Number(preambleMatch[1]);
    if (Number.isFinite(kb) && kb > 0) {
      bytesAvoided = Math.round(kb * 1024);
    }
  }

  const event: SessionEvent = {
    type: "external_ref",
    category: "external-ref",
    data: safeString(Array.from(refs).join(", ")),
    priority: 3,
  };
  if (bytesAvoided !== undefined) event.bytes_avoided = bytesAvoided;
  return [event];
}

/**
 * Category 8: env (worktree)
 * EnterWorktree + ExitWorktree tools — tracks worktree lifecycle.
 */
function extractWorktree(input: HookInput): SessionEvent[] {
  if (input.tool_name === "EnterWorktree") {
    const name = String(input.tool_input["name"] ?? "unnamed");
    return [{
      type: "worktree",
      category: "env",
      data: safeString(`entered worktree: ${name}`),
      priority: 2,
    }];
  }

  if (input.tool_name === "ExitWorktree") {
    const discard = Boolean(input.tool_input["discard_changes"]);
    return [{
      type: "worktree_exit",
      category: "env",
      data: safeString(`exited worktree (discard_changes:${discard})`),
      priority: 2,
    }];
  }

  return [];
}

/**
 * Algorithmic URL host extraction — no regex.
 * Skips scheme, returns everything up to the first path/query/fragment marker.
 * Port is preserved as part of the host signature.
 */
function extractHostFromUrl(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const protoEnd = url.indexOf("://");
  if (protoEnd < 0) return null;
  const start = protoEnd + 3;
  if (start >= url.length) return null;
  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) { end = i; break; }
  }
  const host = url.slice(start, end);
  return host.length > 0 ? host : null;
}

/**
 * WebFetch response metadata — captures bytes/code/durationMs and host
 * (privacy: never the full URL or query string). Redirect-loop detection
 * is temporal, not single-field — SDK has no redirect_url.
 */
function extractWebFetchMetadata(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "WebFetch") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(resp); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];

  const obj = parsed as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof obj.code === "number") parts.push(`code:${obj.code}`);
  if (typeof obj.bytes === "number") parts.push(`bytes:${obj.bytes}`);
  if (typeof obj.durationMs === "number") parts.push(`durMs:${obj.durationMs}`);
  if (typeof obj.url === "string") {
    const host = extractHostFromUrl(obj.url);
    if (host) parts.push(`host:${host}`);
  }

  if (parts.length === 0) return [];

  return [{
    type: "webfetch_metadata",
    category: "data",
    data: safeString(parts.join(" ")),
    priority: 3,
  }];
}

/**
 * Bash outcome signals — captures the three fields that DO exist on
 * BashOutput (SDK :2160-2200): interrupted (boolean), stderr (length-only
 * for privacy), returnCodeInterpretation (semantic non-zero exit hint).
 * NO exit_code field exists in the SDK.
 */
function extractBashOutcome(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Bash") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(resp); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];

  const obj = parsed as Record<string, unknown>;
  const hasSignal =
    typeof obj.interrupted === "boolean" ||
    typeof obj.stderr === "string" ||
    typeof obj.returnCodeInterpretation === "string";
  if (!hasSignal) return [];

  const parts: string[] = [];
  if (typeof obj.interrupted === "boolean") {
    parts.push(`interrupted:${obj.interrupted}`);
  }
  if (typeof obj.returnCodeInterpretation === "string") {
    parts.push(`rcInterp:${obj.returnCodeInterpretation.slice(0, 80)}`);
  }
  if (typeof obj.stderr === "string") {
    parts.push(`stderrBytes:${obj.stderr.length}`);
  }

  return [{
    type: "bash_outcome",
    category: "data",
    data: safeString(parts.join(" ")),
    priority: 3,
  }];
}

/**
 * FileReadOutput size metadata — branches on the text/image variant.
 * Captures sizes/line counts only; never file content. Image dimensions
 * are formatted as "WxH" when both width/height are numeric.
 */
function extractFileReadMetadata(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Read") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(resp); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];

  const obj = parsed as Record<string, unknown>;
  const variant = obj.type;
  if (variant !== "text" && variant !== "image") return [];

  const parts: string[] = [`type:${variant}`];

  if (variant === "text") {
    if (typeof obj.numLines === "number") parts.push(`lines:${obj.numLines}`);
    if (typeof obj.totalLines === "number") parts.push(`totalLines:${obj.totalLines}`);
    if (typeof obj.startLine === "number") parts.push(`start:${obj.startLine}`);
  } else {
    if (typeof obj.originalSize === "number") parts.push(`origSize:${obj.originalSize}`);
    const dims = obj.dimensions;
    if (dims && typeof dims === "object") {
      const d = dims as Record<string, unknown>;
      if (typeof d.width === "number" && typeof d.height === "number") {
        parts.push(`dims:${d.width}x${d.height}`);
      }
    }
  }

  return [{
    type: "file_read_metadata",
    category: "data",
    data: safeString(parts.join(" ")),
    priority: 3,
  }];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Map platform-native tool names (Qwen Code, Gemini CLI, OpenCode, etc.) to the
 * canonical Claude Code names this extractor branches on. Without this, Qwen's
 * `run_shell_command` events would silently produce zero git/cwd/env extractions.
 *
 * Evidence: refs/platforms/qwen-code/packages/core/src/tools/tool-names.ts
 */
const TOOL_NAME_NORMALIZE: Record<string, string> = {
  // Qwen Code / Gemini CLI native names
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  grep_search: "Grep",
  search_file_content: "Grep",
  web_fetch: "WebFetch",
  write_file: "Write",
  edit: "Edit",
  glob: "Glob",
  todo_write: "TodoWrite",
  ask_user_question: "AskUserQuestion",
  list_directory: "LS",
  save_memory: "Memory",
  skill: "Skill",
  exit_plan_mode: "ExitPlanMode",
  agent: "Agent",
  // OpenCode native names
  bash: "Bash",
  view: "Read",
  grep: "Grep",
  fetch: "WebFetch",
  // Codex CLI
  shell: "Bash",
  shell_command: "Bash",
  exec_command: "Bash",
  "container.exec": "Bash",
  local_shell: "Bash",
  grep_files: "Grep",
  // Antigravity CLI (`agy`) native names. Keep in sync with the two other agy
  // maps: hooks/antigravity-cli/payload.mjs (normalizeAgyToolName) and
  // hooks/core/routing.mjs (TOOL_ALIASES).
  run_command: "Bash",
  view_file: "Read",
  read_url_content: "WebFetch",
  list_dir: "LS",
  search_web: "WebSearch",
};

function normalizeHookInput(input: HookInput): HookInput {
  const normalized = TOOL_NAME_NORMALIZE[input.tool_name];
  if (!normalized || normalized === input.tool_name) return input;
  return { ...input, tool_name: normalized };
}

/**
 * Extract session events from a PostToolUse hook input.
 *
 * Accepts the raw hook JSON shape (snake_case keys) as received from stdin.
 * Returns an array of zero or more SessionEvents. Never throws.
 */
export function extractEvents(rawInput: HookInput): SessionEvent[] {
  try {
    const input = normalizeHookInput(rawInput);
    const events: SessionEvent[] = [];

    // File + Rule (handles Read/Edit/Write)
    events.push(...extractFileAndRule(input));

    // Bash-based extractors (may overlap on the same command)
    events.push(...extractCwd(input));
    events.push(...extractError(input));
    events.push(...extractGit(input));
    events.push(...extractEnv(input));

    // Tool-specific extractors
    events.push(...extractTask(input));
    events.push(...extractPlan(input));
    events.push(...extractSkill(input));
    events.push(...extractSubagent(input));
    events.push(...extractMcp(input));
    events.push(...extractMcpToolCall(input));
    events.push(...extractDecision(input));
    events.push(...extractConstraint(input));
    events.push(...extractWorktree(input));
    events.push(...extractWebFetchMetadata(input));
    events.push(...extractBashOutcome(input));
    events.push(...extractFileReadMetadata(input));
    events.push(...extractAgentUsage(input));
    events.push(...extractAgentFinding(input));
    events.push(...extractExternalRef(input));

    // Cross-event stateful extractors
    events.push(...extractErrorResolution(input));
    events.push(...extractIterationLoop(input));

    return events;
  } catch {
    // Graceful degradation: if extraction fails, session continues normally
    return [];
  }
}
