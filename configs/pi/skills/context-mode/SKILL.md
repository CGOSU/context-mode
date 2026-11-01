---
name: context-mode
description: Use context-mode with Pi when large or unbounded tool output needs to be reduced, indexed, or searched. Prefer Pi's native tools for ordinary code work and short, predictable commands.
---

# Context-mode for Pi

Choose the smallest useful tool; context-mode is optional for ordinary work.

- **Locate and edit code:** use `graph_locate` / `graph_inspect` for unfamiliar JS/TS, React, Vue, or Rust behavior; use native `read` for known files and `edit` / `write` for changes. Use native `bash` for simple commands with short, predictable output.
- **Reduce large output:** use `ctx_execute` to analyze/filter large command output and print only relevant findings. Preserve the command's real exit status; a failed, denied, or truncated operation is not success or proof of no results.
- **Analyze a large existing file:** use `ctx_execute_file` for in-sandbox analysis, not editing. Respect its workspace and host permission boundaries; do not try another tool to bypass a denial.
- **Batch research:** use `ctx_batch_execute` for several related commands whose outputs need joint analysis; summarize/filter in the commands and query the indexed batch output in the same call.
- **Search stored knowledge:** `ctx_search` searches only indexed content and captured session memory. Index local reusable documents with `ctx_index`, or fetch and index web documentation with `ctx_fetch_and_index`, before expecting search to find it. Batch related questions into one call and use `source` to scope results when appropriate.

Do not route every read, edit, short command, or query through a sandbox. Never report a tool failure as empty data or successful verification, and do not include secrets or sensitive production data in indexed content.
