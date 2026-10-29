# Golden fixtures (Phase 2)

Captured from `C:\Program Files\Git\mingw64\bin\git.exe` (git version 2.52.0.windows.1)
with `node harness/capture-fixtures.mjs`. Scenario definitions: `harness/scenarios.mjs`.

Per scenario directory:

- `result.json`: every step's argv, cwd, stdout, stderr and exit code, plus a snapshot of
  the work tree and `.git`: file list, size and sha256; text of HEAD/config/refs/logs;
  inflated objects (header, oid, parsed tree entries, zlib header bytes); and the parsed
  index (stat fields dropped).
- `dotgit/`: the raw `.git` directory, byte for byte.

`index.json` lists the scenarios, the obligations each covers and the exit codes.
`TRANSCRIPT.md` is a readable rendering of every command and its output.

## Pinned environment (harness/runner.mjs)

- `GIT_CONFIG_NOSYSTEM=1`, empty `GIT_CONFIG_GLOBAL`, private `HOME`.
- Author "A U Thor <author@example.com>", committer "C O Mitter <committer@example.com>".
- Date for step *i* is `1700000000 + 60*i +0530`.
- `LANG=LC_ALL=C`, `GIT_PAGER=cat`, `GIT_CEILING_DIRECTORIES` set to the scenario's parent folder.
- The absolute scenario path is rewritten to `<ROOT>` in output.

Two captures in a row matched exactly. The one exception is the index TREE extension in
`status-staged-delete`: whether `dir` is cached (`1 0` + oid) or invalidated (`-1 0`)
depends on racy-timestamp timing. Parity must accept either form for that extension.
Index trailer checksums and stat fields are host-specific and not compared.

## Open questions from Phase 1, settled by observation

| Question | Observed |
|---|---|
| zlib level | Every loose object starts `78 01` (level 1 / fastest) |
| "nothing to commit" exit | 1, message on **stdout** (`commit-nothing`, `commit-empty-repo`) |
| Empty `-m ""` | "Aborting commit due to empty commit message." on stderr, exit 1 |
| Message cleanup with `-m` | Trailing whitespace stripped, runs of blank lines collapsed, leading/trailing blank lines dropped, leading spaces kept, `#` lines kept |
| Hunk header | `@@ -a,b +c,d @@ <funcname>`; `,1` omitted; empty range `-30,0`. Funcname = nearest preceding line starting with a letter, `_` or `$` |
| Diff algorithm | Myers-style minimal output on every scenario; no heuristics visible in the fixtures |
| Windows filemode | `core.filemode=false`, `symlinks=false`, `ignorecase=true` in config; all entries 100644 |
| Status exit codes | Always 0 |
| Loose refs | `<40hex>\n`; branch creation reflog `branch: Created from HEAD`; checkout reflog `checkout: moving from X to Y` even for "Already on" |
| merge ff | Writes `ORIG_HEAD`, reflog `merge <name>: Fast-forward`, prints diffstat after `Fast-forward` |
| Progress messages | `Switched to ...`, `Already on ...` go to stderr; `M\t<path>` carry-over list to stdout |

## Behaviour that needs more than the v1 scope

- `commit`/`merge` print a diffstat (`1 file changed, ...`, `create mode`). The reimplementation must produce this.
- `diff` outside a repo falls back to `--no-index` and prints a 130-line usage on an unknown option.
- `git stauts` suggests the most similar command (Levenshtein-style "did you mean").
- `git` with no args prints the full common-commands help.

## Later additions

- Phase 3 added 10 scenarios to `harness/scenarios.mjs` to settle behaviour the first capture left open:
  - `cache-tree-order`: subtrees are ordered by name length, then bytes;
  - `cat-file-missing-full-hex`;
  - `checkout-path-no-dashdash`: the "Updated N path(s)" message appears only without `--`;
  - `checkout-untracked-overwrite`;
  - `commit-unstaged-only`;
  - `status-subdir-relative`;
  - `merge-ff-dirty`: "Updating" is printed before the refusal;
  - `diff-move-lines`;
  - `usage-texts`: `-h` output for every command;
  - `detached-head`.
- Phase 4 added 16 held-out scenarios (`harness/scenarios-holdout.mjs`, names starting `ho-`). They were recorded and run against the finished implementation before any fix: 12/16 passed first time (see `tests/holdout-initial-report.json`), and all pass now.
