# ADR-0025: Preserve the maintained Pi behavior on the v2 core

Status: accepted 2026-11-06.

## Decision

Use official context-mode 2.1.4 as the core baseline and port the required Pi
behavior into its native in-process extension. Do not merge the v2 architecture
piecemeal into the v1 MCP bridge. The source version remains 2.1.4; the custom
distribution version is 2.1.4-pi.1.

## Pi boundary

- The persisted Pi transcript defines current-branch membership. Automatic memory
  and the default `ctx_resume` may include only verified ancestors. Explicit
  historical searches may span branches and are described as historical evidence.
- Static routing instructions remain stable. Historical observations are separate
  context messages, never new system instructions or authorization. Default memory
  is delivered once after successful compaction; `off` and `always` remain options.
- Pending compaction recovery is recorded in Pi custom entries and survives a
  reload. Switching branches cannot revive abandoned work as the current request.
- Structured tool results and bounded graph observations are indexed with session,
  tool-call and transcript provenance. Unbound observations remain searchable but
  cannot create automatic branch-memory receipts. Graph observations explicitly
  describe their excerpt and digest scope.
- Execute, batch and search accept `maxOutputChars` at the Pi boundary (default
  12,000; range 1,000–81,920). It is removed before upstream strict validation.
  Whole rendered replies are indexed before presentation shortening, with unique
  source labels. A storage failure is reported rather than claiming recoverability.
- Returned Pi failures preserve both the error flag and structured status/source
  details. Maintenance tools are deferred only when an active discovery tool can
  reach them; otherwise all nine context-mode tools remain directly available.

## Shared correctness fixes

Nonzero command exits fail even without stderr. Timeout, cancellation and signal
output is indexed before replying; batch results retain earlier failures. Exact
retrieval uses unique labels to avoid collisions with user source labels. Explicit
storage limits and failures are visible in text and metadata. Other hosts retain
their default output budgets. These correctness fixes live in the shared core,
not a second Pi execution engine.

## Packaging and rollback

`npm run build:pi` produces a validated self-contained package in `release-out`.
Pi selects exactly one package source. The local `ctx_upgrade` provides guidance
without invoking upstream configuration or v1-data migration. Keep the original
v1 checkout and data in place; v2 starts a separate database. Backup configuration
and old data before selecting the custom package. A full Pi restart is required.

Validation uses deterministic unit cases and the installed Pi SDK with a fake
provider, temporary home and no network access. No model API calls are needed for
the local lifecycle checks. See `docs/migration/pi-v2.md` for operator steps.

## Tests

`tests/0025-pi-custom.test.mjs` owns the custom Pi branch, evidence and output-budget
contract. Existing core execution, build and adapter tests remain in their current
ADR/PRD areas.
