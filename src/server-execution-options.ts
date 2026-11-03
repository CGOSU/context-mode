import { detectPlatform } from "./adapters/detect.js";


/**
 * Per-section budget for the echoed `$ <command>` line so a 50KB heredoc
 * payload cannot dominate the response body. The full command always reaches
 * the executor — only the echo is clipped (Issues #717 + #736).
 */
export const COMMAND_ECHO_MAX = 500;


export function truncateCommandForEcho(command: string): string {
  const cleaned = command.replace(/\s+/g, " ").trim();
  if (cleaned.length <= COMMAND_ECHO_MAX) return cleaned;
  return cleaned.slice(0, COMMAND_ECHO_MAX) + "…";
}


/**
 * Default execution timeout (ms) applied ONLY under Antigravity CLI (`agy`).
 * agy does not enforce an MCP RPC timeout, so a ctx_execute with a runaway or
 * blocking script hangs forever — the host never kills it and the user must
 * interrupt. Every other host enforces its own RPC timeout, so we keep the
 * no-server-timer behavior there (Issue #406 — long builds need an unbounded
 * run). A caller can still pass an explicit `timeout` to override on any host.
 */
export const AGY_DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export function resolveExecTimeout(timeout: number | undefined): number | undefined {
  if (timeout !== undefined) return timeout;
  // Only agy gets a default — every other host enforces its own RPC timeout, so
  // keep the unbounded behavior there. Detected via the env the agy bundle pins
  // (CONTEXT_MODE_PLATFORM=antigravity-cli). Tunable via CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS.
  if (detectPlatform().platform !== "antigravity-cli") return undefined;
  const override = Number(process.env.CONTEXT_MODE_AGY_EXEC_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : AGY_DEFAULT_EXEC_TIMEOUT_MS;
}


/**
 * Per-call budget for the source-code echo prepended by `ctx_execute` and
 * `ctx_execute_file` (Issues #717 + #736). The full code always reaches the
 * sandbox — only the echo is clipped so massive payloads don't dominate
 * the response. Multi-line preserved (unlike command echo) so the user
 * sees the actual program shape.
 */
export const CODE_ECHO_MAX = 2000;


export function truncateCodeForEcho(code: string): string {
  if (code.length <= CODE_ECHO_MAX) return code;
  return code.slice(0, CODE_ECHO_MAX) + "\n… (truncated)";
}


/**
 * Build the source-code preamble surfaced before tool stdout. Provenance
 * survives in indexed chunks (FTS5 sees the fenced block) so later
 * ctx_search hits remember what ran.
 */
export function buildExecuteEcho(
  language: string, code: string, path?: string, clientInfo?: { name: string; version?: string },
): string {
  const header = path ? `path=${path}\n` : "";
  // Pi already renders the submitted args. Keep provenance, not duplicate code;
  // never strip fences from stdout, which may itself contain source code.
  if (clientInfo?.name === "pi-coding-agent-context-mode-bridge" ||
      detectPlatform(clientInfo).platform === "pi") return header;
  const fenced = `\`\`\`${language}\n${truncateCodeForEcho(code)}\n\`\`\``;
  return `${header}${fenced}\n\n`;
}


export function formatCommandOutput(label: string, command: string, raw: string, onFsBytes?: (bytes: number) => void): string {
  let output = raw || "(no output)";
  const fsMatches = output.matchAll(/__CM_FS__:(\d+)/g);
  let cmdFsBytes = 0;
  for (const m of fsMatches) cmdFsBytes += parseInt(m[1]);
  if (cmdFsBytes > 0) {
    onFsBytes?.(cmdFsBytes);
    output = output.replace(/__CM_FS__:\d+\n?/g, "");
  }
  // Echo the executed command below the section heading so per-chunk
  // indexed content retains provenance for later ctx_search hits
  // (Issues #717 + #736).
  const echoed = truncateCommandForEcho(command);
  return `# ${label}\n\n$ ${echoed}\n\n${output}\n`;
}


export function combineExecOutput(result: { stdout?: string; stderr?: string }): string {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}
