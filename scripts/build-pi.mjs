#!/usr/bin/env node
// Build the local Pi distribution separately from the upstream source/release version.
// The staged tree is self-contained; a failed build leaves the selected installation intact.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutPackageJson } from "../build/manifests.ts";
import { writeHashes } from "../build/hash.mjs";
import { rewriteReadmeLinks } from "../build/readme.mjs";
import { isReleaseVersion } from "./release/release-tags.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const source = readJson(path.join(root, "package.json"));
const version = source.piBuild?.version;
const upstreamVersion = source.piBuild?.upstreamVersion;

function destination(args) {
  if (args.length === 0) return path.join(root, "release-out");
  if (args.length === 2 && args[0] === "--out" && args[1] !== "") return path.resolve(args[1]);
  throw new Error("Usage: npm run build:pi -- [--out <directory>]");
}

function assertReplaceable(out) {
  if (out === root || root.startsWith(out + path.sep)) throw new Error("Output cannot contain the source checkout");
  if (!existsSync(out)) return;
  if (lstatSync(out).isSymbolicLink() || !lstatSync(out).isDirectory()) throw new Error("Output must be a real directory");
  if (readdirSync(out).length === 0) return;
  try {
    const pkg = readJson(path.join(out, "package.json"));
    assertOutPackageJson(pkg);
    if (!existsSync(path.join(out, "SHA256SUMS"))) throw new Error("missing build hashes");
  } catch {
    throw new Error("Refusing to replace a directory that is not a context-mode release build");
  }
}

function validate(out) {
  const pkg = readJson(path.join(out, "package.json"));
  assertOutPackageJson(pkg);
  if (pkg.version !== version) throw new Error("Built package version does not match piBuild.version");
  for (const entry of [...pkg.pi.extensions, ...pkg.pi.skills]) {
    if (!existsSync(path.resolve(out, entry))) throw new Error("Missing Pi resource: " + entry);
  }
}

function build(out) {
  if (!isReleaseVersion(version) || !isReleaseVersion(upstreamVersion) || version === upstreamVersion) {
    throw new Error("piBuild needs distinct valid version and upstreamVersion values");
  }
  assertReplaceable(out);
  mkdirSync(path.dirname(out), { recursive: true });
  const stage = mkdtempSync(path.join(path.dirname(out), ".context-mode-pi-build-"));
  let previous;
  try {
    const result = spawnSync(process.execPath, [path.join(root, "build/build.mjs"), "--out", stage, "--version", version], {
      cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "Upstream build failed");
    // The custom version is local, not an upstream tag. Keep upstream documentation links usable.
    const notice = "# CGOSU Pi custom build\n\n" +
      "Installed version: `" + version + "`. Upstream source baseline: `" + upstreamVersion + "`.\n\n" +
      "This is a local Pi distribution with CGOSU adaptations. Keep a single context-mode package source enabled. " +
      "Rebuild it from the migration checkout with `npm run build:pi`; updating the official npm package does not preserve these adaptations.\n\n";
    writeFileSync(path.join(stage, "README.md"), notice + rewriteReadmeLinks(readFileSync(path.join(root, "README.md"), "utf8"), upstreamVersion));
    writeHashes(stage);
    validate(stage);
    // Validate again immediately before replacement in case another process touched the destination.
    assertReplaceable(out);
    if (existsSync(out)) {
      previous = stage + "-previous";
      renameSync(out, previous);
    }
    try {
      renameSync(stage, out);
    } catch (err) {
      if (previous) renameSync(previous, out);
      previous = undefined;
      throw err;
    }
    if (previous) rmSync(previous, { recursive: true, force: true });
    process.stdout.write("Built Pi package " + version + " at " + out + "\n");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

try {
  build(destination(process.argv.slice(2)));
} catch (err) {
  process.stderr.write("Pi build failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exitCode = 1;
}
