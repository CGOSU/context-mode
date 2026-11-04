import { classifyNonZeroExit } from "./exit-classify.js";
import { cleanupExecutionSources } from "./execution-source.js";
import { boundResponse } from "./response-budget.js";
import type { ServerToolContext } from "./server.js";
import type { ExecResult } from "./types.js";

interface ExecutionResponseOptions {
  language: string;
  source: string;
  attribution: { sessionId?: string } | undefined;
  echo: string;
  intent?: string;
  timeout?: number;
  maxChars: number;
  runtimeError?: string;
}

/** Keep status and recall pointers ahead of the bounded output preview. */
export function executionResponse(
  context: Pick<ServerToolContext, "getStore" | "trackIndexed">,
  result: ExecResult,
  options: ExecutionResponseOptions,
) {
  const { language, source, attribution, echo, intent, timeout, maxChars, runtimeError } = options;
  const status = result.backgrounded ? "backgrounded"
    : result.timedOut ? "timed_out"
    : runtimeError !== undefined || result.exitCode !== 0 ? "failed" : "completed";
  const isError = status === "failed" || status === "timed_out";
  const exitCode = result.backgrounded || result.timedOut || runtimeError !== undefined ? null : result.exitCode;
  const duration = timeout === undefined ? "" : ` after ${timeout}ms`;
  const statusText = status === "backgrounded" ? `backgrounded${duration} — still running; output captured only through detachment`
    : status === "timed_out" ? `timed_out — timed out${duration}; execution stopped; captured output is partial`
    : runtimeError !== undefined ? "failed — runtime error"
    : `${status} (exit ${result.exitCode})`;
  const output = runtimeError !== undefined ? `Runtime error: ${runtimeError}`
    : result.timedOut || result.backgrounded ? `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
    : result.exitCode !== 0 ? classifyNonZeroExit({ language, ...result }).output
    : (result.stdout || "(no output)") + (result.stderr ? `\n\nstderr:\n${result.stderr}` : "");
  const header = `Execution status: ${statusText}.\n`;
  const useIntent = !!intent?.trim() && Buffer.byteLength(output) > 5_000;
  // Index everything that would be hidden by the preview cap. Execution
  // sources use the store's existing 14-day retention, not a parallel cache.
  const shouldIndex = useIntent || Buffer.byteLength(output) > 102_400 ||
    (header + echo + output).length > maxChars;
  let outputIndexed = false;
  let preview = output;
  let recall = "";
  if (shouldIndex) {
    try {
      const store = context.getStore();
      cleanupExecutionSources(store);
      const evidence = header + echo + output;
      const indexed = store.indexPlainText(evidence, source, undefined, attribution);
      outputIndexed = true;
      context.trackIndexed(Buffer.byteLength(evidence));
      recall = `Source: ${JSON.stringify(source)}\nIndexed ${indexed.totalChunks} sections. Use ctx_search(queries: [...], source: ${JSON.stringify(source)}) to recall captured output.\n`;
      if (useIntent) {
        // Retrieval is optional after the full evidence has been saved. A
        // failed search must not erase the successful indexing receipt.
        try {
          const matches = store.searchWithFallback(intent!, 5, source);
          const lines = matches.length
            ? [`${matches.length} sections matched intent ${JSON.stringify(intent)}:`, ...matches.map(r => `- ${r.title}: ${r.content.split("\n")[0].slice(0, 120)}`)]
            : [`No sections matched intent ${JSON.stringify(intent)}.`];
          const terms = store.getDistinctiveTerms(indexed.sourceId);
          if (terms.length) lines.push(`Searchable terms: ${terms.join(", ")}`);
          preview = lines.join("\n");
        } catch {
          preview = `Intent search unavailable; captured output remains indexed.\n${output}`;
        }
      }
    } catch {
      // The process outcome is still authoritative even if retention fails.
      // Never present a usable search pointer for a write that did not commit.
      recall = "Captured output was not indexed: storage unavailable; recall is unavailable for this execution.\n";
    }
  }
  const notice = outputIndexed
    ? "(output cap reached) Preview only; captured output remains indexed under the source above. Narrow ctx_search or request a larger maxOutputChars."
    : "(output cap reached) Captured output was not indexed; omitted output cannot be recalled. Request a larger maxOutputChars for future executions.";
  return {
    content: [{ type: "text" as const, text: boundResponse(header + recall + echo + preview, maxChars, notice) }],
    isError,
    structuredContent: { execution: {
      status, exitCode, timedOut: result.timedOut, backgrounded: !!result.backgrounded,
      source, outputIndexed,
    } },
  };
}
