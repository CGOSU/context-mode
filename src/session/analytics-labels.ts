/** Shared continuity display vocabulary; no collection or rendering dependencies. */

// ─────────────────────────────────────────────────────────
// Category labels and hints for session continuity display
// ─────────────────────────────────────────────────────────

/**
 * Human-readable labels for event categories.
 *
 * Each label is a sentence-case phrase that reads like a benefit, not a
 * column name. The user shouldn't see raw schema words like "external-ref"
 * or "agent-finding" — those leak the database into the UX. When a new
 * category lands without an entry here, the renderer falls through to the
 * raw category id; that's a copy-debt signal, fix it here.
 */
export const categoryLabels: Record<string, string> = {
  // Code & filesystem
  file: "Files tracked",
  cwd: "Working directory",
  // Configuration & intent
  rule: "Project rules (CLAUDE.md)",
  prompt: "Your requests saved",
  intent: "Session intent",
  goal: "Session goal",
  role: "Behavior rules",
  constraint: "Constraints you set",
  // Tools & delegation
  mcp: "MCP tools called",
  skill: "Skills used",
  subagent: "Delegated work",
  // Knowledge & decisions
  decision: "Your decisions",
  "agent-finding": "Agent insights kept",
  "rejected-approach": "Approaches you rejected",
  "external-ref": "External docs indexed",
  data: "Data references",
  // System events
  git: "Git operations",
  env: "Environment setup",
  task: "Tasks in progress",
  error: "Errors caught",
  // Continuity proof
  compact: "Compactions weathered",
  resume: "Sessions resumed cleanly",
  snapshot: "Snapshots restored",
  cache: "Cache hits saved",
  // Operational
  latency: "Slow tools recorded",
  "user-prompt": "Your messages remembered",
  plan: "Plans drafted",
  "blocked-on": "Blockers logged",
};

/** Explains why each category matters for continuity. */
export const categoryHints: Record<string, string> = {
  file: "Restored after compact — no need to re-read",
  rule: "Your project instructions survive context resets",
  prompt: "Continues exactly where you left off",
  decision: "Applied automatically — won’t ask again",
  task: "Picks up from where it stopped",
  error: "Tracked and monitored across compacts",
  git: "Branch, commit, and repo state preserved",
  env: "Runtime config carried forward",
  mcp: "Tool usage patterns remembered",
  subagent: "Delegation history preserved",
  skill: "Skill invocations tracked",
};
