import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Read the CLI implementation without importing its command-dispatch side effects. */
export function readCliSource(): string {
  const root = resolve(import.meta.dirname, "../..");
  return [
    "cli-shared", "cli-hooks", "cli", "cli-knowledge", "cli-doctor",
    "cli-insight", "cli-upgrade", "cli-statusline",
  ].map((name) => readFileSync(resolve(root, "src", name + ".ts"), "utf8")).join("\n");
}
