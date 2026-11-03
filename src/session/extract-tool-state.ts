import type { HookInput, SessionEvent } from "./extract-types.js";
import { isToolError, safeString } from "./extract-common.js";

// ── Cross-event stateful extractors ───────────────────────────────────────

/**
 * Category 23: error-resolution
 * Detects when an error is followed by a successful fix (cross-event state).
 */

let lastError: { tool: string; error: string; callsSince: number } | null = null;

export function extractErrorResolution(input: HookInput): SessionEvent[] {
  const { tool_name, tool_response } = input;
  const response = String(tool_response ?? "");

  // If this call is an error, store it and return
  if (isToolError(input)) {
    lastError = { tool: tool_name, error: response.slice(0, 200), callsSince: 0 };
    return [];
  }

  // No pending error → nothing to resolve
  if (!lastError) return [];

  // Increment staleness counter
  lastError.callsSince++;

  // Timeout: clear after 10 calls without resolution
  if (lastError.callsSince > 10) {
    lastError = null;
    return [];
  }

  const callSucceeded = !isToolError(input);
  if (!callSucceeded) return [];

  // Check if this is a resolution: same tool, or Edit/Write after a Read error
  const sameTool = tool_name === lastError.tool;
  const editAfterReadError =
    lastError.tool === "Read"
    && (tool_name === "Edit" || tool_name === "Write" || tool_name === "apply_patch");

  if (sameTool || editAfterReadError) {
    const event: SessionEvent = {
      type: "error_resolved",
      category: "error-resolution",
      data: safeString(`Error in ${lastError.tool}: ${lastError.error} → Fixed`),
      priority: 2,
    };
    lastError = null;
    return [event];
  }

  return [];
}

/** Reset error-resolution state (for testing). */
export function resetErrorResolutionState(): void {
  lastError = null;
}

/**
 * Category 26: iteration-loop
 * Detects when the same tool is called repeatedly with similar input (stuck loop).
 */

const callHistory: Array<{ tool: string; inputHash: string }> = [];

function simpleHash(str: string): string {
  return `${str.length}:${str.slice(0, 20)}`;
}

export function extractIterationLoop(input: HookInput): SessionEvent[] {
  const { tool_name, tool_input } = input;
  const inputHash = simpleHash(JSON.stringify(tool_input).slice(0, 200));

  callHistory.push({ tool: tool_name, inputHash });

  // Keep history bounded
  if (callHistory.length > 50) {
    callHistory.splice(0, callHistory.length - 50);
  }

  // Check last N entries for repeated pattern (minimum 3)
  if (callHistory.length < 3) return [];

  let count = 0;
  for (let i = callHistory.length - 1; i >= 0; i--) {
    if (callHistory[i].tool === tool_name && callHistory[i].inputHash === inputHash) {
      count++;
    } else {
      break;
    }
  }

  if (count >= 3) {
    // Reset the matching tail to avoid duplicate emissions
    callHistory.splice(callHistory.length - count);
    return [{
      type: "retry_detected",
      category: "iteration-loop",
      data: safeString(`${tool_name} called ${count} times with similar input`),
      priority: 2,
    }];
  }

  return [];
}

/** Reset iteration-loop state (for testing). */
export function resetIterationLoopState(): void {
  callHistory.length = 0;
}
