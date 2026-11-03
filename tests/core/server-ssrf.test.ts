/** Server regressions: ssrf. */



import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, test, expect } from "vitest";
// ═══════════════════════════════════════════════════════════════════════════
// SSRF guard — ctx_fetch_and_index URL/IP allowlist (PR #401 ops review)
// ═══════════════════════════════════════════════════════════════════════════

import { classifyIp } from "../../src/server.js";
// ═══════════════════════════════════════════════════════════════════════════
// buildFetchCode — embedded SSRF guard contract (#476 review follow-ups)
// ═══════════════════════════════════════════════════════════════════════════

import { buildFetchCode } from "../../src/server.js";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// 3. Turndown HTML-to-markdown conversion
// ═══════════════════════════════════════════════════════════════════════════

// Resolve turndown path the same way server.ts will
const require = createRequire(import.meta.url);


describe("classifyIp — SSRF guard IP classifier", () => {
  test("hard-blocks IMDS / link-local IPv4 (169.254.0.0/16)", () => {
    // 169.254.169.254 = AWS/GCP/Azure cloud metadata endpoint — never legitimate
    expect(classifyIp("169.254.169.254")).toBe("block");
    expect(classifyIp("169.254.0.1")).toBe("block");
    expect(classifyIp("169.254.255.254")).toBe("block");
  });

  test("hard-blocks multicast / reserved IPv4 (224+ and 0.0.0.0/8)", () => {
    expect(classifyIp("224.0.0.1")).toBe("block");
    expect(classifyIp("239.255.255.255")).toBe("block");
    expect(classifyIp("255.255.255.255")).toBe("block");
    expect(classifyIp("0.0.0.0")).toBe("block");
    expect(classifyIp("0.1.2.3")).toBe("block");
  });

  test("hard-blocks malformed IPv4", () => {
    expect(classifyIp("999.999.999.999")).toBe("block");
    expect(classifyIp("not-an-ip")).toBe("block");
    expect(classifyIp("1.2.3")).toBe("block");
  });

  test("hard-blocks IPv6 link-local + multicast + unspecified", () => {
    expect(classifyIp("fe80::1")).toBe("block"); // link-local
    expect(classifyIp("ff00::1")).toBe("block"); // multicast
    expect(classifyIp("::")).toBe("block");      // unspecified
  });

  test("private (allow by default, block under strict mode): RFC1918 + loopback IPv4", () => {
    // Allowed by default — developer's local dev server / internal network
    expect(classifyIp("127.0.0.1")).toBe("private");
    expect(classifyIp("127.255.255.255")).toBe("private");
    expect(classifyIp("10.0.0.5")).toBe("private");
    expect(classifyIp("10.255.255.255")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.31.255.255")).toBe("private");
    expect(classifyIp("172.15.0.1")).toBe("public");  // outside RFC1918
    expect(classifyIp("172.32.0.1")).toBe("public");  // outside RFC1918
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("192.168.255.255")).toBe("private");
  });

  test("private: IPv6 loopback + ULA (fc00::/7)", () => {
    expect(classifyIp("::1")).toBe("private");
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fd12:3456:789a::1")).toBe("private");
  });

  test("public: real internet IPs", () => {
    expect(classifyIp("8.8.8.8")).toBe("public");           // Google DNS
    expect(classifyIp("1.1.1.1")).toBe("public");           // Cloudflare DNS
    expect(classifyIp("140.82.121.4")).toBe("public");      // github.com
    expect(classifyIp("2001:4860:4860::8888")).toBe("public"); // Google DNS IPv6
  });

  test("IPv4-mapped IPv6 recurses through IPv4 classifier", () => {
    // ::ffff:127.0.0.1 is just 127.0.0.1 wrapped in IPv6 mapping
    expect(classifyIp("::ffff:127.0.0.1")).toBe("private");
    expect(classifyIp("::ffff:169.254.169.254")).toBe("block"); // IMDS via IPv4-mapped
    expect(classifyIp("::ffff:8.8.8.8")).toBe("public");
  });
});


