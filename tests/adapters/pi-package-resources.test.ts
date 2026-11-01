import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// Pi recursively discovers SKILL.md under each directory selected by the manifest.
function discoverSkills(directory: string): { name: string; path: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return discoverSkills(path);
    if (entry.name !== "SKILL.md") return [];
    const name = readFileSync(path, "utf8").match(/^name:\s*(\S+)\s*$/m)?.[1];
    if (!name) throw new Error(`Skill has no name: ${path}`);
    return [{ name, path }];
  });
}

function isPackaged(path: string): boolean {
  return manifest.files.some((entry: string) => path === entry || path.startsWith(entry + "/"));
}

describe("Pi package resources", () => {
  it("discovers exactly one Pi-specific core skill and keeps every management skill", () => {
    const skills = manifest.pi.skills.flatMap((path: string) => discoverSkills(resolve(root, path)));
    expect(skills.filter((skill: { name: string }) => skill.name === "context-mode"))
      .toEqual([{ name: "context-mode", path: resolve(root, "configs/pi/skills/context-mode/SKILL.md") }]);
    const management = discoverSkills(resolve(root, "skills")).filter(skill => skill.name !== "context-mode");
    for (const skill of management) expect(skills).toContainEqual(skill);
    expect(new Set(skills.map((skill: { name: string }) => skill.name)).size).toBe(skills.length);
  });

  it("ships all selected skill and extension resources without replacing shared skills", () => {
    for (const path of [...manifest.pi.skills, ...manifest.pi.extensions]) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
      expect(isPackaged(path.replace(/^\.\//, "")), path).toBe(true);
    }
    expect(existsSync(resolve(root, "skills/context-mode/SKILL.md"))).toBe(true);
    expect(isPackaged("skills/context-mode/SKILL.md")).toBe(true);
  });
});
