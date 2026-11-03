import { z } from "zod";
import { runPool, type PoolJob } from "./runPool.js";
import { formatCommandOutput, combineExecOutput, resolveExecTimeout, truncateCommandForEcho } from "./server-execution-options.js";
import { coerceCommandsArray, coerceJsonArray } from "./server-input.js";
import { formatBatchQueryResults } from "./server-snippets.js";
import type { ServerToolContext } from "./server.js";


// ─────────────────────────────────────────────────────────
// batch_execute runner — used by ctx_batch_execute handler
// ─────────────────────────────────────────────────────────

export interface BatchCommand { label: string; command: string; }


export interface BatchRunResult {
  outputs: string[];
  timedOut: boolean;
}


export interface BatchRunOptions {
  /**
   * Total budget (concurrency=1, shared) or per-command (concurrency>1).
   * When `undefined`, no server-side timer fires — the MCP host's RPC
   * timeout governs (Issue #406).
   */
  timeout: number | undefined;
  concurrency: number;
  nodeOptsPrefix: string;
  cwd?: string;
  onFsBytes?: (bytes: number) => void;
}


export interface BatchExecutor {
  execute(input: { language: "shell"; code: string; timeout: number | undefined; cwd?: string }): Promise<{ stdout: string; timedOut?: boolean }>;
}


export function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}


export function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}


export function buildBatchNodeOptionsPrefix(shellPath: string, preloadPath: string): string {
  const option = `--require ${preloadPath}`;
  const shell = shellPath.toLowerCase();
  const base = shell.split(/[\\/]/).pop() ?? shell;

  if (shell.includes("powershell") || shell.includes("pwsh")) {
    return `$env:NODE_OPTIONS=${quotePowerShellSingle(option)}; `;
  }

  if (base === "cmd" || base === "cmd.exe") {
    return `set "NODE_OPTIONS=${option.replace(/"/g, '""')}" && `;
  }

  return `NODE_OPTIONS=${quotePosixSingle(option)} `;
}


/**
 * Execute batch commands. concurrency=1 preserves the legacy serial path
 * (shared timeout budget + cascading skip-on-timeout). concurrency>1 runs
 * commands concurrently with at most N in flight; each command receives the
 * full timeout, output is collated by input index, and per-command timeouts
 * record `(timed out)` blocks without skipping siblings.
 */
export async function runBatchCommands(
  commands: BatchCommand[],
  opts: BatchRunOptions,
  executor: BatchExecutor,
): Promise<BatchRunResult> {
  const { timeout, concurrency, nodeOptsPrefix, cwd, onFsBytes } = opts;

  if (concurrency <= 1) {
    // Serial path — shared timeout budget, cascading skip on timeout.
    // When `timeout` is undefined, no shared budget is enforced; each
    // command runs to completion (Issue #406).
    const outputs: string[] = [];
    const startTime = Date.now();
    let timedOut = false;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      let perCmdTimeout: number | undefined;
      if (timeout !== undefined) {
        const elapsed = Date.now() - startTime;
        const remaining = timeout - elapsed;
        if (remaining <= 0) {
          outputs.push(`# ${cmd.label}\n\n(skipped — batch timeout exceeded)\n`);
          timedOut = true;
          continue;
        }
        perCmdTimeout = remaining;
      }
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout: perCmdTimeout,
        cwd,
      });
      outputs.push(formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes));
      if (result.timedOut) {
        timedOut = true;
        for (let j = i + 1; j < commands.length; j++) {
          outputs.push(`# ${commands[j].label}\n\n(skipped — batch timeout exceeded)\n`);
        }
        break;
      }
    }
    return { outputs, timedOut };
  }

  // Parallel path — delegated to the shared runPool primitive.
  // Each job returns { output, timedOut }; runPool handles in-flight cap,
  // throw isolation (Promise.allSettled semantics), and order preservation.
  const jobs: PoolJob<{ output: string; timedOut: boolean }>[] = commands.map((cmd) => ({
    run: async () => {
      const result = await executor.execute({
        language: "shell",
        code: `${nodeOptsPrefix}${cmd.command}`,
        timeout,
        cwd,
      });
      // Always route partial output through formatCommandOutput so __CM_FS__
      // markers are stripped + counted, even when the command timed out.
      const formatted = formatCommandOutput(cmd.label, cmd.command, combineExecOutput(result), onFsBytes);
      const output = result.timedOut
        ? formatted.replace(/\n$/, "") + `\n(timed out after ${timeout ?? "?"}ms)\n`
        : formatted;
      return { output, timedOut: !!result.timedOut };
    },
  }));

  const { settled } = await runPool(jobs, { concurrency });
  const outputs: string[] = new Array(commands.length);
  let timedOut = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs[i] = r.value.output;
      if (r.value.timedOut) timedOut = true;
    } else {
      // Isolated executor throw (spawn EAGAIN, ENOMEM, EMFILE, …) — siblings keep running.
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      outputs[i] = `# ${commands[i].label}\n\n(executor error: ${message})\n`;
    }
  }
  return { outputs, timedOut };
}

