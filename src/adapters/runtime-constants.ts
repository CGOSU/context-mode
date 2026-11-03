/** Shared runtime/platform facts; independent of command construction and detection. */
/** Known JS runtime binary names (base filename without extension). */
export const JS_RUNTIMES: ReadonlySet<string> = new Set(["node", "bun", "deno"]);

/** Platforms where context-mode runs as an in-process TS plugin (not MCP stdio). */
export const IN_PROCESS_PLUGIN_PLATFORMS: ReadonlySet<string> = new Set(["opencode", "kilo"]);

export function isInProcessPluginPlatform(p: string | undefined): boolean {
  return !!p && IN_PROCESS_PLUGIN_PLATFORMS.has(p);
}
