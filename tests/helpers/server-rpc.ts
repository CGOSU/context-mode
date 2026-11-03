/** Server regressions: rpc-helper. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// ctx_doctor resource cleanup regression (#247)
// ═══════════════════════════════════════════════════════════════════════════

export const mcpEntry = resolve(__dirname, "..", "..", "start.mjs");


export interface DoctorJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    serverInfo?: { name: string; version: string };
  };
  error?: { code: number; message: string };
}


export function startMcpServer(extraEnv: Record<string, string> = {}): ChildProcess {
  const root = mkdtempSync(join(tmpdir(), "ctx-server-rpc-"));
  const proc = spawn("node", [mcpEntry], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      CONTEXT_MODE_DIR: join(root, "storage"),
      CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
      ...extraEnv,
    },
  });
  proc.once("close", () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return proc;
}


export function sendRpc(proc: ChildProcess, msg: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}


/**
 * Read RPC responses from the server stdout until all `expectedIds` have
 * arrived or `timeoutMs` elapses, whichever comes first. Early-exit keeps
 * the happy path at <1s and gives Windows CI its full timeout budget when
 * process spawn + native-module load runs slow.
 */
export function collectRpcResponses(
  proc: ChildProcess,
  timeoutMs: number,
  expectedIds: number[],
): Promise<DoctorJsonRpcResponse[]> {
  return new Promise((res) => {
    const expected = new Set(expectedIds);
    const seen = new Map<number, DoctorJsonRpcResponse>();
    let buffer = "";
    let timer: ReturnType<typeof setTimeout>;

    let finishing = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    proc.once("close", () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      res(Array.from(seen.values()));
    });
    const finish = () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
      }, 2_000);
      killTimer.unref();
    };

    proc.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString();
      // Drain whole lines from the buffer. Stdout is newline-delimited JSON-RPC.
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
          if (typeof parsed.id === "number" && expected.has(parsed.id)) {
            seen.set(parsed.id, parsed);
            if (seen.size === expected.size) {
              finish();
              return;
            }
          }
        } catch { /* ignore malformed / partial lines */ }
      }
    });

    timer = setTimeout(finish, timeoutMs);
  });
}


export async function initAndCallDoctor(
  proc: ChildProcess,
  invocations: number,
  windowMs = 15_000,
): Promise<DoctorJsonRpcResponse[]> {
  sendRpc(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-doctor-regression", version: "1.0" } },
  });
  sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  const ids: number[] = [];
  for (let i = 0; i < invocations; i++) {
    const id = 100 + i;
    ids.push(id);
    sendRpc(proc, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ctx_doctor", arguments: {} } });
  }
  return collectRpcResponses(proc, windowMs, ids);
}
