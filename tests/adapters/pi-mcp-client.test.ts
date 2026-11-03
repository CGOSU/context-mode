import "../setup-home";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
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


// Slice 2 — env depth counter
describe("MCP bridge spawn — passes CONTEXT_MODE_BRIDGE_DEPTH=1 to child env (#516)", () => {
  it("child process inherits CONTEXT_MODE_BRIDGE_DEPTH=1", async () => {
    // Fake server that prints the depth env var and exits.
    const fakePath = join(scratch, "echo-depth.mjs");
    writeFileSync(
      fakePath,
      `process.stdout.write(JSON.stringify({ depth: process.env.CONTEXT_MODE_BRIDGE_DEPTH }) + "\\n");
       setInterval(() => {}, 1000);`,
      "utf-8",
    );

    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient(fakePath);
    client.start();

    // Pluck the live env that was passed into spawn — exposed for tests.
    const live = (client as unknown as { _spawnEnv?: NodeJS.ProcessEnv })._spawnEnv;
    expect(live?.CONTEXT_MODE_BRIDGE_DEPTH).toBe("1");

    client.shutdown();
  });
});


// Slice 5 — broken-pipe hardening during stdio writes
//
// Regression: if the MCP child closed its stdin after replying to
// initialize but before the bridge sent notifications/initialized,
// notify() could throw `write EPIPE` synchronously. Because initialize()
// calls notify() after the awaited request resolves, that exception
// escaped as a Pi-level uncaughtException and terminated the session.
describe("MCPStdioClient — handles EPIPE when writing to child stdin", () => {
  it("does not throw when an initialize notification hits a broken pipe", async () => {
    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient("/unused/server.mjs");
    const epipe = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
      errno: -32,
      syscall: "write",
    });

    (client as unknown as { child: unknown }).child = {
      stdin: {
        destroyed: false,
        writableEnded: false,
        closed: false,
        write: () => {
          throw epipe;
        },
      },
    };

    expect(() => client.notify("notifications/initialized", {})).not.toThrow();
    expect((client as unknown as { exited: boolean }).exited).toBe(true);
  });

  it("rejects a request instead of throwing when the write hits a broken pipe", async () => {
    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient("/unused/server.mjs");
    const epipe = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
      errno: -32,
      syscall: "write",
    });

    (client as unknown as { child: unknown }).child = {
      stdin: {
        destroyed: false,
        writableEnded: false,
        closed: false,
        write: () => {
          throw epipe;
        },
      },
    };

    await expect(client.request("tools/list", {}, 100)).rejects.toThrow(
      "MCP server exited",
    );
    expect((client as unknown as { exited: boolean }).exited).toBe(true);
  });

  it("rejects async stdin write callback errors without process-level uncaught exceptions", async () => {
    const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-bridge.js");
    const client = new MCPStdioClient("/unused/server.mjs");
    const stdin = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      writableEnded: boolean;
      closed: boolean;
      write: (_data: string, cb: (err?: NodeJS.ErrnoException) => void) => boolean;
    };
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.closed = false;
    stdin.write = (_data, cb) => {
      queueMicrotask(() => {
        cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      });
      return false;
    };

    (client as unknown as { child: unknown }).child = { stdin };

    await expect(client.request("tools/list", {}, 100)).rejects.toThrow(
      "MCP server exited",
    );
    expect((client as unknown as { exited: boolean }).exited).toBe(true);
  });
});


