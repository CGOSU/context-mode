import "../setup-home";
import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PiAdapter } from "../../src/adapters/pi/index.js";
import { hashProjectDirCanonical, resolveSessionDbPath } from "../../src/session/db.js";

describe("PiAdapter — Pi platform adapter", () => {
  let adapter: PiAdapter;

  beforeEach(() => {
    adapter = new PiAdapter();
  });

  // ── Identity ───────────────────────────────────────────

  describe("identity", () => {
    it("name is Pi", () => {
      expect(adapter.name).toBe("Pi");
    });

    it("paradigm is mcp-only (Pi hooks wire via extension.ts, not json-stdio)", () => {
      expect(adapter.paradigm).toBe("mcp-only");
    });
  });

  // ── Capabilities ───────────────────────────────────────
  // Pi adapter at the HookAdapter layer is MCP-only. Hook capabilities
  // are exercised through extension.ts's pi.on() bindings, not the
  // adapter's JSON-stdio parse/format methods.

  describe("capabilities", () => {
    it("all HookAdapter capabilities are false (extension wires hooks directly)", () => {
      expect(adapter.capabilities.preToolUse).toBe(false);
      expect(adapter.capabilities.postToolUse).toBe(false);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(false);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });
  });

  // ── Config paths — data isolation under ~/.pi/ ─────────
  // The OMP fix mirror for issue #473 — verify Pi data NEVER bleeds
  // into ~/.claude/ regardless of which harness installed context-mode.

  describe("config paths", () => {
    it("session dir is under ~/.pi/context-mode/sessions/", () => {
      expect(adapter.getSessionDir()).toBe(
        join(homedir(), ".pi", "context-mode", "sessions"),
      );
    });

    it("session DB path contains project hash and lives under .pi", () => {
      const dbPath = resolveSessionDbPath({ projectDir: "/test/project", sessionsDir: adapter.getSessionDir() });
      expect(dbPath).toMatch(/[a-f0-9]{16}\.db$/);
      expect(dbPath).toContain(".pi");
      expect(dbPath).not.toContain(".claude");
    });

    it("session events path contains project hash and lives under .pi", () => {
      const eventsPath = join(adapter.getSessionDir(), `${hashProjectDirCanonical("/test/project")}-events.md`);
      expect(eventsPath).toMatch(/[a-f0-9]{16}-events\.md$/);
      expect(eventsPath).toContain(".pi");
      expect(eventsPath).not.toContain(".claude");
    });

    it("settings path is ~/.pi/settings.json", () => {
      expect(adapter.getSettingsPath()).toBe(
        resolve(homedir(), ".pi", "settings.json"),
      );
    });

    it("config dir is ~/.pi", () => {
      expect(adapter.getConfigDir()).toBe(resolve(homedir(), ".pi"));
    });
  });

  // ── Instruction file ──────────────────────────────────
  // Pi convention: AGENTS.md (per configs/pi/AGENTS.md).

  describe("instruction files", () => {
    it("uses AGENTS.md (Pi convention)", () => {
      expect(adapter.getInstructionFiles()).toEqual(["AGENTS.md"]);
    });
  });

  // ── Hook config (no JSON-stdio hooks for Pi) ──────────

  describe("hook config", () => {
    it("generateHookConfig returns empty object", () => {
      expect(adapter.generateHookConfig("/some/plugin/root")).toEqual({});
    });

    it("configureAllHooks returns empty array", () => {
      expect(adapter.configureAllHooks("/some/plugin/root")).toEqual([]);
    });

    it("setHookPermissions returns empty array", () => {
      expect(adapter.setHookPermissions("/some/plugin/root")).toEqual([]);
    });
  });

  // ── readSettings / writeSettings — graceful when missing ─

  describe("settings I/O", () => {
    it("readSettings returns null when file missing (graceful)", () => {
      // Fresh fake HOME — no ~/.pi/settings.json yet
      expect(adapter.readSettings()).toBeNull();
    });

    it("writeSettings then readSettings round-trips", () => {
      adapter.writeSettings({ foo: "bar" });
      expect(adapter.readSettings()).toEqual({ foo: "bar" });
    });
  });
});
