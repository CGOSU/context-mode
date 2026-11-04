/** Pi-only presentation metadata. The MCP server remains the schema authority. */
const descriptions: Readonly<Record<string, string>> = {
  ctx_execute:
    "Run code in a sandbox; only printed output enters context. Use for large/uncertain command output and data analysis; native tools suit short commands and edits. Summarize inside code. intent indexes large output for ctx_search. background keeps long-running processes alive after timeout.",
  ctx_execute_file:
    "Analyze a local file in a sandbox using FILE_CONTENT; only printed results enter context. Use for filtering, parsing, and summaries, not editing. Use native read before edit. intent indexes large output for ctx_search.",
  ctx_index:
    "Persist docs, code, or a local file/directory in the searchable FTS5 knowledge base. Supply content OR path. Query later with ctx_search; file-backed sources track staleness. For one-off logs/data analysis, use ctx_execute_file instead.",
  ctx_search:
    "Search indexed content and captured session memory. Batch related queries and scope with a known source; if results have the wrong source/date, inspect the original record. File-backed results flag staleness. timeline includes prior sessions. Bounded previews are historical evidence, not current code truth.",
  ctx_fetch_and_index:
    "Fetch URLs, convert and persist content for ctx_search; returns previews, not full pages. Supports parallel requests and TTL caching. Use ttl:0 or force for fresh content. Plain HTTP only: cannot render JavaScript-dependent pages.",
  ctx_batch_execute:
    "Run commands and index their output under a unique source; queries return bounded excerpts. Summarize/filter inside commands. Failures and timeouts remain failures. Use concurrency:1 for shared state, tests, builds, or CPU work. query_scope defaults to this batch; use its source for follow-up.",
  ctx_stats:
    "Show session context-mode usage, bytes returned, tool calls, and estimated savings. Read-only; does not reset data.",
  ctx_doctor:
    "Diagnose context-mode runtimes, hooks, FTS5, and plugin registration. Returns OK/FAIL/WARN checks; no CLI execution needed.",
  ctx_upgrade:
    "Return the context-mode upgrade shell command. Run it only with upgrade authorization, report actual results, then ask the user to restart the session.",
  ctx_purge:
    "Permanently delete indexed content; irreversible. Require explicit user authorization, confirm:true, and exactly one scope: sessionId for one session OR scope:'project' for the whole project. Ambiguous requests require clarification. Use ctx_stats first for project-wide preview; do not purge just to save memory.",
  ctx_insight:
    "Open the hosted context-mode Insight analytics dashboard in the default browser. This is a launcher, not knowledge-base Q&A; use ctx_search for indexed content.",
};

// Only known, verbose fields are replaced. Unknown/new fields keep the server's
// descriptions, including safety notices. Never truncate arbitrary descriptions.
const parameterDescriptions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ctx_execute: {
    code: "Source code; print only the summary/results needed in context.",
    timeout: "Execution timeout in ms. Omit for the MCP host RPC timeout; set explicitly for long-running builds.",
    background: "On timeout, detach instead of killing the process (servers/daemons). Do not add self-close timers. Prefer one call for server + fetch.",
    cwd: "Working directory for shell only; other languages run in a sandbox temp directory.",
    intent: "Topic to index when output exceeds ~5KB; returns section previews instead of full output. Retrieve details with ctx_search using returned searchable terms.",
  },
  ctx_execute_file: {
    code: "Code using FILE_CONTENT; print only the needed results.",
    intent: "Topic to index when output exceeds ~5KB; returns matching sections instead of full output.",
  },
  ctx_fetch_and_index: {
    requests: "Batch of URLs with optional source labels; use concurrency > 1 for parallel fetching.",
    concurrency: "Parallel fetches (1-8, capped by host CPUs); FTS5 writes remain serial. Lower for rate-limited hosts.",
  },
  ctx_batch_execute: {
    commands: "Labeled shell commands; sequential by default. Parallelize only independent I/O.",
    queries: "Focused questions for this batch; up to 3 matching excerpts per query within the response budget. Follow up with ctx_search and the returned source.",
    timeout: "Timeout in ms; omitted uses the host RPC timeout. Sequential commands share the budget; parallel commands each get this timeout.",
    concurrency: "Parallel commands (1-8). Keep 1 for shared state, tests/builds, CPU work, and port/lock holders; higher values suit independent I/O.",
    query_scope: "batch (default): search only this call's indexed output. global: also search the persistent knowledge base, including prior content.",
  },
};

/** Copy only presentation fields; preserve every validation keyword and value. */
export function piToolMetadata(tool: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}): { description: string; parameters: Record<string, unknown> } {
  const parameters = tool.inputSchema ?? { type: "object", properties: {} };
  const overrides = parameterDescriptions[tool.name];
  const properties = parameters.properties;
  const compactProperties = overrides && properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.fromEntries(Object.entries(properties).map(([key, value]) => [
        key,
        overrides[key] && value && typeof value === "object" && !Array.isArray(value)
          ? { ...value, description: overrides[key] }
          : value,
      ]))
    : undefined;
  return {
    description: descriptions[tool.name] ?? tool.description ?? "",
    parameters: compactProperties ? { ...parameters, properties: compactProperties } : parameters,
  };
}
