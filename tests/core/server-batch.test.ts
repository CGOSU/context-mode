/** Server regressions: batch. */



import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import { ContentStore } from "../../src/store.js";
// ═══════════════════════════════════════════════════════════════════════════
// runBatchCommands — concurrency, ordering, timeout semantics
// ═══════════════════════════════════════════════════════════════════════════

import { buildBatchNodeOptionsPrefix, runBatchCommands, type BatchCommand } from "../../src/server.js";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


interface MockResult { stdout: string; stderr?: string; timedOut?: boolean; }


function mkMockExecutor(
  handler: (code: string, timeout: number | undefined, cwd: string | undefined) => Promise<MockResult> | MockResult,
): { execute: (input: { language: "shell"; code: string; timeout: number | undefined; cwd?: string }) => Promise<MockResult> } {
  return {
    execute: async ({ code, timeout, cwd }) => Promise.resolve(handler(code, timeout, cwd)),
  };
}


const NOOP_PREFIX = "";
 // tests don't need NODE_OPTIONS prefix

describe("runBatchCommands serial path (concurrency=1)", () => {
  test("happy path: outputs in input order, no timeout cascade", async () => {
    const cmds: BatchCommand[] = [
      { label: "A", command: "echo a" },
      { label: "B", command: "echo b" },
      { label: "C", command: "echo c" },
    ];
    const exec = mkMockExecutor((code) => ({ stdout: code.includes("echo a") ? "a" : code.includes("echo b") ? "b" : "c" }));
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toContain("# A");
    expect(outputs[0]).toContain("a");
    expect(outputs[1]).toContain("# B");
    expect(outputs[2]).toContain("# C");
  });

  test("preserves heredoc commands and combines captured stderr", async () => {
    const heredoc = "node - <<'NODE'\nconsole.log('stdout')\nconsole.error('stderr')\nNODE";
    let seenCode = "";
    const exec = mkMockExecutor((code) => {
      seenCode = code;
      return { stdout: "stdout\n", stderr: "stderr\n" };
    });
    const { outputs, timedOut } = await runBatchCommands(
      [{ label: "heredoc", command: heredoc }],
      { timeout: 5000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );

    expect(timedOut).toBe(false);
    expect(seenCode).toBe(heredoc);
    expect(seenCode).not.toContain("NODE 2>&1");
    expect(outputs[0]).toContain("stdout");
    expect(outputs[0]).toContain("stderr");
  });

  test("passes cwd override to serial shell executions (#756)", async () => {
    const seenCwds: Array<string | undefined> = [];
    const exec = mkMockExecutor((_code, _timeout, cwd) => {
      seenCwds.push(cwd);
      return { stdout: "ok" };
    });

    await runBatchCommands(
      [{ label: "cwd", command: "pwd" }],
      { timeout: 5000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX, cwd: "/worktree/repo" },
      exec,
    );

    expect(seenCwds).toEqual(["/worktree/repo"]);
  });

  test("cascading skip: timeout in first cmd skips the rest", async () => {
    let callCount = 0;
    const exec = mkMockExecutor(() => {
      callCount++;
      return { stdout: "slow", timedOut: true };
    });
    const cmds: BatchCommand[] = [
      { label: "slow", command: "sleep 999" },
      { label: "next", command: "echo next" },
      { label: "after", command: "echo after" },
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 100, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(callCount).toBe(1); // only slow command executed
    expect(timedOut).toBe(true);
    expect(outputs[0]).toContain("# slow");
    expect(outputs[1]).toContain("(skipped — batch timeout exceeded)");
    expect(outputs[2]).toContain("(skipped — batch timeout exceeded)");
  });

  test("shared timeout budget: subsequent commands skip when budget exhausted", async () => {
    let callCount = 0;
    const exec = mkMockExecutor(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 60)); // each call burns 60ms
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "x" },
      { label: "C", command: "x" }, // by here, elapsed > 100ms
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 100, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(callCount).toBeLessThan(3);
    expect(timedOut).toBe(true);
    expect(outputs.some((o) => o.includes("(skipped — batch timeout exceeded)"))).toBe(true);
  });

  // Issue #406 — when timeout omitted, no shared budget, no skip cascade.
  test("no timeout: all commands run to completion, no skip", async () => {
    const exec = mkMockExecutor(async () => {
      // Each call burns 60ms. With timeout omitted, NONE should be skipped.
      await new Promise((r) => setTimeout(r, 60));
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "x" },
      { label: "C", command: "x" },
    ];
    const { outputs, timedOut } = await runBatchCommands(
      cmds,
      { timeout: undefined, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(3);
    expect(outputs.every((o) => !o.includes("skipped"))).toBe(true);
  });

  test("no timeout: per-command timeout passed to executor is undefined", async () => {
    const seenTimeouts: Array<number | undefined> = [];
    const exec = {
      execute: async (input: { language: "shell"; code: string; timeout: number | undefined }) => {
        seenTimeouts.push(input.timeout);
        return { stdout: "ok" } as MockResult;
      },
    };
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "y" },
    ];
    await runBatchCommands(
      cmds,
      { timeout: undefined, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    expect(seenTimeouts).toEqual([undefined, undefined]);
  });
});


describe("runBatchCommands parallel path (concurrency>1)", () => {
  test("happy path: 3 cmds at concurrency=3 finish in parallel", async () => {
    const exec = mkMockExecutor(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "x" },
      { label: "B", command: "y" },
      { label: "C", command: "z" },
    ];
    const start = Date.now();
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 3, nodeOptsPrefix: NOOP_PREFIX }, exec);
    const elapsed = Date.now() - start;
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(3);
    expect(elapsed).toBeLessThan(250); // 3x parallel ~100ms, with overhead room
  });

  test("parallel path preserves heredoc commands and combines captured stderr", async () => {
    const seenCodes: string[] = [];
    const exec = mkMockExecutor((code) => {
      seenCodes.push(code);
      return { stdout: `${code.includes("one") ? "one" : "two"} stdout\n`, stderr: `${code.includes("one") ? "one" : "two"} stderr\n` };
    });
    const cmds: BatchCommand[] = [
      { label: "ONE", command: "node - <<'NODE'\nconsole.log('one')\nNODE" },
      { label: "TWO", command: "python3 - <<'PY'\nprint('two')\nPY" },
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX }, exec);

    expect(timedOut).toBe(false);
    expect(seenCodes).toEqual(cmds.map((cmd) => cmd.command));
    expect(seenCodes.join("\n")).not.toContain("2>&1");
    expect(outputs[0]).toContain("one stdout");
    expect(outputs[0]).toContain("one stderr");
    expect(outputs[1]).toContain("two stdout");
    expect(outputs[1]).toContain("two stderr");
  });

  test("passes cwd override to parallel shell executions (#756)", async () => {
    const seenCwds: Array<string | undefined> = [];
    const exec = mkMockExecutor((_code, _timeout, cwd) => {
      seenCwds.push(cwd);
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "pwd" },
      { label: "B", command: "git branch --show-current" },
    ];

    await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX, cwd: "/worktree/repo" },
      exec,
    );

    expect(seenCwds).toEqual(["/worktree/repo", "/worktree/repo"]);
  });

  test("order preservation: outputs match input order, not completion order", async () => {
    const exec = mkMockExecutor(async (code) => {
      // Reverse-order delay: first cmd is slowest
      const delay = code.includes("first") ? 80 : code.includes("second") ? 40 : 10;
      await new Promise((r) => setTimeout(r, delay));
      return { stdout: code.replace("echo ", "") };
    });
    const cmds: BatchCommand[] = [
      { label: "FIRST", command: "echo first" },
      { label: "SECOND", command: "echo second" },
      { label: "THIRD", command: "echo third" },
    ];
    const { outputs } = await runBatchCommands(cmds, { timeout: 5000, concurrency: 3, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(outputs[0]).toContain("# FIRST");
    expect(outputs[1]).toContain("# SECOND");
    expect(outputs[2]).toContain("# THIRD");
  });

  test("concurrency cap: 6 cmds at concurrency=2 never exceed 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = mkMockExecutor(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = Array.from({ length: 6 }, (_, i) => ({ label: `C${i}`, command: "x" }));
    await runBatchCommands(cmds, { timeout: 5000, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  test("per-command timeout: one cmd times out, siblings continue", async () => {
    const exec = mkMockExecutor((code) => {
      if (code.includes("slow")) return { stdout: "", timedOut: true };
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [
      { label: "slow", command: "sleep slow" },
      { label: "fast", command: "echo fast" },
    ];
    const { outputs, timedOut } = await runBatchCommands(cmds, { timeout: 100, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(timedOut).toBe(true);
    expect(outputs[0]).toContain("(timed out after 100ms)");
    expect(outputs[1]).toContain("ok");
  });

  test("concurrency exceeds cmd count: caps at cmd count, no spurious workers", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = mkMockExecutor(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [{ label: "A", command: "x" }, { label: "B", command: "y" }];
    await runBatchCommands(cmds, { timeout: 5000, concurrency: 8, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  test("FS bytes callback fires per-command in parallel branch", async () => {
    const exec = mkMockExecutor((code) => ({
      stdout: code.includes("a") ? "out a\n__CM_FS__:100\n" : "out b\n__CM_FS__:200\n",
    }));
    const cmds: BatchCommand[] = [
      { label: "A", command: "echo a" },
      { label: "B", command: "echo b" },
    ];
    let totalBytes = 0;
    const { outputs } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX, onFsBytes: (b) => { totalBytes += b; } },
      exec,
    );
    expect(totalBytes).toBe(300);
    // markers stripped from output
    expect(outputs.join("")).not.toContain("__CM_FS__");
  });
});


describe("runBatchCommands edge cases", () => {
  test("empty commands array returns empty outputs", async () => {
    const exec = mkMockExecutor(() => ({ stdout: "" }));
    const { outputs, timedOut } = await runBatchCommands([], { timeout: 1000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(outputs).toHaveLength(0);
    expect(timedOut).toBe(false);
  });

  test("empty stdout becomes (no output) sentinel", async () => {
    const exec = mkMockExecutor(() => ({ stdout: "" }));
    const cmds: BatchCommand[] = [{ label: "A", command: "x" }];
    const { outputs } = await runBatchCommands(cmds, { timeout: 1000, concurrency: 1, nodeOptsPrefix: NOOP_PREFIX }, exec);
    expect(outputs[0]).toContain("(no output)");
  });

  test("nodeOptsPrefix is prepended to each command", async () => {
    const seen: string[] = [];
    const exec = mkMockExecutor((code) => {
      seen.push(code);
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = [{ label: "A", command: "echo hi" }];
    await runBatchCommands(cmds, { timeout: 1000, concurrency: 1, nodeOptsPrefix: 'NODE_OPTIONS="--require /tmp/x" ' }, exec);
    expect(seen[0]).toBe('NODE_OPTIONS="--require /tmp/x" echo hi');
  });

  test("buildBatchNodeOptionsPrefix formats POSIX shell assignment", () => {
    const prefix = buildBatchNodeOptionsPrefix("bash", "/tmp/cm fs'preload.js");
    expect(prefix).toBe("NODE_OPTIONS='--require /tmp/cm fs'\\''preload.js' ");
  });

  test("buildBatchNodeOptionsPrefix formats PowerShell assignment", () => {
    const prefix = buildBatchNodeOptionsPrefix(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Temp\\cm ' fs.js",
    );
    expect(prefix).toBe("$env:NODE_OPTIONS='--require C:\\Temp\\cm '' fs.js'; ");
  });

  test("buildBatchNodeOptionsPrefix formats cmd assignment", () => {
    const prefix = buildBatchNodeOptionsPrefix(
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Temp\\cm-fs-preload.js",
    );
    expect(prefix).toBe('set "NODE_OPTIONS=--require C:\\Temp\\cm-fs-preload.js" && ');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// runBatchCommands hardening — P0 fixes per PRD-concurrency-architectural §0
// ═══════════════════════════════════════════════════════════════════════════

describe("runBatchCommands P0 hardening", () => {
  test("finding A: executor throw is isolated, siblings complete", async () => {
    // One worker's executor.execute() throws (e.g. spawn EAGAIN under load).
    // Without try/catch, Promise.all would reject and strand sibling outputs
    // as `undefined`, surfacing as the literal "undefined" after .join("\n").
    const exec = mkMockExecutor((code) => {
      if (code.includes("boom")) throw new Error("spawn EAGAIN");
      return { stdout: code.includes("a") ? "alpha" : code.includes("b") ? "beta" : "gamma" };
    });
    const cmds: BatchCommand[] = [
      { label: "A", command: "echo a" },
      { label: "BOOM", command: "echo boom" },
      { label: "B", command: "echo b" },
      { label: "C", command: "echo c" },
    ];
    const { outputs } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 4, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    expect(outputs).toHaveLength(4);
    expect(outputs[0]).toContain("# A");
    expect(outputs[0]).toContain("alpha");
    expect(outputs[1]).toContain("# BOOM");
    expect(outputs[1]).toContain("(executor error: spawn EAGAIN)");
    expect(outputs[2]).toContain("beta");
    expect(outputs[3]).toContain("gamma");
    // Critically: no `undefined` slots
    expect(outputs.every((o) => typeof o === "string" && o.length > 0)).toBe(true);
  });

  test("finding B: timed-out parallel command still strips __CM_FS__ markers + counts bytes", async () => {
    // Real subprocess timeouts often return partial stdout *with* the marker.
    // Pre-fix the parallel branch wrote the (timed out) sentinel directly,
    // bypassing formatCommandOutput → markers leaked into context, bytes uncounted.
    const exec = mkMockExecutor(() => ({
      stdout: "partial line 1\n__CM_FS__:512\npartial line 2\n",
      timedOut: true,
    }));
    let totalBytes = 0;
    const { outputs, timedOut } = await runBatchCommands(
      [{ label: "SLOW", command: "x" }],
      { timeout: 100, concurrency: 2, nodeOptsPrefix: NOOP_PREFIX, onFsBytes: (b) => { totalBytes += b; } },
      exec,
    );
    expect(timedOut).toBe(true);
    expect(totalBytes).toBe(512); // marker counted
    expect(outputs[0]).not.toContain("__CM_FS__"); // marker stripped
    expect(outputs[0]).toContain("partial line 1");
    expect(outputs[0]).toContain("partial line 2");
    expect(outputs[0]).toContain("(timed out after 100ms)"); // sentinel still appended
  });

  test("finding D: timing-regression — 5 cmds × 100ms at concurrency=5 finishes in <200ms", async () => {
    // Replaces the deleted bench (CONTRIBUTING.md L275 forbids new test files).
    // Asserts ≥3× speedup over serial. CI-checked.
    const exec = mkMockExecutor(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { stdout: "ok" };
    });
    const cmds: BatchCommand[] = Array.from({ length: 5 }, (_, i) => ({
      label: `C${i}`,
      command: "x",
    }));
    const start = Date.now();
    const { outputs, timedOut } = await runBatchCommands(
      cmds,
      { timeout: 5000, concurrency: 5, nodeOptsPrefix: NOOP_PREFIX },
      exec,
    );
    const elapsed = Date.now() - start;
    expect(timedOut).toBe(false);
    expect(outputs).toHaveLength(5);
    // Serial would be ~500ms (5×100). Parallel should be ~100ms + overhead.
    // Threshold 200ms gives generous CI room while still catching a regression to serial.
    expect(elapsed).toBeLessThan(200);
  });
});


describe("ctx_batch_execute query_scope (issue #696)", () => {
  const serverSrc = readServerSource();

  test("schema declares query_scope enum with batch default", () => {
    expect(serverSrc).toMatch(/query_scope:\s*z\s*\.enum\(\["batch",\s*"global"\]\)/);
    expect(serverSrc).toContain('.default("batch")');
  });

  test("schema describes both scope semantics", () => {
    expect(serverSrc).toMatch(/query_scope[\s\S]{0,2000}searches ONLY the chunks/i);
    expect(serverSrc).toMatch(/query_scope[\s\S]{0,2000}searches the entire persistent index/i);
  });

  test("formatBatchQueryResults default scope keeps batch-local tip", async () => {
    const { formatBatchQueryResults } = await import("../../src/server.js");
    const store = new ContentStore(":memory:");
    store.index({ content: "# Section A\n\nValidation of frontmatter is critical.\n", source: "batch:cmd1" });
    const lines = formatBatchQueryResults(store, ["validation"], "batch:cmd1");
    const text = lines.join("\n");
    expect(text).toMatch(/Results are scoped to this batch only/);
    expect(text).toMatch(/query_scope:\s*"global"/);
  });

  test("formatBatchQueryResults global scope drops batch tip and notes global scope", async () => {
    const { formatBatchQueryResults } = await import("../../src/server.js");
    const store = new ContentStore(":memory:");
    store.index({ content: "# Section A\n\nValidation of frontmatter is critical.\n", source: "other:source" });
    const lines = formatBatchQueryResults(store, ["validation"], "batch:cmd1", undefined, "global");
    const text = lines.join("\n");
    expect(text).toMatch(/query_scope:\s*"global"/);
    expect(text).not.toMatch(/Results are scoped to this batch only/);
  });
});
