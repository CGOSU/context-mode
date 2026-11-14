#!/usr/bin/env node
// Sync version from package.json to external manifest files (if any).
// Pi reads its version directly from package.json.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TARGETS = [];

function syncManifests() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = pkg.version;

  if (TARGETS.length === 0) {
    console.log(`✓ Pi-only package: version ${version} is authoritative in package.json`);
    return;
  }

  console.log(`→ syncing version ${version} to manifests...`);
  for (const file of TARGETS) {
    const content = JSON.parse(readFileSync(file, "utf8"));
    if (content.version !== undefined) content.version = version;
    writeFileSync(file, JSON.stringify(content, null, 2) + "\n");
    console.log(`  ✓ ${file}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncManifests();
}