// ── #868: keep the FOREGROUND interactive session's bridge alive ──
// The #854 idle reaper must NOT reap the foreground child (a 3-min pause
// shouldn't drop the user's ctx_* tools), while sub-context / non-interactive
// children keep the reaper so abandoned ones still can't accumulate (#854).
describe("foreground keep-alive — idle reaper scoped by session kind (#868)", () => {
  it("isForegroundSession reads ctx.hasUI with a fail-safe default of foreground", async () => {
    const { isForegroundSession } = await import("../../src/adapters/pi/mcp-bridge.js");
    expect(isForegroundSession({ hasUI: true })).toBe(true);   // interactive foreground
    expect(isForegroundSession({ hasUI: false })).toBe(false); // subagent / print / rpc
    expect(isForegroundSession({})).toBe(true);                // ambiguous -> keep alive
    expect(isForegroundSession(undefined)).toBe(true);         // no ctx -> keep alive
    expect(isForegroundSession(null)).toBe(true);
  });

  it("foregroundBridgeEnv disables the reaper (IDLE_MS=0) for foreground, leaves sub-contexts on", async () => {
    const { foregroundBridgeEnv } = await import("../../src/adapters/pi/mcp-bridge.js");
    const base = { CONTEXT_MODE_BRIDGE_DEPTH: "1", PATH: "/x" };
    const fg = foregroundBridgeEnv(base, true);
    expect(fg.CONTEXT_MODE_BRIDGE_IDLE_MS).toBe("0"); // #868: never idle-reaped
    expect(fg.PATH).toBe("/x");                        // base preserved
    expect(base.CONTEXT_MODE_BRIDGE_IDLE_MS).toBeUndefined(); // no mutation of input
    const sub = foregroundBridgeEnv(base, false);
    expect(sub.CONTEXT_MODE_BRIDGE_IDLE_MS).toBeUndefined(); // #854: sub keeps the reaper
  });

  it("a foreground bridge child inherits CONTEXT_MODE_BRIDGE_IDLE_MS=0 in its spawn env", async () => {
    const { MCPStdioClient, foregroundBridgeEnv } = await import(
      "../../src/adapters/pi/mcp-bridge.js"
    );
    const serverPath = join(scratch, "fake-idle-server.mjs");
    writeFileSync(serverPath, "process.stdin.resume();\n"); // inert child; we only inspect env
    const env = foregroundBridgeEnv(
      { ...process.env, CONTEXT_MODE_BRIDGE_DEPTH: "1" },
      true,
    );
    const client = new MCPStdioClient(serverPath, env, process.execPath);
    client.start();
    const live = (client as unknown as { _spawnEnv?: NodeJS.ProcessEnv })._spawnEnv;
    expect(live?.CONTEXT_MODE_BRIDGE_IDLE_MS).toBe("0");
    client.shutdown();
  });
});


  // ── Unit: MCPStdioClient framing & lifecycle ──────────────────────

  describe("MCPStdioClient", () => {
    it("matches request id to response result over newline-delimited JSON", async () => {
      const fakePath = writeFakeServer(`
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              result: { echoed: msg.method, params: msg.params },
            }) + "\\n");
          }
        });
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const r1 = await client.request("tools/list", { foo: 1 });
        expect(r1).toEqual({ echoed: "tools/list", params: { foo: 1 } });
        const r2 = await client.request("tools/call", { bar: 2 });
        expect(r2).toEqual({ echoed: "tools/call", params: { bar: 2 } });
      } finally {
        client.shutdown();
      }
    });

    it("matches concurrent in-flight requests by id (out-of-order responses)", async () => {
      // Reverse delays so the slowest goes first — exercises the id-map
      // dispatch, not just FIFO ordering.
      const fakePath = writeFakeServer(`
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            const delay = msg.params?.delay ?? 0;
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0", id: msg.id, result: { id: msg.id },
              }) + "\\n");
            }, delay);
          }
        });
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const promises = [50, 40, 30, 20, 10].map((delay, i) =>
          client.request<{ id: number }>("probe", { delay, idx: i }),
        );
        const results = await Promise.all(promises);
        expect(results).toHaveLength(5);
        for (const r of results) expect(typeof r.id).toBe("number");
      } finally {
        client.shutdown();
      }
    });

    it("rejects in-flight requests when the child exits", async () => {
      const fakePath = writeFakeServer(`
        process.stdin.once("data", () => process.exit(0));
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      const promise = client.request("tools/list", {});
      await expect(promise).rejects.toThrow(/exited|MCP/);
      client.shutdown();
    });

    it("times out instead of hanging on a silent server", async () => {
      const fakePath = writeFakeServer(`
        process.stdin.on("data", () => {});
        setInterval(() => {}, 1000);
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        await expect(
          client.request("tools/list", {}, 200),
        ).rejects.toThrow(/timeout/);
      } finally {
        client.shutdown();
      }
    });

    it("ignores non-JSON stdout lines without crashing the parser", async () => {
      const fakePath = writeFakeServer(`
        process.stdout.write("[some startup banner]\\n");
        process.stdout.write("not valid json {{{\\n");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null) continue;
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
          }
        });
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const client = new MCPStdioClient(fakePath);
      client.start();
      try {
        const r = await client.request<{ ok: boolean }>("ping", {});
        expect(r.ok).toBe(true);
      } finally {
        client.shutdown();
      }
    });
  });
describe("MCPStdioClient stderr diagnostics", () => {

    it("routes child stderr to pi.logger, NOT the TUI terminal (case 1: crash diagnostics; #472 intent / #868)", async () => {
      // Server writes a diagnostic line to stderr then exits non-zero,
      // mimicking a real crash during initialize. With stdio[2] = "ignore"
      // the diagnostic vanishes (#472). We keep capturing it — but route it
      // through `diag` (Pi's file logger), NEVER process.stderr, because Pi's
      // raw-mode TUI renders any console write into the editor box (#868).
      const fakePath = writeFakeServer(`
        process.stderr.write("FAKE_MCP_CRASH_DIAG: bundle corrupted at line 42\\n");
        process.exit(1);
      `);
      const { MCPStdioClient } = await import("../../src/adapters/pi/mcp-client.js");
      const logged: string[] = [];
      const client = new MCPStdioClient(fakePath, process.env, null, (line) =>
        logged.push(line),
      );

      // Guard: nothing the child writes may reach process.stderr (Pi's TUI).
      const stderrCaptured: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // @ts-expect-error monkeypatch
      process.stderr.write = (chunk: any, ...rest: any[]) => {
        stderrCaptured.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
        return origWrite(chunk, ...rest);
      };

      try {
        client.start();
        // Give the child time to write its diag line and exit.
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        // @ts-expect-error restore
        process.stderr.write = origWrite;
        client.shutdown();
      }

      const all = logged.join("\n");
      // #472 intent preserved: the crash diagnostic is captured (now in the log)…
      expect(all.includes("FAKE_MCP_CRASH_DIAG")).toBe(true);
      // …with the [mcp-bridge] prefix so ops can grep ~/.omp/logs.
      expect(all.includes("[mcp-bridge]")).toBe(true);
      // #868: it must NOT have been written to the terminal.
      expect(stderrCaptured.join("").includes("FAKE_MCP_CRASH_DIAG")).toBe(false);
    }, 10_000);
});
