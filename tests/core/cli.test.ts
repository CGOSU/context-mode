import { readServerSource } from "../helpers/server-source.js";
import { readCliSource } from "../helpers/cli-source.js";
import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

describe("Cross-OS compatibility", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  const src = readCliSource();

  it("build script does not shell out to POSIX chmod command", () => {
    expect(pkg.scripts.build).not.toMatch(/\bchmod\s+\+x\b/);
  });

  it("postinstall script uses node for cross-platform compatibility", () => {
    expect(pkg.scripts.postinstall).not.toMatch(/\[ -n/);
    expect(pkg.scripts.postinstall).not.toContain("printf");
    expect(pkg.scripts.postinstall).toMatch(/^node /);
    expect(pkg.files).toContain("scripts/postinstall.mjs");
  });

  it("cli.ts chmodSync in upgrade is guarded by platform check", () => {
    const chmodIdx = src.indexOf("chmodSync(binPath");
    expect(chmodIdx).toBeGreaterThan(-1);
    const contextBefore = src.slice(Math.max(0, chmodIdx - 500), chmodIdx);
    expect(contextBefore).toMatch(/process\.platform\s*!==\s*["']win32["']/);
  });
});

describe("Bin entry uses cli.bundle.mjs", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

  it("package.json bin points to cli.bundle.mjs, not build/cli.js", () => {
    expect(pkg.bin["context-mode"]).toBe("./cli.bundle.mjs");
  });

  it("package.json exports ./cli points to cli.bundle.mjs", () => {
    expect(pkg.exports["./cli"]).toBe("./cli.bundle.mjs");
  });

  it("server.ts ctx_doctor runs diagnostics in-process (no CLI dependency)", () => {
    const src = readServerSource();
    const doctorSection = src.slice(src.indexOf("ctx_doctor"), src.indexOf("ctx_upgrade"));
    expect(doctorSection).not.toContain('node "');
    expect(doctorSection).toContain("PolyglotExecutor");
    expect(doctorSection).toContain("FTS5");
  });

  it("server.ts ctx_upgrade uses cli.bundle.mjs with fallback", () => {
    const src = readServerSource();
    const upgradeStart = src.indexOf('server.registerTool(\n  "ctx_upgrade"');
    const upgradeEnd = src.indexOf("// ── ctx-purge", upgradeStart);
    const upgradeSection = src.slice(upgradeStart, upgradeEnd);
    expect(upgradeSection).toContain("cli.bundle.mjs");
  });

  it("server.ts registers empty prompts/resources handlers to avoid -32601 (#168)", () => {
    const src = readServerSource();
    expect(src).toContain("ListPromptsRequestSchema");
    expect(src).toContain("ListResourcesRequestSchema");
    expect(src).toContain("prompts: []");
    expect(src).toContain("resources: []");
  });
});

describe("SKILL.md prefers MCP tool over Bash", () => {
  it("ctx-doctor SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    expect(skill).toContain("ctx_doctor");
    expect(skill).toContain("MCP tool");
    const mcpIdx = skill.indexOf("ctx_doctor");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });

  it("ctx-upgrade SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    expect(skill).toContain("ctx_upgrade");
    expect(skill).toContain("MCP tool");
    const mcpIdx = skill.indexOf("ctx_upgrade");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });
});

describe("Pi package exports", () => {
  it("package.json pi.extensions and main point to Pi extension bundle", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    expect(pkg.main).toBe("./build/adapters/pi/extension.js");
    expect(pkg.exports["."]).toBe("./build/adapters/pi/extension.js");
    expect(pkg.pi?.extensions).toContain("./build/adapters/pi/extension.js");
  });
});
