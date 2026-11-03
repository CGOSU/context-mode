/** Fake stdio-server source writer; callers own their isolated directory and cleanup. */
import { join } from "node:path";

export function writeFakeMcpServer(directory: string, source: string): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = join(directory, `fake-mcp-${Date.now()}-${Math.random()}.mjs`);
    fs.writeFileSync(path, source, "utf-8");
    return path;
  }