describe("SSRF guard — ssrfGuard policy in src/server.ts", () => {
  const serverSrc = readServerSource();

  test("allowlists only http: and https: schemes", () => {
    expect(serverSrc).toContain('parsed.protocol !== "http:"');
    expect(serverSrc).toContain('parsed.protocol !== "https:"');
    // file:// / gopher:// / javascript: implicitly rejected
  });

  test("blocks IPs classified as block (link-local/IMDS/multicast)", () => {
    expect(serverSrc).toContain('verdict === "block"');
    expect(serverSrc).toContain("link-local / IMDS / multicast / reserved");
  });

  test("strict mode opt-in via CTX_FETCH_STRICT=1", () => {
    expect(serverSrc).toContain('process.env.CTX_FETCH_STRICT === "1"');
    expect(serverSrc).toContain('verdict === "private" && strict');
  });

  test("ssrfGuard runs BEFORE cache lookup (poisoned cache defense)", () => {
    // fetchOneUrl must call ssrfGuard before getSourceMeta — otherwise a
    // previously-poisoned source label could serve attacker content from cache.
    const fetchOneSrc = serverSrc.match(/async function fetchOneUrl\([\s\S]+?^}/m);
    expect(fetchOneSrc).not.toBeNull();
    const block = fetchOneSrc![0];
    const guardIdx = block.indexOf("ssrfGuard");
    const cacheIdx = block.indexOf("getSourceMeta");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(cacheIdx);
  });
});


