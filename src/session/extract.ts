/**
 * Public session extraction entry points.
 * Tool events, user intent and host usage have independent implementations;
 * this module preserves the hook and adapter import surface.
 */

import type { SessionEvent } from "./extract-types.js";
import { safeString } from "./extract-common.js";

export type { SessionEvent, ToolCall, HookInput } from "./extract-types.js";
export { extractEvents } from "./extract-tools.js";
export { resetErrorResolutionState, resetIterationLoopState } from "./extract-tool-state.js";
export { extractUserEvents, extractUserPromptFeatures, type PromptFeatures } from "./extract-user.js";
export {
  parsePiUsage,
  parseOpenclawUsage,
  parseOpencodeUsage,
  buildAgentUsageEvent,
  parseGeminiUsage,
  extractTranscriptUsage,
  extractTranscriptUsageSince,
  type AgentUsageCounts,
} from "./extract-usage.js";

// Adapter-owned wire readers remain reachable from the shared hook bundle.
export { parseKimiUsage, extractKimiUsageSince } from "../adapters/kimi/usage.js";
export { parseQwenUsage, extractQwenUsageSince } from "../adapters/qwen-code/usage.js";

/**
 * Issue #4 (new PRD) — SessionStart settings + MCP servers snapshot.
 *
 * Emits ONE session_settings_snapshot event when ≥1 setting is available
 * on the SessionStart input. The data field carries key:value tokens
 * (mcp_count, mcp_servers, model, permission_mode) so the platform can
 * compute MCP integration counts and primary-model adoption per org.
 * mcp_servers list is truncated to first 8 names.
 */
export function extractSessionSettings(input: unknown): SessionEvent[] {
  if (!input || typeof input !== "object") return [];

  const obj = input as Record<string, unknown>;
  const parts: string[] = [];

  const mcpServers = obj.mcp_servers;
  let mcpKeys: string[] | null = null;
  if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
    mcpKeys = Object.keys(mcpServers as Record<string, unknown>);
    parts.push(`mcp_count:${mcpKeys.length}`);
    if (mcpKeys.length > 0) {
      parts.push(`mcp_servers:${mcpKeys.slice(0, 8).join(",")}`);
    }
  }

  if (typeof obj.model === "string") {
    parts.push(`model:${obj.model.slice(0, 64)}`);
  }

  if (typeof obj.permission_mode === "string") {
    parts.push(`permission_mode:${obj.permission_mode.slice(0, 32)}`);
  }

  if (parts.length === 0) return [];

  return [{
    type: "session_settings_snapshot",
    category: "env",
    data: safeString(parts.join(" ")),
    priority: 2,
  }];
}
