import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowed = new Set(["--server-only", "--extension-only", "--outdir"]);
let outdir = root;
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown build option: ${args[i]}`);
  if (args[i] === "--outdir") {
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--outdir requires a directory");
    outdir = resolve(args[++i]);
  }
}
if (args.includes("--server-only") && args.includes("--extension-only")) {
  throw new Error("Choose at most one partial build mode");
}
const common = { absWorkingDir: root, bundle: true, platform: "node", target: "node18", format: "esm", minify: true, logLevel: "info" };
if (!args.includes("--extension-only")) {
  await build({ ...common, entryPoints: ["src/server.ts"], outfile: resolve(outdir, "server.bundle.mjs"), external: ["better-sqlite3", "turndown", "turndown-plugin-gfm", "@mixmark-io/domino"] });
}
if (!args.includes("--server-only")) {
  await build({ ...common, entryPoints: ["src/adapters/pi/extension.ts"], outfile: resolve(outdir, "build/adapters/pi/extension.js"), packages: "external" });
}
// The extension loads this source helper dynamically; esbuild cannot include it.
if (!args.includes("--server-only") && outdir !== root) {
  await mkdir(resolve(outdir, "hooks"), { recursive: true });
  await copyFile(resolve(root, "hooks/auto-injection.mjs"), resolve(outdir, "hooks/auto-injection.mjs"));
}
