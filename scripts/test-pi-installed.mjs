// Optional integration check against the locally installed Pi SDK (tested with 1.5.0).
// Runs real package discovery, sessions, hooks, tool execution and compaction with an
// in-memory fake model. All state lives in a temporary HOME; no provider requests occur.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--sdk")) {
  throw new Error("Usage: node scripts/test-pi-installed.mjs [--sdk /path/to/pi-coding-agent]");
}
const managed = join(homedir(), ".pi", "agent", "install");
const sdk = args.length ? resolve(args[1]) : join(managed, "releases",
  readFileSync(join(managed, "current-version"), "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent");
const sdkEntry = join(sdk, "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "context-mode-pi-live-"));
const home = join(root, "home");
const cwd = join(root, "workspace");
const agentDir = join(home, ".pi", "agent");
const pkg = join(root, "package");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd);
Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
  CONTEXT_MODE_DATA_DIR: join(home, ".context-mode"),
  XDG_DATA_HOME: join(home, ".local", "share"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") });
delete process.env.PI_CONTEXT_MODE_AUTO_MEMORY;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("Network is disabled in the local Pi integration check");
};
let session;
try {
  execFileSync(process.execPath, ["scripts/build-pi.mjs", "--out", pkg], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime,
    createToolSearchExtension } = await import(pathToFileURL(sdkEntry));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(sdk, "..", "pi-ai", "dist", "utils", "event-stream.js")));
  const { getModel } = await import(pathToFileURL(join(sdk, "..", "pi-ai", "dist", "compat.js")));
  const model = getModel("anthropic", "claude-sonnet-4-5");
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  // Pi's prompt preflight requires configured auth even when the model stream is a fake.
  // This is a test placeholder stored only in the temporary runtime, never a real credential.
  await modelRuntime.setRuntimeApiKey("anthropic", "local-test-placeholder");
  const settingsManager = SettingsManager.inMemory({ packages: [pkg], retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1000 }, defaultProjectTrust: "always" });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  ({ session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    sessionManager: manager, thinkingLevel: "off", noTools: "builtin" }));
  const requests = [];
  let plan = [];
  let index = 0;
  function response(content, stopReason) {
    const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: stopReason, message });
    });
    return stream;
  }
  const fakeStream = (_model, context) => {
    requests.push(structuredClone(context));
    const next = plan[index++] ?? null;
    return next ? response([{ type: "toolCall", id: "call-" + requests.length, name: next.name, arguments: next.args }], "toolUse")
      : response([{ type: "text", text: "LOCAL_FAKE_MODEL_OK" }], "stop");
  };
  async function bind() {
    session.agent.streamFunction = fakeStream;
    await session.bindExtensions({});
  }
  async function prompt(text, calls = []) {
    plan = calls;
    index = 0;
    await session.prompt(text);
    const errors = session.messages.filter(message => message.role === "assistant" && message.stopReason === "error");
    assert.deepEqual(errors, []);
  }
  const lastResult = name => session.messages.filter(message => message.role === "toolResult" && message.toolName === name).at(-1);
  await bind();
  await prompt("Run the local test", [{ name: "ctx_execute", args: { language: "javascript",
    code: 'console.log("LIVE_TAIL_EVIDENCE " + "x".repeat(15000))', maxOutputChars: 1000 } }]);
  const result = lastResult("ctx_execute");
  assert.equal(result.isError, false);
  assert.ok(result.content[0].text.length <= 1000);
  assert.ok(result.details.previewSource);
  await prompt("Find preserved output", [{ name: "ctx_search", args: {
    queries: ["LIVE_TAIL_EVIDENCE"], source: result.details.previewSource, maxOutputChars: 1000 } }]);
  assert.match(lastResult("ctx_search").content[0].text, /LIVE_TAIL_EVIDENCE/);
  assert.equal(session.getActiveToolNames().filter(name => name.startsWith("ctx_")).length, 9);

  await prompt("Run intentional local failure", [{ name: "ctx_execute", args: { language: "javascript",
    code: 'console.error("LOCAL_EXPECTED_FAILURE"); process.exitCode = 7;', maxOutputChars: 1000 } }]);
  const failed = lastResult("ctx_execute");
  assert.equal(failed.isError, true);
  assert.equal(failed.details.exitCode, 7, "Pi must preserve structured details on failed tool calls");
  assert.match(failed.content[0].text, /LOCAL_EXPECTED_FAILURE/);

  await prompt("ACTIVE_BRANCH_MEMORY keep the verified green requirement");
  const branchAnchor = manager.getLeafId();
  await prompt("ABANDONED_BRANCH_MEMORY delete the green requirement");
  await session.navigateTree(branchAnchor, { summarize: false });
  await prompt("Inspect current memory", [{ name: "ctx_resume", args: {} }]);
  assert.match(lastResult("ctx_resume").content[0].text, /ACTIVE_BRANCH_MEMORY/);
  assert.doesNotMatch(lastResult("ctx_resume").content[0].text, /ABANDONED_BRANCH_MEMORY/);
  await session.compact();
  assert.ok(manager.getEntries().some(entry => entry.customType === "context-mode-resume-v2"));
  const file = manager.getSessionFile();
  session.dispose();
  const reloadLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await reloadLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager,
    resourceLoader: reloadLoader, sessionManager: SessionManager.open(file), thinkingLevel: "off", noTools: "builtin" }));
  await bind();
  const beforeReload = requests.length;
  await prompt("Continue after restarting this local session");
  const afterReload = JSON.stringify(requests.slice(beforeReload));
  assert.match(afterReload, /<session_resume/);
  assert.match(afterReload, /ACTIVE_BRANCH_MEMORY/);
  assert.doesNotMatch(afterReload, /ABANDONED_BRANCH_MEMORY/);
  const beforeSecond = requests.length;
  await prompt("Continue once more");
  assert.doesNotMatch(JSON.stringify(requests.slice(beforeSecond)), /<session_resume/);

  session.dispose();
  const discoverySettings = SettingsManager.inMemory({ packages: [pkg], compaction: { enabled: false },
    retry: { enabled: false }, defaultTools: ["+tool_search"] });
  const discoveryLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: discoverySettings,
    extensionFactories: [createToolSearchExtension()] });
  await discoveryLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager: discoverySettings,
    resourceLoader: discoveryLoader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off" }));
  await bind();
  await prompt("Prime discovery");
  const hidden = session.getAllTools().filter(tool => tool.name.startsWith("ctx_") && tool.exposure === "deferred")
    .map(tool => tool.name).sort();
  assert.deepEqual(hidden, ["ctx_doctor", "ctx_purge", "ctx_stats", "ctx_upgrade"]);
  await prompt("Discover maintenance status", [{ name: "tool_search", args: { query: "ctx_stats", limit: 1 } }]);
  assert.match(lastResult("tool_search").content[0].text, /ctx_stats/);
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({ ok: true, piVersion: JSON.parse(readFileSync(join(sdk, "package.json"))).version,
    packageVersion: JSON.parse(readFileSync(join(pkg, "package.json"))).version, loadedExtensions: 1,
    toolResultChars: result.content[0].text.length, failureMetadata: true, branchMemory: true,
    compactionReload: true, exactlyOnceResume: true, discovery: true, networkAttempts }));
} finally {
  session?.dispose();
  rmSync(root, { recursive: true, force: true });
}
