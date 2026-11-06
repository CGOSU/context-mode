# No lossy cut (owner main rule, D-NO-LOSSY-CUT-1 / D-NO-LOSSY-CUT-2)

Rule: a successful reply may be bounded only when the full content is stored first (indexed) and the reply tells the agent how to get the rest.
Silent content loss is forbidden. If persistence fails, the tool returns an explicit error and a bounded raw preview;
the omitted output may be unrecoverable, so this failure path must never claim to be lossless or advertise a searchable source.

`tests/0014-repo-hygiene.test.mjs` reads this file. Every `capBytes(` call in `src/` must have one `capBytes` row below
(same file, same count). The normal verdict is `lossless`; the audited execution/batch failure paths below are explicit exceptions.
`tests/prd9-sandbox.test.mjs` checks stored-output retrieval, stopped execution, storage failure and the batch ingest limit.
In the normal path, the budget math keeps head, chunks and pointer under the output cap, and an echo of caller input
(intent, query, label) longer than ECHO_MAX_BYTES is named by position, `...` or source handle instead of echoed.

## capBytes call sites

| Site | Kind | Full content stored and reachable | Verdict |
|---|---|---|---|
| src/core/tools/search.ts:43 | capBytes final guard | Search reads the index. Whole chunks only, paging line names the next call. Oversize query is not echoed in the reply. | lossless |
| src/core/tools/execute.ts:174 | capBytes final guard | Captured output, including timeout/cancel partial output, is indexed first under a unique call label. Status and the exact-source search pointer precede whole selected chunks. | lossless |
| src/core/tools/execute.ts:184 | capBytes storage-failure fallback | Persistence failed. The reply retains the execution outcome and says `Output not indexed; preview only`, returns `isError:true` and `outputStored:false`, and supplies no source. Raw output beyond the preview may be lost. | explicit failure |
| src/core/tools/stats.ts:503 | capBytes final guard | Fixed-size table; size is bounded by the agent count, far under OUTPUT_CAP (test). Nothing is dropped. | lossless |
| src/core/tools/batch.ts:310 | capBytes indexed-result guard | Within the ingest limit, all captured command output is indexed even after timeout/cancel; status and source precede selected chunks. If the byte limit stops ingestion, only the indexed portion is reachable: the reply reports stored/total bytes, returns `isError:true` and `evidenceComplete:false`. The unstored remainder may be lost. | conditional |
| src/core/tools/batch.ts:322 | capBytes storage-failure fallback | An indexing/storage error returns the command outcomes and `Output not indexed; preview only`, with `isError:true`, `outputStored:false` and no source claim. The bounded raw preview does not make omitted output recoverable. | explicit failure |
| src/core/tools/index.ts:174 | capBytes final guard | One-line reply. Content is stored whole; a label over ECHO_MAX_BYTES is shown as its handle `sN`. | lossless |
| src/core/tools/run-wrapper.ts:147 | capBytes final guard | run.mjs output is indexed first; pointer `more: node search.mjs <id> "<terms>"` (terms shown whole; shell budget reserves it). | lossless |
| src/core/tools/run-wrapper.ts:169 | capBytes final guard | search.mjs returns whole chunks of one stored source with the budget OUTPUT_CAP. | lossless |

The batch byte cap is a storage bound, not a claim that arbitrary output can always be retained. It remains enforced after cancellation;
the caller is told when evidence is incomplete. A host may still bound the returned error preview, but must preserve its failure and source metadata.

## Other places that shorten content

| Site | What it does | Full content stored and reachable | Verdict |
|---|---|---|---|
| src/core/ops/report.ts (buildReport, buildReportHead), src/core/tools/doctor.ts | Doctor report over REPORT_CAP (4096 B). Before: cut with a "truncated" line, rows lost. Now: whole report stored under `ctx_doctor:report`; reply = header + FAIL rows + `REPORT_POINTER` (`ctx_search` with the three status words). | yes | fixed (D-NO-LOSSY-CUT-1) |
| REPORT_CAP = 4096 | Reason (ADR-0014): a report pasted into a GitHub issue stays small and under the issue-URL limit. Kept: the reply is still <= 4096 B. | n/a | kept |
| src/core/index/select.ts moreLine | Intent echo in the pointer. Over ECHO_MAX_BYTES it shows `[...]`, like the ctx_batch footer. | yes (caller holds intent) | fixed (D-NO-LOSSY-CUT-2) |
| src/core/tools/batch.ts answer | Query echo in `## <q>` header. Over ECHO_MAX_BYTES it shows `query N`. | yes | fixed (D-NO-LOSSY-CUT-2) |
| src/core/tools/index.ts handler | Label echo in the "Indexed ..." line. Over ECHO_MAX_BYTES it shows the source handle. | yes (stored whole; `source` accepts the handle) | fixed (D-NO-LOSSY-CUT-2) |
| src/core/tools/execute.ts:125, src/core/tools/run-wrapper.ts:84, src/core/hooks/dispatch.ts:481 | Source label = tool + first line of the code, at most SOURCE_LABEL_MAX_CHARS (80). A label is an id (a name for the source), not content. The full code/output is stored as the chunks. | yes | keep: id, not content |
| src/core/store/fts.ts:392, :438 and src/core/store/snippet.ts (clipLine, buildSnippet) | Search hit shows a snippet around the match (SNIPPET_MAX_BYTES). The row stays in the index; paging and `source` filter reach the rest. A snippet is a view of a hit, not the reply content. | yes | lossless |
| src/core/hooks/dispatch.ts:440 (selectChunksInMemory) | Hook replace: whole chunks selected, full output indexed first, handle line + `moreLine` pointer. | yes | lossless |
| src/core/tools/search.ts:106 (JSON_SOURCE_MAX_BYTES) | JSON rows view is skipped for a source over 8 MB; the normal chunk search still answers. Nothing is cut. | yes | lossless |
| src/cli/commands.ts:158 (URL_BODY_MAX) | Prefilled GitHub issue URL body. GitHub rejects long URLs. The report file is written whole and the URL text says to attach it. This is CLI text for a person, not tool reply. | yes (report file) | keep, pointer in text ("cut; attach the report file") |
