/** Executor regressions: sibling-mcp. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";


// ─────────────────────────────────────────────────────────
// Sibling MCP discovery — issue #559
// /ctx-upgrade must terminate previous-version MCP servers so they don't
// pile up across upgrades. discoverSiblingMcpPids enumerates node procs
// whose argv contains the plugin start.mjs path, excluding self + parent.
// ─────────────────────────────────────────────────────────
describe("discoverSiblingMcpPids (#559)", () => {
  test("parses pgrep output, filters own pid + ppid", async () => {
    const { discoverSiblingMcpPids } = await import("../../src/util/sibling-mcp.js");
    const ownPid = 11111;
    const ownPpid = 22222;
    // Mock pgrep returning four candidate PIDs, two of which are self/parent.
    const fakeRunner = (_cmd: string, _args: readonly string[]) =>
      `${ownPid}\n${ownPpid}\n33333\n44444\n`;
    const pids = discoverSiblingMcpPids({
      ownPid,
      ownPpid,
      platform: "linux",
      runCommand: fakeRunner,
    });
    assert.deepEqual(pids.sort((a, b) => a - b), [33333, 44444]);
  });

  test("returns empty array when discovery tool is absent (never throws)", async () => {
    const { discoverSiblingMcpPids } = await import("../../src/util/sibling-mcp.js");
    const pids = discoverSiblingMcpPids({
      ownPid: 1,
      ownPpid: 0,
      platform: "linux",
      runCommand: () => { throw new Error("ENOENT: pgrep not found"); },
    });
    assert.deepEqual(pids, []);
  });

  test("Windows branch parses CIM/WMI ProcessId column", async () => {
    const { discoverSiblingMcpPids } = await import("../../src/util/sibling-mcp.js");
    // PowerShell `Select-Object -ExpandProperty ProcessId` produces newline
    // separated integers. Some shells echo a header row — filter must skip it.
    const fakePs = (_cmd: string, _args: readonly string[]) =>
      "ProcessId\n----------\n55555\n66666\n";
    const pids = discoverSiblingMcpPids({
      ownPid: 1,
      ownPpid: 2,
      platform: "win32",
      runCommand: fakePs,
    });
    assert.deepEqual(pids.sort((a, b) => a - b), [55555, 66666]);
  });

  test("ignores blank lines and non-numeric noise", async () => {
    const { discoverSiblingMcpPids } = await import("../../src/util/sibling-mcp.js");
    const fakeRunner = (_cmd: string, _args: readonly string[]) =>
      "\n  \nnot-a-pid\n77777\n  88888  \n";
    const pids = discoverSiblingMcpPids({
      ownPid: 1,
      ownPpid: 2,
      platform: "linux",
      runCommand: fakeRunner,
    });
    assert.deepEqual(pids.sort((a, b) => a - b), [77777, 88888]);
  });
});


// ─────────────────────────────────────────────────────────
// killSiblingMcpServers — issue #559
// SIGTERM with timeout-based escalation to SIGKILL. Reports per-pid
// outcome so cli.ts can surface a human-readable summary.
// ─────────────────────────────────────────────────────────
describe("killSiblingMcpServers (#559)", () => {
  test("escalates to SIGKILL after timeout when SIGTERM is ignored", async () => {
    const { killSiblingMcpServers } = await import("../../src/util/sibling-mcp.js");
    // Fake liveness map: pid -> array of remaining alive checks before death.
    // pid 1: dies after 1 alive check (responds to SIGTERM).
    // pid 2: never dies via SIGTERM, only after SIGKILL is sent.
    const aliveCheckCounts = new Map<number, number>([[1, 1], [2, 999]]);
    const sigKilled = new Set<number>();
    const sigTermSent: number[] = [];
    const isAlive = (pid: number): boolean => {
      // After SIGKILL, the process is dead.
      if (sigKilled.has(pid)) return false;
      const remaining = aliveCheckCounts.get(pid) ?? 0;
      if (remaining <= 0) return false;
      aliveCheckCounts.set(pid, remaining - 1);
      return true;
    };
    const sendSignal = (pid: number, sig: NodeJS.Signals): void => {
      if (sig === "SIGKILL") sigKilled.add(pid);
      if (sig === "SIGTERM") sigTermSent.push(pid);
    };
    const report = await killSiblingMcpServers({
      pids: [1, 2],
      timeoutMs: 50,
      pollIntervalMs: 10,
      isAlive,
      sendSignal,
    });
    assert.deepEqual(sigTermSent.sort((a, b) => a - b), [1, 2]);
    assert.equal(report.terminatedBySigterm, 1);
    assert.equal(report.terminatedBySigkill, 1);
    assert.equal(report.totalKilled, 2);
  });

  test("returns zero counts and never throws on empty input", async () => {
    const { killSiblingMcpServers } = await import("../../src/util/sibling-mcp.js");
    const report = await killSiblingMcpServers({
      pids: [],
      timeoutMs: 10,
      pollIntervalMs: 5,
      isAlive: () => false,
      sendSignal: () => { throw new Error("should not be called"); },
    });
    assert.equal(report.totalKilled, 0);
    assert.equal(report.terminatedBySigterm, 0);
    assert.equal(report.terminatedBySigkill, 0);
  });

  test("swallows ESRCH from sendSignal (process already gone)", async () => {
    const { killSiblingMcpServers } = await import("../../src/util/sibling-mcp.js");
    const report = await killSiblingMcpServers({
      pids: [99999999],
      timeoutMs: 20,
      pollIntervalMs: 5,
      isAlive: () => false,
      sendSignal: () => {
        const e: NodeJS.ErrnoException = new Error("ESRCH") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      },
    });
    // Process was already dead — counts as 0 since we never observed it alive.
    assert.equal(report.totalKilled, 0);
  });
});
