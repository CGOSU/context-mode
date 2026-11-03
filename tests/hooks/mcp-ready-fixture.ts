/** Per-suite sentinel ownership; never writes into a real MCP server's directory. */
import { beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function useMcpReadyFixture(beforeTest?: () => void) {
  const previousDir = process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  const _sentinelDir = mkdtempSync(join(tmpdir(), "ctx-test-sentinels-"));
  process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = _sentinelDir;
  const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

  beforeEach(() => {
    beforeTest?.();
    writeFileSync(mcpSentinel, String(process.pid));
  });
  afterEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });
  afterAll(() => {
    try { rmSync(_sentinelDir, { recursive: true, force: true }); } catch {}
    if (previousDir === undefined) delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
    else process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = previousDir;
  });
  return { _sentinelDir, mcpSentinel };
}
