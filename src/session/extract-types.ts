/** Shared session extraction contracts; no runtime dependencies. */

export interface SessionEvent {
  /** e.g. "file_read", "file_write", "cwd", "error_tool", "git", "task",
   *  "decision", "rule", "env", "role", "skill", "subagent", "data", "intent" */
  type: string;
  /** e.g. "file", "cwd", "error", "git", "task", "decision",
   *  "rule", "env", "role", "skill", "subagent", "data", "intent" */
  category: string;
  /** Extracted payload — full data, no truncation */
  data: string;
  /** 1=critical (rules, files, tasks) … 5=low */
  priority: number;
  /**
   * Optional — bytes context-mode prevented from entering the model context
   * window for this event. Currently populated by external_ref when a
   * ctx_fetch_and_index tool_response carries the
   * `Fetched and indexed N sections (XKB)` preamble.
   */
  bytes_avoided?: number;
  /**
   * Optional — bytes the model PAID to ACCESS kept-out content for this event:
   * the tool_response byte length of a `ctx_search` / `ctx_fetch_and_index`
   * call. This is the OTHER half of the with/without ratio (bytes_avoided is
   * the kept-out half). Sandbox compute (ctx_execute/batch/file) is work-output
   * and is excluded. Present only when the call is a retrieval call and its
   * tool_response is non-empty.
   */
  bytes_retrieved?: number;
  /**
   * Optional structured cost/usage fields (Wave 2b). Emitted by
   * extractAgentUsage alongside the colon-string `data` so the forward
   * envelope can spread them to the platform as typed columns instead of an
   * opaque blob. Present only when the source signal is present; cost_usd is
   * omitted on a price miss or a zero-token turn.
   */
  model_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
  /**
   * "task_cumulative" on agent_usage events whose tokens are a Task sub-agent's
   * usage SUMMED across its whole run (not one turn). The platform buckets these
   * as lifetime spend and never prices them per-turn — see
   * docs/handoff/cumulative-cost-bug.md.
   */
  usage_scope?: string;
}

export interface ToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

/**
 * Hook input shape as received from Claude Code PostToolUse hook stdin.
 * Uses snake_case to match the raw hook JSON.
 */
export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: string;
  /** Optional structured output from the tool (may carry isError) */
  tool_output?: { isError?: boolean; is_error?: boolean };
}
