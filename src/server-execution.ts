import { z } from "zod";
import { classifyNonZeroExit } from "./exit-classify.js";
import { coerceBoolean } from "./server-input.js";
import { resolveExecTimeout, buildExecuteEcho } from "./server-execution-options.js";
import type { ServerToolContext } from "./server.js";

export function registerExecutionTools(context: ServerToolContext): void {
  const { server, bunNote, langList, checkDenyPolicy, checkNonShellDenyPolicy, executor, sessionStats, trackResponse, trackIndexed, getStore, currentAttribution, checkProjectBoundary, checkFilePathDenyPolicy } = context;


// ─────────────────────────────────────────────────────────
// Tool: execute
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute",
  {
    // #852: surface code execution in the host approval prompt's title (the
    // only server-controlled field the MCP permission UI renders besides args).
    title: "Run code in a sandbox (executes the supplied code)",
    // #846: runs arbitrary code in a sandbox with full network access.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Run code in a sandboxed subprocess.${bunNote} Languages: ${langList}.

Think-in-Code — the core philosophy: the bytes your code processes never enter your conversation memory; only what you console.log() does. Reading a 700 KB log directly means 700 KB of your remaining reasoning capacity gets spent on raw bytes. Running code over that same log in this sandbox and printing a 3 KB summary leaves you with 697 KB of capacity for the actual work.

Concrete shape — analyze 47 source files without reading any of them:
  ctx_execute(language: "javascript", code: \`
    const fs = require('fs');
    const files = fs.readdirSync('src').filter(f => f.endsWith('.ts'));
    files.forEach(f => {
      const lines = fs.readFileSync('src/'+f,'utf8').split('\\\\n').length;
      console.log(f + ': ' + lines + ' lines');
    });
  \`)
  // 47 files analyzed, 15,314 LoC summarized — output ~3.6 KB instead of 47 Read() calls = ~700 KB.

WHEN:
  - You intend to derive an answer FROM data (filter, count, aggregate, parse, compare, transform) — do the derivation in code and print only the answer
  - Output shape or size cannot be predicted before execution (recursive finds, repo-wide greps, list endpoints, query results, log scans)
  - You would otherwise read raw output and then mentally compute — that compute belongs here, in code, where its inputs stay out of your conversation
  - You need to keep a long-running process alive (dev server, watcher, daemon) — pass \`background: true\` to detach on timeout instead of killing the process
  - The output may legitimately be large but you only want recall-by-topic later — pass an \`intent\` string; outputs over ~5KB are auto-indexed into the knowledge base and only the section titles + previews come back, retrievable via ctx_search

WHEN NOT:
  - Single observational command whose entire short output you intend to consume verbatim (whoami, pwd, git status on a clean tree) — Bash is simpler
  - File mutations (Edit/Write) or navigation (cd/ls) — Bash is the right surface
  - You already know the output is one short fixed line and you want to read it as-is

RETURNS:
  Only what your code prints. Wrap risky calls in try/catch — uncaught errors go to stderr and may leak more than intended. When \`intent\` is set and output exceeds the auto-index threshold, the response carries searchable section titles + previews instead of the raw stdout; use ctx_search(queries: [...]) to drill into specific sections.

EXAMPLE: ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('npm test', {encoding:'utf8', stdio:['ignore','pipe','pipe']}); console.log(out.split('\\\\n').filter(l => /(FAIL|✗|×|Error:|Tests +.*(failed|passed))/i.test(l)).slice(0, 60).join('\\\\n'))")
EXAMPLE: ctx_execute(language: "javascript", code: "const out = require('child_process').execSync('gh issue list --json number,title --limit 100', {encoding:'utf8'}); const hooks = JSON.parse(out).filter(i => /hook|routing/i.test(i.title)); console.log(\`\${hooks.length} hook-related issues\`)")`,
    inputSchema: z.object({
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
          "csharp",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), IO.puts (Elixir), or Console.WriteLine (C#) to output a summary to context.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs (which is the right layer for this policy). Pass an explicit value for long-running builds (Gradle/Maven/SBT)."),
      // background: wrapped in coerceBoolean preprocessor so the literal
      // strings "true"/"false" arriving from OpenCode's native plugin
      // bridge (and several LLM providers' tool-call JSON) parse as the
      // boolean the handler expects. z.coerce.boolean() is unsafe here —
      // Boolean("false") is true. Fixes #627.
      background: z
        .preprocess(coerceBoolean, z.boolean())
        .optional()
        .default(false)
        .describe("Keep process running after timeout (for servers/daemons). Returns partial output without killing the process. IMPORTANT: Do NOT add setTimeout/self-close timers in background scripts — the process must stay alive until the timeout detaches it. For server+fetch patterns, prefer putting both server and fetch in ONE ctx_execute call instead of using background."),
      cwd: z
        .string()
        .optional()
        .describe("Optional working directory for shell commands. Non-shell languages still execute from their sandbox temp directory."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "indexes output into knowledge base and returns section titles + previews — not full content. " +
          "Use ctx_search(queries: [...]) to retrieve specific sections. Example: 'failing tests', 'HTTP 500 errors'." +
          "\n\nTIP: Use specific technical terms, not just concepts. Check 'Searchable terms' in the response for available vocabulary.",
        ),
    }),
  },
  async ({ language, code, timeout, background, cwd, intent }) => {
    // Security: deny-only firewall
    if (language === "shell") {
      const denied = checkDenyPolicy(code, "execute");
      if (denied) return denied;
    } else {
      const denied = checkNonShellDenyPolicy(code, language, "execute");
      if (denied) return denied;
    }

    try {
      // For JS/TS: wrap in async IIFE with fetch + http/https interceptors to track network bytes
      let instrumentedCode = code;
      if (language === "javascript" || language === "typescript") {
        // Wrap user code in a closure that shadows CJS require with http/https interceptor.
        // globalThis.require does NOT work because CJS require is module-scoped, not global.
        // The closure approach (function(__cm_req){ var require=...; })(require) correctly
        // shadows the CJS require for all code inside, including __cm_main().
        instrumentedCode = `
// FS read instrumentation — count bytes read via fs.readFileSync/readFile
let __cm_fs=0;
process.on('exit',()=>{if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch{}});
(function(){
  try{
    var f=typeof require!=='undefined'?require('fs'):null;
    if(!f)return;
    var ors=f.readFileSync;
    f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};
    var orf=f.readFile;
    if(orf)f.readFile=function(){var a=Array.from(arguments),cb=a.pop();orf.apply(this,a.concat([function(e,d){if(!e&&d){if(Buffer.isBuffer(d))__cm_fs+=d.length;else if(typeof d==='string')__cm_fs+=Buffer.byteLength(d);}cb(e,d);}]));};
  }catch{}
})();
let __cm_net=0;
// Report network bytes on process exit — works with both promise and callback patterns.
// process.on('exit') fires after all I/O completes, unlike .finally() which fires
// when __cm_main() resolves (immediately for callback-based http.get without await).
process.on('exit',()=>{if(__cm_net>0)try{process.stderr.write('__CM_NET__:'+__cm_net+'\\n')}catch{}});
;(function(__cm_req){
// Intercept globalThis.fetch
const __cm_f=globalThis.fetch;
globalThis.fetch=async(...a)=>{const r=await __cm_f(...a);
try{const cl=r.clone();const b=await cl.arrayBuffer();__cm_net+=b.byteLength}catch{}
return r};
// Shadow CJS require with http/https network tracking.
const __cm_hc=new Map();
const __cm_hm=new Set(['http','https','node:http','node:https']);
function __cm_wf(m,origFn){return function(...a){
  const li=a.length-1;
  if(li>=0&&typeof a[li]==='function'){const oc=a[li];a[li]=function(res){
    res.on('data',function(c){__cm_net+=c.length});oc(res);};}
  const req=origFn.apply(m,a);
  const oOn=req.on.bind(req);
  req.on=function(ev,cb,...r){
    if(ev==='response'){return oOn(ev,function(res){
      res.on('data',function(c){__cm_net+=c.length});cb(res);
    },...r);}
    return oOn(ev,cb,...r);
  };
  return req;
}}
var require=__cm_req?function(id){
  const m=__cm_req(id);
  if(!__cm_hm.has(id))return m;
  const k=id.replace('node:','');
  if(__cm_hc.has(k))return __cm_hc.get(k);
  const w=Object.create(m);
  if(typeof m.get==='function')w.get=__cm_wf(m,m.get);
  if(typeof m.request==='function')w.request=__cm_wf(m,m.request);
  __cm_hc.set(k,w);return w;
}:__cm_req;
if(__cm_req){if(__cm_req.resolve)require.resolve=__cm_req.resolve;
if(__cm_req.cache)require.cache=__cm_req.cache;}
async function __cm_main(){
${code}
}
__cm_main().catch(e=>{console.error(e);process.exitCode=1});${background ? '\nsetInterval(()=>{},2147483647);' : ''}
})(typeof require!=='undefined'?require:null);`;
      }
      const effTimeout = resolveExecTimeout(timeout);
      const result = await executor.execute({ language, code: instrumentedCode, timeout: effTimeout, background, cwd });

      // Echo the executed source code before stdout so users can audit
      // and tooling can block command patterns (Issues #717 + #736).
      // Built from the user-supplied `code`, NOT the instrumented variant.
      const echo = buildExecuteEcho(language, code, undefined, server.server.getClientVersion());

      // Parse sandbox network metrics from stderr
      const netMatch = result.stderr?.match(/__CM_NET__:(\d+)/);
      if (netMatch) {
        sessionStats.bytesSandboxed += parseInt(netMatch[1]);
        // Clean the metric line from stderr
        result.stderr = result.stderr.replace(/\n?__CM_NET__:\d+\n?/g, "");
      }

      // Parse sandbox FS read metrics from stderr
      const fsMatch = result.stderr?.match(/__CM_FS__:(\d+)/);
      if (fsMatch) {
        sessionStats.bytesSandboxed += parseInt(fsMatch[1]);
        result.stderr = result.stderr.replace(/\n?__CM_FS__:\d+\n?/g, "");
      }

      if (result.timedOut) {
        const partialOutput = result.stdout?.trim();
        if (result.backgrounded && partialOutput) {
          // Background mode: process is still running, return partial output as success
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput}\n\n_(process backgrounded after ${effTimeout}ms — still running)_`,
              },
            ],
          });
        }
        if (partialOutput) {
          // Timeout with partial output — return as success with note
          return trackResponse("ctx_execute", {
            content: [
              {
                type: "text" as const,
                text: `${echo}${partialOutput}\n\n_(timed out after ${effTimeout}ms — partial output shown above)_`,
              },
            ],
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            {
              type: "text" as const,
              text: `${echo}Execution timed out after ${effTimeout}ms\n\nstderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `execute:${language}:error` : `execute:${language}`)}` },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `execute:${language}:error` : `execute:${language}`)}` },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      // Intent-driven search: if intent provided and output is large enough
      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute", {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `execute:${language}`)}` },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `execute:${language}`);
        // Prepend echo to the first text content so provenance still surfaces
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return trackResponse("ctx_execute", echoed);
      }

      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);