describe("buildFetchCode — embedded SSRF guard contract", () => {
  const generated = buildFetchCode("https://example.com/x", "/tmp/x");

  test("strips proxy env vars (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY)", () => {
    // A configured outbound proxy would route fetch through an arbitrary
    // target; DNS resolution would happen at the proxy and the in-subprocess
    // DNS guard would never see the rebound IP. The generated subprocess
    // source must delete every proxy env var before any fetch can run.
    expect(generated).toMatch(/delete process\.env\.HTTP_PROXY/);
    expect(generated).toMatch(/delete process\.env\.HTTPS_PROXY/);
    expect(generated).toMatch(/delete process\.env\.ALL_PROXY/);
    expect(generated).toMatch(/delete process\.env\.http_proxy/);
    expect(generated).toMatch(/delete process\.env\.https_proxy/);
    expect(generated).toMatch(/delete process\.env\.all_proxy/);
  });

  test("embedded SSRF classifier is callable as `classifyIp` even when bundler renames the export (#bug-v1.0.133)", () => {
    // REGRESSION: esbuild renames top-level `classifyIp` to a short name
    // (e.g. `_h`) in server.bundle.mjs. The previous implementation embedded
    // `classifyIp.toString()` directly, which yielded `function _h(t){...}`
    // — but the subprocess template invokes `classifyIp(...)` literally and
    // the function's own internal recursion uses the bundler-mangled name.
    // Result was 100% failure of ctx_fetch_and_index in the published build:
    //   ReferenceError: classifyIp is not defined
    //     at patchedPromisesLookup (.../script.js:71:19)
    // The fix must: (1) expose the canonical `classifyIp` identifier in the
    // embedded scope, AND (2) preserve recursion under whatever name the
    // bundler chose. Validate by evaluating the embedded source in an
    // isolated scope and confirming `classifyIp` resolves and works for
    // both direct calls AND the recursive IPv4-mapped-IPv6 path.
    expect(generated).toMatch(/var\s+classifyIp\s*=/);

    // Extract the self-contained classifier declaration block (var classifyIp
    // = function classifyIp(rawIp){...};) and evaluate it in a fresh function
    // scope where neither `classifyIp` nor any bundler alias exists in the
    // outer closure. The canonical name MUST resolve and behave.
    const classifyIpDeclMatch = generated.match(
      /var\s+\w+\s*=\s*function\s+\w+\s*\(\s*rawIp\s*\)[\s\S]+?\n\};(?:\s*var\s+classifyIp\s*=\s*\w+;)?/,
    );
    expect(
      classifyIpDeclMatch,
      "embedded classifyIp declaration block must be extractable from buildFetchCode output",
    ).not.toBeNull();
    const classifierBlock = classifyIpDeclMatch![0];

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const probe = new Function(`
      ${classifierBlock}
      return {
        imds: classifyIp("169.254.169.254"),
        loopback: classifyIp("127.0.0.1"),
        publicIp: classifyIp("8.8.8.8"),
        mapped: classifyIp("::ffff:169.254.169.254"),
      };
    `);
    const result = probe() as Record<string, string>;
    expect(result.imds).toBe("block");
    expect(result.loopback).toBe("private");
    expect(result.publicIp).toBe("public");
    // IPv4-mapped IPv6 forces the internal recursive call path; if recursion
    // is broken (bundler-mangled self-reference unresolved), this throws.
    expect(result.mapped).toBe("block");
  });

  test("patches dns/promises lookup (separate function reference from dns.lookup)", () => {
    // Patching dns.lookup does NOT affect dnsPromises.lookup. Today undici
    // uses callback-form dns.lookup so default fetch is covered, but the
    // invariant is fragile — a future undici switch or any caller using
    // dnsPromises.lookup directly would bypass the guard.
    // Match either literal 'node:dns/promises' or split-string 'no'+'de:dns/promises'
    // The split form is required by the G3 bundle invariant — the literal would
    // false-positive scripts/assert-bundle.mjs's raw-bare-require-node-builtin check.
    expect(generated).toMatch(
      /const dnsPromises\s*=\s*require\([^)]*dns\/promises['"]\)/,
    );
    expect(generated).toMatch(/dnsPromises\.lookup\s*=\s*async\s+function/);
    expect(generated).toMatch(/SSRF blocked/);
  });

  test("patches dns.resolve4 and dns.resolve6 (libuv bypass path)", () => {
    // dns.resolve* uses a different code path (no getaddrinfo, no /etc/hosts)
    // than dns.lookup — they must be patched separately or the guard is
    // trivially bypassed by any caller using dns.resolve* directly.
    expect(generated).toMatch(/['"]resolve4['"]\s*,\s*['"]resolve6['"]/);
    expect(generated).toMatch(/dns\[name\]\s*=\s*function/);
  });

  describe("buildFetchCode — redirect chain rebinding", () => {
    // SSRF rebinding via HTTP redirect chain bypasses the parent's pre-flight
    // ssrfGuard: a 302 to http://attacker/ (or an IPv4-mapped IMDS literal)
    // sends the subprocess fetch to an alternate host the parent never
    // classified. The connect-time DNS guard catches some cases, but a
    // direct-IP redirect target may not trigger getaddrinfo at all. Mitigate
    // at the HTTP layer: emit `redirect: 'manual'` in the generated source,
    // re-validate every Location header against ssrfGuard's classifier, and
    // cap the redirect chain so an attacker cannot exhaust the loop.
    const generated = buildFetchCode("https://example.com/x", "/tmp/x");

    test("generated source uses redirect: 'manual' (no follow default)", () => {
      // The default `redirect: 'follow'` lets undici chase a 3xx Location
      // BEFORE the in-subprocess DNS guard sees the target hostname (and even
      // when it does, a direct IPv4-literal redirect skips getaddrinfo). The
      // generated subprocess source MUST opt out of automatic following so
      // every hop is re-validated by classifyIp before another fetch fires.
      expect(generated).toMatch(/redirect:\s*['"]manual['"]/);
    });

    test("manual redirect handler validates Location host via classifyIp", () => {
      // After receiving a 3xx, the subprocess must parse the Location header,
      // resolve its host, and run the same classifyIp policy as ssrfGuard
      // before issuing the next fetch. Without this re-check, an attacker can
      // redirect to http://169.254.169.254/ or any rebinding-friendly host.
      expect(generated).toMatch(/Location/);
      expect(generated).toMatch(/classifyIp\s*\(/);
      // The redirect handler specifically must invoke classifyIp on the
      // redirect target — not just the parent's pre-flight call site.
      expect(generated).toMatch(/redirect[\s\S]{0,400}classifyIp/);
    });

    test("redirect chain is capped (no unbounded follow)", () => {
      // An attacker controlling redirect responses could otherwise loop the
      // subprocess forever or chain enough hops to amortize a slow rebinding
      // attack. Cap at 5 — the standard browser limit — and abort cleanly.
      expect(generated).toMatch(/(maxRedirects|MAX_REDIRECTS|redirectCount\s*[<>]=?\s*5|<\s*5|<=\s*5)/);
    });

    test("non-3xx response path still emits content (preserves 200 semantics)", () => {
      // Manual redirect handling must not break the happy path: a 200 OK
      // still flows through emit() with the right content-type branch. Pin
      // the existing emit() call sites so a refactor that drops them fails.
      expect(generated).toMatch(/emit\(['"]json['"]/);
      expect(generated).toMatch(/emit\(['"]html['"]/);
      expect(generated).toMatch(/emit\(['"]text['"]/);
    });
  });

  test("classifyIp embeds without references to module scope", () => {
    // classifyIp is embedded into the subprocess via Function.prototype.toString().
    // If a future change ever has classifyIp close over a module-scope helper
    // (e.g. a regex constant declared above it), the embedded source will
    // ReferenceError at parse or call time — silently breaking the guard. Pin
    // the contract: classifyIp source must contain no identifiers that can
    // only resolve in module scope.
    const src = classifyIp.toString();
    const forbidden = [
      "require(",
      "process.",
      "globalThis.",
      "global.",
      "__dirname",
      "__filename",
    ];
    for (const ident of forbidden) {
      expect(src).not.toContain(ident);
    }
    // Roundtrip: eval the source in an empty vm context with no globals,
    // then invoke it. This is exactly what the subprocess does.
    const { runInNewContext } = require("node:vm");
    const ctx: Record<string, unknown> = {};
    runInNewContext(`${src}\n;globalThis.fn = classifyIp;`, ctx);
    const fn = ctx.fn as (ip: string) => "block" | "private" | "public";
    expect(fn("169.254.169.254")).toBe("block");
    expect(fn("8.8.8.8")).toBe("public");
    expect(fn("10.0.0.1")).toBe("private");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// buildFetchCode — IPv6 zone-id + generic dns.resolve (#476 round-3)
// ═══════════════════════════════════════════════════════════════════════════

describe("buildFetchCode — IPv6 zone-id + generic dns.resolve", () => {
  test("classifyIp strips IPv6 zone-id before classification (link-local)", () => {
    // fe80::/10 link-local with %eth0 zone suffix must still be blocked.
    // Today the lowercase prefix check `fe8`/`fe9`/`fea`/`feb` accidentally
    // catches link-local even with a zone suffix — but only because the
    // suffix is appended *after* the prefix. Pin the behavior explicitly so
    // a future refactor cannot regress.
    expect(classifyIp("fe80::1%eth0")).toBe("block");
    expect(classifyIp("fe80::1%25eth0")).toBe("block"); // URL-encoded zone
  });

  test("classifyIp strips IPv6 zone-id before classification (non-link-local)", () => {
    // RFC 6874 permits zone identifiers on any IPv6 address (not just
    // link-local). Without zone stripping, a loopback `::1%eth0` would NOT
    // match the strict equality `lower === "::1"` and would leak through as
    // "public". Pin every class so the strip happens before classification.
    expect(classifyIp("::1%eth0")).toBe("private");        // loopback w/ zone
    expect(classifyIp("fc00::1%eth0")).toBe("private");    // ULA w/ zone
    expect(classifyIp("ff00::1%eth0")).toBe("block");      // multicast w/ zone
    expect(classifyIp("2001:db8::1%eth0")).toBe("public"); // doc range w/ zone
  });

  test("buildFetchCode patches generic dns.resolve (not just resolve4/resolve6)", () => {
    // dns.resolve is the polymorphic entrypoint that dispatches on rrtype.
    // Today only resolve4/resolve6 are patched; a caller using
    // `dns.resolve(host, 'A', cb)` or default rrtype goes through an
    // un-guarded code path. Patch the generic wrapper so every A/AAAA
    // record runs through classifyIp.
    const generated = buildFetchCode("https://example.com/x", "/tmp/x");
    expect(generated).toMatch(/dns\.resolve\s*=\s*function/);
    expect(generated).toMatch(/classifyIp/);
  });
});
