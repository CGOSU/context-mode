/** CLI knowledge implementation; importing this module never dispatches commands. */

import { existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, isAbsolute } from "node:path";
import { ensureWritableStorageDir, resolveContentStorageDir } from "./session/db.js";
import { ContentStore } from "./store.js";
import { readToolDenyPatterns, evaluateFilePath } from "./security.js";
// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const next = argv[i + 1];
    const value =
      inlineValue !== undefined
        ? inlineValue
        : next && !next.startsWith("--")
          ? (i++, next)
          : true;

    if (key === "include" || key === "exclude") {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [...prev, String(value)] : [String(value)];
    } else {
      flags[key] = value;
    }
  }

  return { positional, flags };
}

function stringFlag(flags: ParsedFlags["flags"], key: string): string | undefined {
  const v = flags[key];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function boolFlag(flags: ParsedFlags["flags"], key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function stringListFlag(flags: ParsedFlags["flags"], key: string): string[] | undefined {
  const v = flags[key];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string" && v.length > 0) return [v];
  return undefined;
}

function numberFlag(flags: ParsedFlags["flags"], key: string, opts: { min?: number } = {}): number | undefined {
  const raw = stringFlag(flags, key);
  if (!raw) return undefined;
  const n = Number(raw);
  const min = opts.min ?? 1;
  if (!Number.isInteger(n) || n < min) throw new Error(`--${key} must be an integer >= ${min}`);
  return n;
}

function extFlag(flags: ParsedFlags["flags"]): string[] | undefined {
  const raw = stringFlag(flags, "ext") ?? stringFlag(flags, "extensions");
  if (!raw) return undefined;
  const exts = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith(".") ? x : `.${x}`));
  return exts.length > 0 ? exts : undefined;
}

function resolveCliProjectDir(projectFlag: string | undefined, fallback: string): string {
  if (projectFlag) return resolve(projectFlag);
  return resolve(fallback);
}

async function openCliContentStore(projectDir: string): Promise<{ store: ContentStore; dbPath: string; contentDir: string }> {
  const adapter = await getAdapter(detectPlatform().platform);
  const contentStorage = resolveContentStorageDir(() => adapter.getSessionDir());
  const contentDir = ensureWritableStorageDir(contentStorage);
  const { resolveContentStorePath } = await import("./session/db.js");
  const dbPath = resolveContentStorePath({ projectDir, contentDir });
  return { store: new ContentStore(dbPath), dbPath, contentDir };
}

function defaultSourceForPath(absPath: string): string {
  try {
    if (statSync(absPath).isDirectory()) return `project:${basename(absPath) || absPath}`;
  } catch { /* path errors are reported by the index command */ }
  return absPath;
}

function assertReadAllowed(path: string, projectDir: string): void {
  const denyGlobs = readToolDenyPatterns("Read", projectDir);
  const denied = evaluateFilePath(path, denyGlobs, process.platform === "win32", projectDir);
  if (denied.denied) {
    throw new Error(`Read denied by policy: ${path}`);
  }
}

async function indexCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const target = parsed.positional[0];
    if (!target || target === "-h" || target === "--help") {
      console.log("Usage: context-mode index <path> [--source label] [--project path] [--max-files n] [--max-depth n] [--ext .ts,.md]");
      return target ? 0 : 1;
    }

    const absPath = isAbsolute(target) ? resolve(target) : resolve(process.cwd(), target);
    if (!existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);

    const st = statSync(absPath);
    const projectDir = resolveCliProjectDir(
      stringFlag(parsed.flags, "project"),
      st.isDirectory() ? absPath : dirname(absPath),
    );
    const source = stringFlag(parsed.flags, "source") ?? defaultSourceForPath(absPath);
    const { store, dbPath } = await openCliContentStore(projectDir);

    try {
      assertReadAllowed(absPath, projectDir);
      if (st.isDirectory()) {
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const result = store.indexDirectory({
          path: absPath,
          source,
          include: stringListFlag(parsed.flags, "include"),
          exclude: stringListFlag(parsed.flags, "exclude"),
          maxDepth: numberFlag(parsed.flags, "max-depth", { min: 0 }),
          maxFiles: numberFlag(parsed.flags, "max-files"),
          extensions: extFlag(parsed.flags),
          respectGitignore: !boolFlag(parsed.flags, "no-gitignore"),
          followSymlinks: boolFlag(parsed.flags, "follow-symlinks"),
          perFileDeny: (filePath) => {
            try {
              return evaluateFilePath(filePath, denyGlobs, process.platform === "win32", projectDir).denied;
            } catch {
              return false;
            }
          },
        });
        const cap = result.capped ? ` (cap reached at ${result.filesIndexed} files)` : "";
        const denied = result.denied > 0 ? `; ${result.denied} denied` : "";
        const failed = result.failed > 0 ? `; ${result.failed} failed` : "";
        console.log(`Indexed ${result.filesIndexed} files (${result.totalChunks} sections) from ${absPath}${cap}${denied}${failed}`);
      } else {
        const result = store.index({ path: absPath, source });
        console.log(`Indexed ${result.totalChunks} sections (${result.codeChunks} with code) from ${absPath}`);
      }
      console.log(`Source: ${source}`);
      console.log(`Project: ${projectDir}`);
      console.log(`DB: ${dbPath}`);
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`context-mode index: ${message}`);
    return 1;
  }
}

async function searchCommand(argv: string[]): Promise<number> {
  try {
    const parsed = parseFlags(argv);
    const query = parsed.positional.join(" ").trim();
    if (!query || query === "-h" || query === "--help") {
      console.log("Usage: context-mode search <query...> [--source label] [--project path] [--limit n] [--type code|prose]");
      return query ? 0 : 1;
    }

    const projectDir = resolveCliProjectDir(stringFlag(parsed.flags, "project"), process.cwd());
    const { store, dbPath } = await openCliContentStore(projectDir);
    try {
      const limit = numberFlag(parsed.flags, "limit") ?? 3;
      const type = stringFlag(parsed.flags, "type");
      if (type && type !== "code" && type !== "prose") throw new Error("--type must be code or prose");

      const results = store.searchWithFallback(
        query,
        limit,
        stringFlag(parsed.flags, "source"),
        type as "code" | "prose" | undefined,
      );
      if (results.length === 0) {
        console.log(`No matches for: ${query}`);
        console.log(`Project: ${projectDir}`);
        console.log(`DB: ${dbPath}`);
        return 0;
      }
      for (const [i, r] of results.entries()) {
        const content = r.content.replace(/\s+/g, " ").trim();
        const snippet = content.length > 500 ? `${content.slice(0, 500)}...` : content;
        console.log(`## ${i + 1}. ${r.title}`);
        console.log(`Source: ${r.source}`);
        console.log(`Type: ${r.contentType}`);
        console.log(snippet);
        console.log("");
      }
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`context-mode search: ${message}`);
    return 1;
  }
}

export { indexCommand, searchCommand };
