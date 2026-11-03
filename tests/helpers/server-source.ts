/** Static contract inspection only: never imports/starts the MCP composition root. */
import { readFileSync } from "node:fs";

const modules = [
  "server", "server-snippets", "server-execution-options", "server-input",
  "server-execution", "server-index", "server-search", "server-fetch-code",
  "server-fetch", "server-batch", "server-stats", "server-maintenance",
  "server-purge", "server-browser",
];

export function readServerSource(): string {
  return modules.map(name => readFileSync(new URL("../../src/" + name + ".ts", import.meta.url), "utf8")).join("\n");
}
