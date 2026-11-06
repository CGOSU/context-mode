# CGOSU Pi migration to v2

The source checkout uses upstream **2.1.4** as its baseline. Its `package.json`
keeps that source version and records the custom distribution version separately
in `piBuild.version`. The package Pi actually loads is **2.1.4-pi.1**.

## Acceptance on 2026-11-06

Validated with Node 26.11.1 and installed Pi 1.5.0:

- Type checking and the complete unit suite: 2,766 passed, 39 skipped, no failures
  or cancellations. Skips cover platform-specific, absent optional hosts and
  existing upstream exclusions.
- All end-to-end groups were exercised. GP1/GP4/GP5 were rerun after correcting
  outdated expectations: 83 passed, 5 skipped, no failures. The other groups had
  already passed. Expectations still verify exact-source retrieval, Unicode,
  storage limits, failure flags and execution deadlines.
- Installed-Pi integration: one extension, nine reachable tools, output limits,
  searchable saved output, failure metadata, branch isolation, compaction and
  restart recovery, single delivery, and deferred discovery passed. The fake
  provider made zero network requests.
- Build, prompt checks, repository checks and final package checksum verification
  passed. The selected release directory was loaded by the real Pi resource loader.

Local operator records and the backup location are in `docs/session-log.md`.
The current interactive Pi process was not restarted by the migration.

## Build and select one package

Use Node 24.15 or later. In this checkout:

```sh
npm install
npm run build:pi
```

`build:pi` creates a self-contained package in `release-out/`, including the Pi
extension, its rendered skills, and the other runtime files used by diagnostics.
It builds in a temporary sibling directory, validates the result, then replaces
the existing release directory. A failed build leaves the previous package intact.
The finished package has no runtime dependencies or install scripts.

Point Pi at the absolute path to this checkout's `release-out` directory. Replace
the existing context-mode package entry; do not add this next to the existing
`git:github.com/CGOSU/context-mode` or `npm:context-mode` entry. Pi must load one
context-mode extension.

The source root also declares Pi resources under `release-out/`, so it can be used
as a local package **after building**. Loading the root and `release-out` together
would register the extension twice. A Git checkout is not a prebuilt distribution:
it must be built before Pi loads its declared resources. No install hook silently
builds or upgrades it.

The upstream `npm run build` and `build:release` scripts remain upstream developer
builds. Use `npm run build:pi` to produce the custom version and its distribution
notice. The packaged README links upstream documentation to the real `v2.1.4`
tag rather than claiming that a `v2.1.4-pi.1` upstream tag exists.

## Preserve v1 and its data

The extension uses the v2 tool API. Existing hand-written calls need these changes:

| v1 call | v2 call |
|---|---|
| `ctx_fetch_and_index` | `ctx_index({url: ...})` |
| `ctx_execute_file` | `ctx_execute({language, code, file})`; read the path from `CTX_FILE` |
| `ctx_batch_execute` | `ctx_batch({commands: ["shell command"], queries: [...]})` |
| execution `timeout` | `timeoutMs` in milliseconds |

`ctx_resume` is available for verified current-branch history. `ctx_insight` is not
part of the v2 tools. The Pi-specific `maxOutputChars` option remains available on
execute, batch and search; other parameters follow the v2 schemas.

Before switching, save the original Pi package source, installed v1 checkout and
uncommitted patches. Keep the old data directories, including the Pi session data
and content indexes. The v2 database starts separately; this migration does not
import or delete v1 records.

Do not use `ctx_upgrade` as a migration check: upstream v2 may rewrite host
configuration and rename v1 data directories before returning its update command.
The local package is rebuilt from this checkout; `pi update --extensions` does
not build this custom source or switch a CGOSU Git source to official npm.

Fully exit and restart Pi after selecting the new package. Validate tool discovery,
branch-scoped recovery, output budgets, failed commands, stopped execution evidence,
and search before normal use. Keep the old package directory available until this
validation is complete.

## Pi compatibility

The custom extension is validated with Pi **1.5.0**. Expected tool failures return
`isError: true` together with the diagnostic text and structured `details`, so Pi
keeps execution status and recall sources. Throwing an error in this version of
Pi discards those details. Earlier Pi versions have not been validated for this
custom error-result contract.

## Check the installed Pi runtime without a provider

```sh
node scripts/test-pi-installed.mjs
```

This optional integration check reads the active managed Pi installation. For a
different installation, pass `--sdk /absolute/path/to/pi-coding-agent`. It builds
the current source into a temporary package, loads that package through Pi's real
resource loader, and runs real sessions with an in-memory fake model. It uses a
temporary home and workspace, blocks network fetches, and never selects a package
in the real Pi settings.

The check covers one loaded extension, output preservation and search, structured
failure details, current-branch recall after tree navigation, compaction followed
by restart, one-time recovery, and maintenance-tool discovery. It validates the
host integration; it does not evaluate a language model's behavior or judgment.

## Rollback

Fully exit Pi, restore its original single package source and the saved v1 patches,
then restart. Because the v1 package and its data remain separate, rollback does
not require downgrading a v2 database. Keep any new v2 data separately if it needs
to be inspected later.