// ─────────────────────────────────────────────────────────
// Helper: index stdout into FTS5 knowledge base
// ─────────────────────────────────────────────────────────

function indexStdout(
  stdout: string,
  source: string,
): { content: Array<{ type: "text"; text: string }> } {
  const store = getStore();
  trackIndexed(Buffer.byteLength(stdout));
  const indexed = store.index({ content: stdout, source, attribution: currentAttribution() });
  return {
    content: [
      {
        type: "text" as const,
        text: `Indexed ${indexed.totalChunks} sections (${indexed.codeChunks} with code) from: ${indexed.label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.label}" to scope results.`,
      },
    ],
  };
}


// ─────────────────────────────────────────────────────────
// Helper: intent-driven search on execution output
// ─────────────────────────────────────────────────────────

const INTENT_SEARCH_THRESHOLD = 5_000;
 // bytes — ~80-100 lines
const LARGE_OUTPUT_THRESHOLD = 102_400;
 // 100KB — auto-index into FTS5, return pointer

function intentSearch(
  stdout: string,
  intent: string,
  source: string,
  maxResults: number = 5,
): string {
  const totalLines = stdout.split("\n").length;
  const totalBytes = Buffer.byteLength(stdout);

  // Index into the PERSISTENT store so user can ctx_search() later
  const persistent = getStore();
  const indexed = persistent.indexPlainText(stdout, source, undefined, currentAttribution());

  // Search the persistent store directly (porter → trigram → fuzzy)
  let results = persistent.searchWithFallback(intent, maxResults, source);

  // Extract distinctive terms as vocabulary hints for the LLM
  const distinctiveTerms = persistent.getDistinctiveTerms(indexed.sourceId);

  if (results.length === 0) {
    const lines = [
      `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
      `No sections matched intent "${intent}" in ${totalLines}-line output (${(totalBytes / 1024).toFixed(1)}KB).`,
    ];
    if (distinctiveTerms.length > 0) {
      lines.push("");
      lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
    }
    lines.push("");
    lines.push("Use ctx_search(queries: [...]) to explore the indexed content.");
    return lines.join("\n");
  }

  // Return ONLY titles + first-line previews — not full content
  const lines = [
    `Indexed ${indexed.totalChunks} sections from "${source}" into knowledge base.`,
    `${results.length} sections matched "${intent}" (${totalLines} lines, ${(totalBytes / 1024).toFixed(1)}KB):`,
    "",
  ];

  for (const r of results) {
    const preview = r.content.split("\n")[0].slice(0, 120);
    lines.push(`  - ${r.title}: ${preview}`);
  }

  if (distinctiveTerms.length > 0) {
    lines.push("");
    lines.push(`Searchable terms: ${distinctiveTerms.join(", ")}`);
  }

  lines.push("");
  lines.push("Use ctx_search(queries: [...]) to retrieve full content of any section.");

  return lines.join("\n");
}


// ─────────────────────────────────────────────────────────
// Tool: execute_file
// ─────────────────────────────────────────────────────────

server.registerTool(
  "ctx_execute_file",
  {
    // #852: the host's MCP approval prompt renders only the tool name/title +
    // raw args — the title is the one server-controlled signal, so make it
    // unambiguously announce code execution + file read for the reviewer.
    title: "Run code over a file (executes code, reads the given path)",
    // #846: runs arbitrary code over a file in a sandbox with full network access.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Read a file into a sandboxed FILE_CONTENT variable and run code over it. Only what you console.log() enters your conversation — the file bytes stay in the sandbox.

Think-in-Code applied to file-level analysis: Reading the whole file means every byte enters your conversation memory and costs reasoning capacity for the rest of the session. Running code over it here lets you keep the raw bytes out and only the derived answer in. Same principle as ctx_execute, scoped to one named file via the FILE_CONTENT variable.

WHEN:
  - You want to KNOW SOMETHING ABOUT a file (line count, matches of a pattern, parsed structure, statistical aggregate) without needing to SEE all of it
  - The file is structured (CSV, JSON, log, code) and a code-level derivation is cheaper than reading verbatim
  - The file is large enough that reading the full content would burn meaningful conversation memory you need for the actual work
  - The derivation may itself produce a large output you want recall-by-topic on later — pass an \`intent\` string; outputs over ~5KB are auto-indexed and only matching sections come back, retrievable via ctx_search

WHEN NOT:
  - You intend to EDIT the file — use Read so the subsequent Edit can match the exact text
  - You only need one specific line and you know its offset — Read with offset/limit is the simplest path
  - The file is small AND you will consume all of it for understanding/editing — Read directly

RETURNS:
  Only what your code prints. The FILE_CONTENT variable holds the raw bytes inside the sandbox; nothing else leaves. When \`intent\` is set and output exceeds the auto-index threshold, the response carries searchable section titles + previews instead of the raw stdout.

EXAMPLE: ctx_execute_file(path: "huge.log", language: "javascript", code: "const errs = FILE_CONTENT.split('\\\\n').filter(l => /ERROR|FATAL/.test(l)); console.log(\`\${errs.length} error lines\`); console.log(errs.slice(-5).join('\\\\n'))")
EXAMPLE: ctx_execute_file(path: "data.csv", language: "javascript", code: "const rows = FILE_CONTENT.split('\\\\n'); console.log(\`rows: \${rows.length - 1}, header: \${rows[0]}\`)")`,
    inputSchema: z.object({
      path: z
        .string()
        .describe("Absolute file path or relative to project root"),
      language: z
        .enum([
          "javascript",
          "typescript",
          "python",
          "shell",
          "ruby",
          "go",
          "rust",
          "php",
          "perl",
          "r",
          "elixir",
          "csharp",
        ])
        .describe("Runtime language"),
      code: z
        .string()
        .describe(
          "Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts/Console.WriteLine.",
        ),
      timeout: z
        .coerce.number()
        .optional()
        .describe("Max execution time in ms. When omitted, no server-side timer fires — the MCP host's RPC timeout governs."),
      intent: z
        .string()
        .optional()
        .describe(
          "What you're looking for in the output. When provided and output is large (>5KB), " +
          "returns only matching sections via BM25 search instead of truncated output.",
        ),
    }),
  },
  async ({ path, language, code, timeout, intent }) => {
    // Security (#852): confine the processed file to the project root so
    // ctx_execute_file cannot be used to escape the host's sandbox/permission
    // controls. Runs before the deny-glob check — boundary first, then policy.
    const boundaryDenied = checkProjectBoundary(path, "ctx_execute_file");
    if (boundaryDenied) return boundaryDenied;

    // Security: check file path against Read deny patterns
    const pathDenied = checkFilePathDenyPolicy(path, "ctx_execute_file");
    if (pathDenied) return pathDenied;

    // Security: check code parameter against Bash deny patterns
    if (language === "shell") {
      const codeDenied = checkDenyPolicy(code, "execute_file");
      if (codeDenied) return codeDenied;
    } else {
      const codeDenied = checkNonShellDenyPolicy(code, language, "execute_file");
      if (codeDenied) return codeDenied;
    }

    try {
      const effTimeout = resolveExecTimeout(timeout);
      const result = await executor.executeFile({
        path,
        language,
        code,
        timeout: effTimeout,
      });

      // Echo path + executed source code before stdout for audit/debug
      // (Issues #717 + #736).
      const echo = buildExecuteEcho(language, code, path, server.server.getClientVersion());

      if (result.timedOut) {
        return trackResponse("ctx_execute_file", {
          content: [
            {
              type: "text" as const,
              text: `${echo}Timed out processing ${path} after ${effTimeout}ms`,
            },
          ],
          isError: true,
        });
      }

      if (result.exitCode !== 0) {
        const { isError, output } = classifyNonZeroExit({
          language, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
        });
        if (intent && intent.trim().length > 0 && Buffer.byteLength(output) > INTENT_SEARCH_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, intent, isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          });
        }
        // Auto-index large error output into FTS5 — no data loss
        if (Buffer.byteLength(output) > LARGE_OUTPUT_THRESHOLD) {
          trackIndexed(Buffer.byteLength(output));
          return trackResponse("ctx_execute_file", {
            content: [
              { type: "text" as const, text: `${echo}${intentSearch(output, "errors failures exceptions", isError ? `file:${path}:error` : `file:${path}`)}` },
            ],
            isError,
          });
        }
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: `${echo}${output}` },
          ],
          isError,
        });
      }

      const stdout = result.stdout || "(no output)";

      if (intent && intent.trim().length > 0 && Buffer.byteLength(stdout) > INTENT_SEARCH_THRESHOLD) {
        trackIndexed(Buffer.byteLength(stdout));
        return trackResponse("ctx_execute_file", {
          content: [
            { type: "text" as const, text: `${echo}${intentSearch(stdout, intent, `file:${path}`)}` },
          ],
        });
      }

      // Auto-index large stdout into FTS5 — return pointer, not raw content
      if (Buffer.byteLength(stdout) > LARGE_OUTPUT_THRESHOLD) {
        const indexed = indexStdout(stdout, `file:${path}`);
        const echoed = {
          ...indexed,
          content: indexed.content.map((c, i) =>
            i === 0 && c.type === "text"
              ? { ...c, text: `${echo}${(c as { text: string }).text}` }
              : c,
          ),
        };
        return trackResponse("ctx_execute_file", echoed);
      }

      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: `${echo}${stdout}` },
        ],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return trackResponse("ctx_execute_file", {
        content: [
          { type: "text" as const, text: `Runtime error: ${message}` },
        ],
        isError: true,
      });
    }
  },
);
}