export function registerBatchTool(context: ServerToolContext): void {
  const { server, checkDenyPolicy, runtimes, CM_FS_PRELOAD, sessionStats, executor, trackResponse, trackIndexed, getStore, currentAttribution } = context;


// ─────────────────────────────────────────────────────────
// Tool: batch_execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_batch_execute",
  {
    title: "Batch Execute & Search",
    // #846: runs arbitrary shell commands (with network) and indexes output.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Run multiple commands in ONE call. Every command's output is auto-indexed into the knowledge base; if you also pass \`queries\`, the matching sections come back in the same round trip so a follow-up search call is not needed.

Concurrency parallelizes the FETCH phase (run-the-commands). The DERIVATION phase — turning raw output into an answer — still belongs in code: add a processing command that consumes the indexed output and prints only the answer, so the raw bytes never enter your conversation (Think-in-Code, same principle as the sandbox tool).

WHEN:
  - You have 3+ related commands you would otherwise run sequentially (multi-issue lookups, git log + git diff + git blame, multi-file reads, multi-region cloud queries)
  - You want to gather AND query in one round trip — pass \`queries\` so the matching sections come back inline
  - You want to parallelize I/O-bound work — pass \`concurrency\` 2-8 (network calls, gh CLI, cloud APIs, multi-repo git reads)
  - The combined output is large enough that piping it through ctx_search later would itself be expensive — let auto-index + inline queries do both in one shot

WHEN NOT:
  - Single command with no follow-up query — run it in the sandbox tool directly
  - CPU-bound or stateful commands — keep concurrency at 1 (npm test, build, lint, port-binding servers, lock-file holders, anything that races on the same resource)

RETURNS:
  Auto-indexed section list per command label, plus top matches per query (when \`queries\` is passed). Raw output is NOT echoed in full — only the matched windows. Concurrency>1 switches each command to its own per-command timeout (no shared budget); concurrency=1 preserves the legacy shared-budget cascading-skip-on-timeout path. Use 4-8 for I/O-bound batches; keep at 1 for CPU work or shared-state commands; lower the value when target hosts enforce per-IP rate limits.

EXAMPLE: ctx_batch_execute(
  commands: [
    {label: "issue 1", command: "gh issue view 1"},
    {label: "issue 2", command: "gh issue view 2"},
    {label: "summarize", command: "echo done"}
  ],
  queries: ["root cause", "proposed fix"],
  concurrency: 2
)`,
    inputSchema: z.object({
      commands: z.preprocess(coerceCommandsArray, z
        .array(
          z.object({
            label: z
              .string()
              .describe(
                "Section header for this command's output (e.g., 'README', 'Package.json', 'Source Tree')",
              ),
            command: z
              .string()
              .describe("Shell command to execute"),
          }),
        )
        .min(1)
        .describe(
          "Commands to execute as a batch. Output is labeled with the section header. " +
          "Default order is sequential; pass concurrency>1 to run in parallel (output stays in input order).",
        )),
      queries: z.preprocess(coerceJsonArray, z
        .array(z.string())
        .min(1)
        .describe(
          "Search queries to extract information from indexed output. Use 5-8 comprehensive queries. " +
          "Each returns top 5 matching sections with full content. " +
          "This is your ONLY chance — put ALL your questions here. No follow-up calls needed.",
        )),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs. With concurrency=1, the value (when set) is a shared budget across commands; with concurrency>1, it is applied per-command."),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max commands to run in parallel (1-8, default: 1). " +
          "Use 4-8 for I/O-bound batches (network, gh, curl, multi-repo git reads). " +
          "Keep at 1 for CPU-bound (npm test, build, lint) or stateful commands (ports, locks). " +
          ">1 switches to per-command timeouts (no shared budget) and " +
          "individual `(timed out)` blocks instead of cascading skip.",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for all shell commands in this batch."),
      query_scope: z
        .enum(["batch", "global"])
        .optional()
        .default("batch")
        .describe(
          "Scope for `queries` (default: `batch`). " +
          "`batch` searches ONLY the chunks produced by this batch's commands " +
          "— useful when you want answers about the just-fetched output. " +
          "`global` searches the entire persistent index (same scope as ctx_search) " +
          "— useful when you want the batch commands to enrich context and " +
          "the queries to also surface related prior knowledge in one round trip.",
        ),
    }),
  },
  async ({ commands, queries, timeout, concurrency, cwd, query_scope }) => {
    // Security: check each command against deny patterns
    for (const cmd of commands) {
      const denied = checkDenyPolicy(cmd.command, "batch_execute");
      if (denied) return denied;
    }

    try {
      // Inject NODE_OPTIONS for FS read tracking in spawned Node processes.
      // The executor denies NODE_OPTIONS in its env (security), so we set it
      // as an inline shell prefix. This only affects child `node` invocations.
      const nodeOptsPrefix = buildBatchNodeOptionsPrefix(runtimes.shell, CM_FS_PRELOAD);

      // Full stdout is preserved per-command and indexed into FTS5 (Issue #61, #197).
      // Concurrency>1 switches to a worker pool with per-command timeouts.
      const effTimeout = resolveExecTimeout(timeout);
      const { outputs: perCommandOutputs, timedOut } = await runBatchCommands(
        commands,
        {
          timeout: effTimeout,
          concurrency,
          nodeOptsPrefix,
          cwd,
          onFsBytes: (bytes) => { sessionStats.bytesSandboxed += bytes; },
        },
        executor,
      );

      const stdout = perCommandOutputs.join("\n");
      const totalBytes = Buffer.byteLength(stdout);
      const totalLines = stdout.split("\n").length;

      if (timedOut && perCommandOutputs.length === 0) {
        return trackResponse("ctx_batch_execute", {
          content: [
            {
              type: "text" as const,
              text: `Batch timed out after ${effTimeout}ms. No output captured.`,
            },
          ],
          isError: true,
        });
      }

      // Track indexed bytes (raw data that stays in sandbox)
      trackIndexed(totalBytes);

      // Index into knowledge base — markdown heading chunking splits by # labels
      const store = getStore();
      const source = `batch:${commands
        .map((c) => c.label)
        .join(",")
        .slice(0, 80)}`;
      const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });

      // Commands inventory — list what the agent actually ran so the
      // response itself documents intent, not just per-section echoes.
      // Placed before "## Indexed Sections" so it scans top-down with
      // the human asking "what just happened" (Issues #717 + #736).
      const commandsInventory: string[] = ["## Commands", ""];
      for (const c of commands) {
        commandsInventory.push(`- ${c.label}: \`${truncateCommandForEcho(c.command)}\``);
      }

      // Build section inventory — direct query by source_id (no FTS5 MATCH needed)
      const allSections = store.getChunksBySource(indexed.sourceId);
      const inventory: string[] = ["## Indexed Sections", ""];
      const sectionTitles: string[] = [];
      for (const s of allSections) {
        const bytes = Buffer.byteLength(s.content);
        inventory.push(`- ${s.title} (${(bytes / 1024).toFixed(1)}KB)`);
        sectionTitles.push(s.title);
      }

      // Run all search queries — default scope is batch-local (legacy behavior).
      // When the caller passes query_scope: "global", searches reach the entire
      // persistent index in the same round trip. Cross-source search remains
      // available via explicit ctx_search() as well.
      const queryResults = formatBatchQueryResults(store, queries, source, undefined, query_scope);

      // Get searchable terms for edge cases where follow-up is needed
      const distinctiveTerms = store.getDistinctiveTerms
        ? store.getDistinctiveTerms(indexed.sourceId)
        : [];

      const output = [
        `Executed ${commands.length} commands (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB). ` +
          `Indexed ${indexed.totalChunks} sections. Searched ${queries.length} queries.`,
        "",
        ...commandsInventory,
        "",
        ...inventory,
        "",
        ...queryResults,
        distinctiveTerms.length > 0
          ? `\nSearchable terms for follow-up: ${distinctiveTerms.join(", ")}`
          : "",
      ].join("\n");

      return trackResponse("ctx_batch_execute", {
        content: [{ type: "text" as const, text: output }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_batch_execute", {
        content: [
          {
            type: "text" as const,
            text: `Batch execution error: ${message}`,
          },
        ],
        isError: true,
      });
    }
  },
);
}
