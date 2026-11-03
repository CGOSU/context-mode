import "../setup-home";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeMcpServer } from "../helpers/pi-mcp-server.js";


let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-forkbomb-"));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  delete process.env.CONTEXT_MODE_BRIDGE_DEPTH;
});
const writeFakeServer = (source: string) => writeFakeMcpServer(scratch, source);


// Slice 6 — respawn after MCP child exit (#583)
//
// Regression: when the Pi-spawned child exits cleanly while Pi keeps the
// previously-registered tool handles, the bridge client has
// `exited=true` and every subsequent request rejects with
// "MCP server has exited". The user sees a permanently broken set of
// `ctx_*` tools until they restart Pi.
//
// Fix: when `callTool()` is invoked on an exited client, respawn the
// MCP child + re-`initialize()` transparently before issuing the call,
// so already-registered Pi tools recover on the very next use.
describe("MCPStdioClient — respawns after MCP child exit (#583)", () => {
  it("re-spawns the child when callTool is invoked after exit, and the call succeeds", async () => {
    // Fake MCP server: handles initialize, tools/list, tools/call.
    // On its FIRST process incarnation it exits cleanly after the first
    // tools/call — mirroring a clean MCP child shutdown. A marker file on disk distinguishes the original child from
    // the respawned one so the second incarnation stays alive.
    const markerPath = join(scratch, "first-incarnation-marker");
    const fakePath = join(scratch, "exit-after-call.mjs");
    writeFileSync(
      fakePath,
      `
      import { existsSync, writeFileSync } from "node:fs";
      const MARKER = ${JSON.stringify(markerPath)};
      const isFirst = !existsSync(MARKER);
      let line = "";
      let callCount = 0;
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/list") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] } }) + "\\n");
          } else if (msg.method === "tools/call") {
            callCount++;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-pid-" + process.pid }] } }) + "\\n");
            // First incarnation: mimic clean MCP child shutdown after one call.
            if (isFirst && callCount === 1) {
              writeFileSync(MARKER, "1");
              setTimeout(() => process.exit(0), 10);
            }
          }
        }
      });
      // Keep the event loop alive until stdin closes / we exit.
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // First call: succeeds, then the fake server exits cleanly.
    const r1 = await client.callTool("ping", {});
    const t1 = r1.content?.[0]?.text ?? "";
    expect(t1).toMatch(/^pong-pid-/);
    const pid1 = t1.replace(/^pong-pid-/, "");

    // Wait for the child to actually exit so the client observes onExit.
    await new Promise<void>((resolve) => {
      const wait = () => {
        if ((client as unknown as { exited: boolean }).exited) return resolve();
        setTimeout(wait, 25);
      };
      wait();
    });

    // Second call: MUST NOT reject with "MCP server has exited" — the
    // client should respawn and re-initialize transparently.
    const r2 = await client.callTool("ping", {});
    const t2 = r2.content?.[0]?.text ?? "";
    expect(t2).toMatch(/^pong-pid-/);
    const pid2 = t2.replace(/^pong-pid-/, "");
    // New PID proves a fresh child was spawned, not the original.
    expect(pid2).not.toBe(pid1);

    client.shutdown();
  }, 15_000);
});


// ── #583 follow-up: hardening on top of the original respawn-on-exit fix ──
//
// The original #583 patch put the respawn guard in `callTool()` only.
// The follow-up moves it into `request()` (covering `tools/list` and
// `initialize` paths after idle exit) AND adds a single-flight guard so
// concurrent callers don't each spawn their own child and leak orphans.
describe("MCPStdioClient — request() respawns for any method after idle exit (#583 follow-up)", () => {
  it("listTools() after an idle exit triggers respawn (not just callTool)", async () => {
    // Fake server: exits after the FIRST tools/list response. The bridge
    // must respawn on the next listTools() invocation — proving the
    // respawn guard fires for `tools/list`, not only `tools/call`.
    const markerPath = join(scratch, "first-incarnation-marker-list");
    const fakePath = join(scratch, "exit-after-list.mjs");
    writeFileSync(
      fakePath,
      `
      import { existsSync, writeFileSync } from "node:fs";
      const MARKER = ${JSON.stringify(markerPath)};
      const isFirst = !existsSync(MARKER);
      let line = "";
      let listCount = 0;
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/list") {
            listCount++;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping-pid-" + process.pid, description: "p", inputSchema: { type: "object" } }] } }) + "\\n");
            if (isFirst && listCount === 1) {
              writeFileSync(MARKER, "1");
              setTimeout(() => process.exit(0), 10);
            }
          }
        }
      });
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // First listTools: original incarnation responds, then exits.
    const tools1 = await client.listTools();
    expect(tools1).toHaveLength(1);
    const pid1 = tools1[0].name.replace(/^ping-pid-/, "");

    // Wait for the child to actually exit.
    await new Promise<void>((resolve) => {
      const wait = () => {
        if ((client as unknown as { exited: boolean }).exited) return resolve();
        setTimeout(wait, 25);
      };
      wait();
    });

    // Second listTools: should respawn + re-init, NOT reject. Bug class:
    // pre-fix, this would reject with "MCP server has exited" because the
    // respawn guard lived in callTool only and tools/list went straight
    // through request().
    const tools2 = await client.listTools();
    expect(tools2).toHaveLength(1);
    const pid2 = tools2[0].name.replace(/^ping-pid-/, "");
    expect(pid2).not.toBe(pid1);

    client.shutdown();
  }, 15_000);

  it("concurrent callTool() invocations after exit share ONE respawn (no orphan children)", async () => {
    // Failure mode without the single-flight guard: caller A and caller B
    // both observe `this.exited === true`, both invoke respawn(), each
    // spawns a child. The loser of the race overwrites `this.child` and
    // its child becomes an orphan with no `.kill()` reference.
    //
    // The fake server marks every PID it spawns under a directory. After
    // two concurrent calls, exactly ONE new PID should be observed.
    const markerPath = join(scratch, "first-incarnation-marker-concurrent");
    const pidsDir = join(scratch, "spawned-pids-concurrent");
    const fakePath = join(scratch, "exit-after-call-concurrent.mjs");
    writeFileSync(
      fakePath,
      `
      import { existsSync, writeFileSync, mkdirSync } from "node:fs";
      import { join as joinPath } from "node:path";
      const MARKER = ${JSON.stringify(markerPath)};
      const PIDS_DIR = ${JSON.stringify(pidsDir)};
      mkdirSync(PIDS_DIR, { recursive: true });
      // Record this process pid the moment we boot — covers both the
      // first incarnation AND any respawned child.
      writeFileSync(joinPath(PIDS_DIR, String(process.pid)), "1");
      const isFirst = !existsSync(MARKER);
      let line = "";
      let callCount = 0;
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/list") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] } }) + "\\n");
          } else if (msg.method === "tools/call") {
            callCount++;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-" + process.pid }] } }) + "\\n");
            if (isFirst && callCount === 1) {
              writeFileSync(MARKER, "1");
              setTimeout(() => process.exit(0), 10);
            }
          }
        }
      });
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // First call: original incarnation responds and exits.
    await client.callTool("ping", {});

    // Wait for exit.
    await new Promise<void>((resolve) => {
      const wait = () => {
        if ((client as unknown as { exited: boolean }).exited) return resolve();
        setTimeout(wait, 25);
      };
      wait();
    });

    // Now fire TWO callTool invocations simultaneously — both see
    // `this.exited === true`. Without single-flight, both would call
    // respawn(), each spawning its own child. With single-flight, only
    // one child should be spawned and both calls share it.
    const [r1, r2] = await Promise.all([
      client.callTool("ping", {}),
      client.callTool("ping", {}),
    ]);
    const respPid1 = (r1.content?.[0]?.text ?? "").replace(/^pong-/, "");
    const respPid2 = (r2.content?.[0]?.text ?? "").replace(/^pong-/, "");
    // Both calls must resolve through the SAME respawned child.
    expect(respPid1).toBe(respPid2);

    // Filesystem evidence: exactly two pids ever marked (original +
    // one respawn). If two respawns raced, we'd see 3 pid files.
    const { readdirSync } = await import("node:fs");
    const recordedPids = readdirSync(pidsDir);
    expect(recordedPids).toHaveLength(2);

    client.shutdown();
  }, 20_000);

  it("respawn() resets state in the documented order — `exited=false` BEFORE initialize()", async () => {
    // Pin the sequencing contract called out in respawn()'s JSDoc.
    // If a future refactor moves `this.exited = false` to AFTER
    // `await this.initialize()`, the recursive request("initialize", ...)
    // inside respawn would see `exited === true` and re-enter respawn
    // forever (infinite loop, not just a stale reject).
    //
    // We exercise the path: state ALL clears before initialize fires.
    const fakePath = join(scratch, "introspect-respawn.mjs");
    writeFileSync(
      fakePath,
      `
      let line = "";
      process.stdin.on("data", (chunk) => {
        line += chunk.toString("utf-8");
        let idx;
        while ((idx = line.indexOf("\\n")) >= 0) {
          const raw = line.slice(0, idx).trim();
          line = line.slice(idx + 1);
          if (!raw) continue;
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) + "\\n");
          } else if (msg.method === "tools/call") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
          }
        }
      });
      setInterval(() => {}, 60000);
      `,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();
    await client.initialize();

    // Force the exited flag, then trigger a callTool — request() should
    // run respawn, which must reset state before initialize() fires.
    const internal = client as unknown as {
      exited: boolean;
      initialized: boolean;
      child: unknown;
    };

    // Mark it as exited manually (simulating the post-onExit state
    // without actually killing the child — keeps test deterministic).
    internal.exited = true;

    // callTool must succeed via the respawn path. If `exited` is not
    // cleared before the recursive request("initialize", ...) call,
    // this hangs forever and the test times out at the per-it limit.
    const res = await client.callTool("ping", {});
    expect((res.content?.[0]?.text ?? "")).toBe("ok");

    // Post-call invariants — proves respawn finished cleanly.
    expect(internal.exited).toBe(false);
    expect(internal.initialized).toBe(true);
    expect(internal.child).not.toBeNull();

    client.shutdown();
  }, 15_000);
});


// ── Slice 8 — callTool MUST NOT impose its own timeout (#643) ──
//
// Reported in #643: the bridge enforced a hardcoded 120s ceiling on
// every `tools/call`, so long-running `ctx_execute` (test suites, builds,
// large `cargo test`) failed at the bridge layer with
//   "MCP request timeout after 120000ms: tools/call"
// even though the executor child would have finished.
//
// Mert's directive (no env var, no hardcode bump): REMOVE the timeout
// for `tools/call` entirely. Preserve the 60s bound on
// initialize/tools-list (bootstrap hang detection — legit timeout case).
// The trade-off (a deliberately hung MCP child during tools/call hangs
// the call indefinitely) is accepted: it belongs to the executor /
// child layer, not to the bridge. Background mode and Pi-level cancel
// remain the user-facing escape hatches.
//
// These tests pin the contract behaviorally via fake timers — advancing
// >120s while a `tools/call` is in flight MUST NOT reject it. The
// initialize path still rejects at 60s by default (regression guard).
describe("MCPStdioClient — callTool has no bridge-imposed timeout (#643)", () => {
  it("callTool does not reject when bridge clock advances past the old 120s ceiling", async () => {
    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient("/unused/server.mjs");
    const stdin = {
      destroyed: false,
      writableEnded: false,
      closed: false,
      write: (_data: string, cb?: (err?: Error) => void) => {
        cb?.();
        return true;
      },
    };
    (client as unknown as { child: unknown }).child = { stdin };

    vi.useFakeTimers();
    try {
      const inFlight = client.callTool("ping", {});
      // Suppress unhandledrejection while we observe pending state.
      const settled: { value: "resolved" | "rejected" | null } = { value: null };
      void inFlight.then(
        () => {
          settled.value = "resolved";
        },
        () => {
          settled.value = "rejected";
        },
      );

      // Advance well past the old DEFAULT_CALL_TIMEOUT_MS = 120_000ms
      // ceiling. Before the fix this rejects with "MCP request timeout
      // after 120000ms". After the fix the bridge installs no timer for
      // tools/call, so the promise stays pending.
      vi.advanceTimersByTime(300_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled.value).toBe(null);

      // Now feed the response — proves the call still resolves cleanly
      // when the server eventually replies, no matter how late.
      const id = (client as unknown as { requestId: number }).requestId;
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "late-but-fine" }] },
      });
      (client as unknown as {
        onData: (b: Buffer) => void;
      }).onData(Buffer.from(response + "\n", "utf-8"));

      const r = await inFlight;
      expect(r.content?.[0]?.text).toBe("late-but-fine");
    } finally {
      vi.useRealTimers();
    }
  });

  it("initialize still rejects at the 60s default timeout (regression guard)", async () => {
    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient("/unused/server.mjs");
    const stdin = {
      destroyed: false,
      writableEnded: false,
      closed: false,
      write: (_data: string, cb?: (err?: Error) => void) => {
        cb?.();
        return true;
      },
    };
    (client as unknown as { child: unknown }).child = { stdin };

    vi.useFakeTimers();
    try {
      const inFlight = client.initialize();
      const rejection = inFlight.catch((err) => err);

      // Default request timeout for initialize is 60_000ms; advancing
      // past it MUST cause the request to reject. This pins the bound
      // that #643 explicitly preserves.
      vi.advanceTimersByTime(60_001);
      const err = await rejection;
      expect(String(err)).toMatch(/MCP request timeout after 60000ms: initialize/);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("MCPStdioClient spawn failure recovery", () => {
  it("rejects the failed handshake and serves requests after a real runtime becomes available", async () => {
    const runtime = await import("../../src/runtime.js");
    const detected = runtime.detectRuntimes();
    const detect = vi.spyOn(runtime, "detectRuntimes").mockReturnValue({
      ...detected,
      javascript: join(scratch, "missing-runtime"),
    });
    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
    const server = writeFakeServer(`
      let buffer = "";
      process.stdin.on("data", chunk => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (message.method === "initialize" || message.method === "tools/list") {
            const result = message.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: {} }
              : { tools: [{ name: "ctx_recovered" }] };
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
          }
        }
      });
    `);
    const client = new MCPStdioClient(server);
    try {
      client.start();
      await expect(client.initialize()).rejects.toThrow();
      detect.mockReturnValue({ ...detected, javascript: process.execPath });
      expect(await client.listTools()).toEqual([{ name: "ctx_recovered" }]);
    } finally {
      client.shutdown();
      detect.mockRestore();
    }
  });
});

describe("MCPStdioClient bounded shutdown", () => {


    it.skipIf(process.platform === "win32")("escalates to SIGKILL when SIGTERM is ignored (case 2: bounded shutdown)", async () => {
      // Windows has no POSIX signal delivery: child.kill('SIGTERM') maps to
      // TerminateProcess (unblockable), and child.kill('SIGKILL') hits the
      // same syscall. The fake server's `process.on('SIGTERM', ...)` handler
      // never fires, so the SIGKILL-escalation contract that this test pins
      // is fundamentally unobservable on win32. POSIX (Linux/macOS) coverage
      // is sufficient for the resilience guarantee.
      // Child explicitly ignores SIGTERM and refuses to exit. Without a
      // SIGKILL fallback the process leaks indefinitely.
      // Also ignore stdin 'end'/'close' so closing the pipe doesn't end
      // the process — only SIGKILL should be able to terminate this.
      // Emit "READY" on stdout once handlers are registered so the test
      // does not race the spawn (otherwise SIGTERM arrives during Node
      // bootstrap before our handler is registered → default terminate).
      const fakePath = writeFakeServer(`
        process.on("SIGTERM", () => { /* deliberately ignore */ });
        process.on("SIGINT", () => { /* deliberately ignore */ });
        process.on("SIGHUP", () => { /* deliberately ignore */ });
        process.stdin.on("end", () => { /* stay alive */ });
        process.stdin.on("close", () => { /* stay alive */ });
        process.stdin.on("data", () => {});
        setInterval(() => {}, 1000);
        process.stdout.write("READY\\n");
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const client = new MCPStdioClient(fakePath);
      client.start();

      // Reach into the private child handle for the assertion. Tests
      // already do this elsewhere and the field is the only way to
      // observe the OS-level lifecycle without a polling sentinel.
      const childRef: any = (client as any).child;
      expect(childRef).toBeTruthy();
      expect(childRef.killed).toBe(false);

      // Wait for "READY" — confirms SIGTERM handler is installed.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child never READY")), 3000);
        childRef.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf-8").includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        childRef.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
          resolve({ code, signal });
        });
      });

      const t0 = Date.now();
      client.shutdown();

      // Bounded by the 5s SIGKILL timer — give it a small grace window.
      const result = await Promise.race([
        exitPromise.then((r) => ({ ...r, timedOut: false })),
        new Promise<{ code: null; signal: null; timedOut: true }>((r) =>
          setTimeout(() => r({ code: null, signal: null, timedOut: true }), 7500),
        ),
      ]);
      const elapsedMs = Date.now() - t0;

      // Must NOT have timed out — that would mean no SIGKILL fallback.
      expect(result.timedOut).toBe(false);
      // Killed by signal (SIGKILL) — Node's behavior across platforms:
      // signal field populated when killed by signal.
      expect(result.signal).toBe("SIGKILL");
      // Bounded at ~5s — assert lower bound (escalation, not immediate)
      // and upper bound (not hung beyond the 5s ceiling + grace).
      expect(elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(elapsedMs).toBeLessThan(7000);
    }, 15_000);
});
