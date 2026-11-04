# Pi evidence and code navigation

Date: 2026-11-04

Pi uses pi-graph to locate supported code relationships and context-mode to analyze large outputs and retrieve stored evidence. Native file reads remain the authority for exact source and full-file review. This division avoids a second general code index and preserves pi-init's workflow ownership.

## Decisions

- Capture the current Pi `tool_result.content` and structured results, normalize bare `ctx_*` names, and attach the session entry/tool-call provenance. Graph observations are bounded excerpts with a fingerprint and a reminder to verify original files.
- Execution observations append under unique session/execution labels. Explicit document snapshots keep the store's existing replace-by-label behavior. The existing 14-day source retention also applies to execution observations; long-lived execution servers periodically apply the same cleanup policy.
- Nonzero process exits and stopped timeouts return failures even when partial output exists. Background detachment returns an explicit running state. Batch results report individual command outcomes, failures, and skipped commands. These statuses precede previews and survive output reduction.
- Pi execution/search/batch previews default to 12,000 characters, including headings and notices. `maxOutputChars` permits explicit bounded expansion. Large execution output is retained before reducing its preview; storage failure is reported without a usable recall claim. Batch inventories have smaller budgets so query evidence remains visible. Optional upgrade hints cannot displace execution evidence.
- Retrieved ContentStore rows are labelled `indexed-content`; the shared project store can contain prior executions. Missing timestamps remain unknown rather than being replaced with the query time. Known source IDs should be used for follow-up; incorrect dates/sources are a reason to inspect original records.
- `PI_CONTEXT_MODE_AUTO_MEMORY=compact` is the default. A successful native compaction can deliver one bounded historical hint. `always` adds a recent branch-scoped event window on ordinary turns; `off` disables automatic history. The latest 50 eligible events are selected after filtering by current ancestry. Legacy unscoped events remain searchable but cannot be promoted into automatic instructions. Pi-specific deduplication includes source provenance so identical observations on different branches remain independent.
- History is delivered as a labelled extension message. It cannot create authorization, restore a workflow identity, or replace current user instructions. A prepared resume is consumed only after it is actually delivered to the matching session/branch.

## Compatibility and limits

Public tools remain available. Other hosts keep their default search/batch preview budgets; the nonzero-exit correction applies to execution across hosts. Callers relying on a shell exit of 1 being treated as successful must handle that command's documented exit semantics explicitly.

No historical database rewrite is required. Already overwritten execution outputs cannot be recovered by this change. Branch attribution is used for automatic Pi memory, not an assertion that every explicit cross-session search is current-branch evidence. Source-scoped retrieval and original-file checks remain necessary.

Tracked standalone Pi and server bundles must be rebuilt alongside source changes. Restart the Pi process to load the installed update; a source checkout change alone does not update an already loaded extension.

## Verification

Regression coverage uses isolated SQLite stores, realistic Pi SDK result shapes, mocked bridge lifecycle events, and isolated MCP subprocess fixtures. It covers output budgets and inventories, independent execution sources, timeout/exit failures, source provenance, branch switching, recent-memory windows, and compaction delivery. Exact commands and results are recorded in the task's delivery summary.
