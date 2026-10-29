# pkb

`pkb` is a version-control tool that behaves like git's core commands, under its own name. Its behaviour was rebuilt from two sources:

- reverse-engineering evidence about `C:\Program Files\Git\mingw64\bin\git.exe` (git 2.52.0.windows.1, SHA-256 `fc0f1cae…4363`), gathered with the REA MCP tools and the Ghidra 12.1.4 decompiler;
- black-box fixtures recorded from the real git.

No git source code was used. Each module's header comment names the REA findings, binary addresses and fixtures it is based on. It is written in TypeScript for Node.js.

## What "pkb" changes and what it keeps

| | pkb | git |
|---|---|---|
| Command | `pkb <command>` | `git <command>` |
| Repository directory | `.pkb/` | `.git/` |
| Repository pointer file | `.pkb` file containing `pkbdir: <path>` | `.git` file containing `gitdir: <path>` |
| Ignore file | `.pkbignore` (plus `.pkb/info/exclude` and `core.excludesFile`) | `.gitignore` |
| User config | `~/.pkbconfig`, `$XDG_CONFIG_HOME/pkb/config`, `PKB_CONFIG_GLOBAL` | `~/.gitconfig` … |
| Environment | `PKB_DIR`, `PKB_WORK_TREE`, `PKB_OBJECT_DIRECTORY`, `PKB_CEILING_DIRECTORIES`, `PKB_AUTHOR_NAME/EMAIL/DATE`, `PKB_COMMITTER_NAME/EMAIL/DATE`, `PKB_EDITOR`, `PKB_TEMPLATE_DIR` | `GIT_*` |
| Global option | `--pkb-dir=<path>` | `--git-dir=<path>` |
| Messages | `pkb: 'x' is not a pkb command…`, `Initialized empty pkb repository in …/.pkb/`, hints such as `use "pkb add <file>…"` | git's wording |
| Version | `pkb version 0.1.0` | `git version 2.52.0.windows.1` |
| `pkb` / `pkb help` | lists only pkb's commands | git's command list |
| Hooks | no sample hooks are copied on `init` | git copies `hooks/*.sample` |

Kept identical on purpose:

- **On-disk formats:** loose objects (`"<type> <size>\0"`, SHA-1 ids, zlib), index v2 with the cache-tree (`TREE`) extension, loose refs, `packed-refs`, reflogs, and read-only `.pack`/`.idx` v2 files.
- **Config file syntax and key names** (`core.*`, `init.defaultBranch`, `advice.*`).
- **The `diff --git` patch header**, so pkb patches still apply with `git apply` or `patch`.

Because the formats match, the real git can work on a pkb repository when pointed at it with `GIT_DIR=.pkb GIT_WORK_TREE=.` (or `--git-dir=.pkb --work-tree=.`). Add `/.pkb/` to `.pkb/info/exclude` first; git only hides directories named `.git`. Note that git reads `.gitignore`, not `.pkbignore`.

## Run it

Requires Node ≥ 23.6, which runs TypeScript directly. There is no build step and no runtime dependencies.

```
node bin/pkb.mjs <command> ...      # or bin\pkb.cmd on Windows; `npm link` puts `pkb` on PATH
npm test                            # parity suite + interop suite (needs the real git.exe as referee)
npm run typecheck                   # tsc --strict --noEmit (after npm install of the two devDependencies)
npm run capture                     # re-record golden fixtures from the real git
```

## Commands

| Command | Supported options |
|---|---|
| `init` | `-q`, `--bare`, `-b`/`--initial-branch`, `--template`, `[<dir>]`, reinitialising an existing repo |
| `hash-object` | `-t`, `-w`, `--stdin`, `--stdin-paths`, `--literally` |
| `cat-file` | `-t`, `-s`, `-e`, `-p`, `<type> <object>`; revision syntax `rev~N`, `rev^N`, `rev^{type}`, `rev:path`, `:path`, abbreviated ids |
| `add` | pathspecs and globs, `.`, `-A`, `-u`, `--no-all`, `-f`, `-n`, `-v` |
| `write-tree` | `--prefix=<dir>/`, `--missing-ok` |
| `commit` | `-m` (repeatable), `-F <file>`/`-F -`, `-a`, `-q`, `--allow-empty`, `--allow-empty-message`, `--amend`, `--cleanup`, `--author`; editor (`PKB_EDITOR`, `core.editor`, `VISUAL`, `EDITOR`) when no message is given |
| `status` | long format, `-s`, `-b`, `--porcelain[=v1]`, `-u[no]`; detached HEAD; paths relative to the current directory |
| `log` | medium (default), `--oneline`, `--pretty=short\|full\|oneline`, `--format=` (`%H %h %T %t %P %p %an %ae %ad %at %cn %ce %cd %ct %s %b %B %n`), `-n`/`-<n>`, `A..B`, `^A`, `--reverse`, `--first-parent`, `-- <path>` |
| `diff` | work tree vs index, `--cached`/`--staged`, `<commit>`, `<a> <b>`, `a..b`, `-U<n>`, `--exit-code`, `--quiet`, `--stat`, `--shortstat`, `--name-only`, `--name-status`, `-- <path>`, binary files, exact renames, `--no-index` for two files |
| `branch` | list, `-v`/`-vv`, `-r`, `-a`, `--show-current`, create `[<start>]`, `-f`, `-d`, `-D`, `-m`/`-M` (rename, also on an unborn branch), `-c`/`-C` (copy), `-u`, `--unset-upstream` |
| `checkout` / `switch` | branches, `-b`/`-B`/`-c`/`-C`, detached HEAD (`--detach`), `-`, restoring paths from the index or a commit, refusing to overwrite local changes or untracked files, `-f` |
| `merge` | fast-forward only: `--ff-only`, `-q`, `-n`/`--no-stat`; writes ORIG_HEAD |
| `clone` | `<url> [<dir>]`, `-q`, `-b <branch>`, `-o <name>`, `-n`; HTTPS/HTTP smart protocol or a local path; empty repositories |
| `fetch` | `[<remote>\|<url>] [<refspec>...]`, `-q`, `-p`/`--prune`, `--all`; tags pointing into fetched history follow along; writes FETCH_HEAD |
| `push` | `[<remote>\|<url>] [<refspec>...]`, `-u`/`--set-upstream`, `-f`/`--force`, `-d`/`--delete`, `--tags`, `-q`; `src:dst`, `:dst`, `HEAD:refs/heads/x`; fast-forward checks with git's rejection messages |
| `pull` | `[<remote> [<refspec>...]]`, `--ff-only`, `-q`, `-n`; fetch, then fast-forward. Divergent history is refused with git's "Need to specify how to reconcile divergent branches." `pull.ff=only` is honoured; `--rebase`, `pull.rebase=true` and `--no-ff` are refused as unsupported |
| `remote` | list, `-v`, `add <name> <url>`, `remove <name>`, `get-url`, `set-url` |

**Remote URLs:**
- `https://…` and `http://…` (smart protocol);
- `ssh://[user@]host[:port]/path` and scp-style `[user@]host:path`, such as `git@github.com:owner/repo.git`;
- local paths.

For SSH, pkb runs `PKB_SSH_COMMAND`, else `core.sshCommand`, else `PKB_SSH`, else `ssh` from PATH. The remote command is `git-upload-pack '<path>'` or `git-receive-pack '<path>'`, so any git server works, GitHub included. Keys, agents and `known_hosts` are handled entirely by your ssh client.
| `version`, `--version`, `help`, bare `pkb` | help lists pkb's commands; "did you mean" suggestions |

Upstream tracking is supported throughout. `status` and `switch` report "Your branch is ahead of 'origin/master' by 1 commit." (and the behind/diverged forms). `status -sb` shows `## master...origin/master [ahead 1]`. `branch -vv`, `-r`, `-a`, `-u <upstream>` and `--unset-upstream` work. `checkout <name>` creates a tracking branch from `origin/<name>`, and `merge` with no argument fast-forwards to the upstream.

## Using pkb with GitHub

```
pkb clone https://github.com/<owner>/<repo>.git        # public repos need no login
cd <repo>
# ...edit, pkb add, pkb commit...
pkb push                                               # needs a token, see below
pkb pull                                               # take others' work (fast-forward)

# an existing local project
pkb remote add origin https://github.com/<owner>/<repo>.git
pkb push -u origin master
```

Pushing to GitHub needs a personal access token (GitHub → Settings → Developer settings → Personal access tokens, with "Contents: read and write" on the repository). pkb looks for credentials in this order, and only asks after the server returns 401:

1. In the URL: `https://<user>:<token>@github.com/...`. Simple, but the token then sits in `.pkb/config`.
2. The environment: `PKB_TOKEN=<token>`, plus `PKB_USERNAME` (default `x-access-token`).
3. A credential helper, using git's helper protocol. For example, Git Credential Manager, which ships with Git for Windows and remembers a browser login:

   ```
   # in ~/.pkbconfig
   [credential]
   	helper = manager
   ```

   pkb runs `git-credential-<name>` from PATH or from Git's install folder. A value starting with `!` runs a shell command.

With no credentials, push stops with `could not read Username for 'https://github.com': terminal prompts disabled`; pkb never prompts. With a wrong token it stops with `Authentication failed for '<url>/'`.

Verified against GitHub itself: `pkb clone https://github.com/octocat/Hello-World.git` produced the same commits and work tree as `git clone`, and byte-identical `.pack`, `.idx` and `.rev` files. `pkb push -u origin main` to `github.com/aprasad098765/Test` succeeded using Git Credential Manager's stored login, and a fresh `git clone` then passed `git fsck`.

### SSH with GitHub

pkb uses your existing SSH setup. If `ssh -T git@github.com` greets you, pkb works too. To set it up once:

```
ssh-keygen -t ed25519 -C "you@example.com"        # creates %USERPROFILE%\.ssh\id_ed25519(.pub)
# add the .pub file at GitHub -> Settings -> SSH and GPG keys
ssh -T git@github.com                             # answer "yes" to trust GitHub's host key
pkb clone git@github.com:<owner>/<repo>.git
pkb remote set-url origin git@github.com:<owner>/<repo>.git   # switch an existing clone to ssh
```

SSH was verified end to end with a stand-in `ssh` (`harness/fake-ssh.mjs`) that runs the real `git-upload-pack` and `git-receive-pack`. The same protocol exchange happens with GitHub, but SSH has not been run against github.com here, because this machine has no SSH key registered with GitHub.

Global options: `-C <dir>`, `-c key=value`, `--pkb-dir`, `--work-tree`, `--bare`. Pager options are accepted and ignored.

## Verification

The expected output for pkb is the real git's recorded output passed through one mapping, `rebrand()` in `src/brand.ts`. It turns `git` into `pkb`, `.git` into `.pkb` and `.gitignore` into `.pkbignore`, and keeps the `diff --git` header unchanged. The same function generates pkb's usage text (`recon/gen-usage-text.mjs`), so its wording follows git's observed output exactly.

| Check | Result |
|---|---|
| Parity suite (`harness/parity.mjs`): 106 scenarios, 16 of them network ones (HTTP via a local `git-http-backend`, SSH via `fake-ssh.mjs`, pull); compares stdout, stderr and exit code of every step, plus the resulting `.pkb`, the work tree and the server's refs, against the real git's fixtures | **106/106 scenarios, 747/747 steps** |
| Held-out sets, recorded first and only then fixed: 16 local (`tests/holdout-initial-report.json`), 4 network (`tests/net-holdout-initial-report.json`), 1 pull-over-ssh (`tests/pullssh-holdout-initial-report.json`) | first runs: local 12/16 (143/152 steps); network 1/4 (39/41 steps); pull/ssh 14/14 steps with one `ORIG_HEAD` difference; all pass now |
| Real `git fsck --full --strict` (via `--git-dir`) on every repository pkb produced | **95/95 clean** |
| Interop (`tests/interop.mjs`): real git → pkb on a repository repacked by `gc`; pkb → real git; pkb reading all 150 objects of an `--aggressive` delta pack; push credentials (none, wrong `PKB_TOKEN`, right `PKB_TOKEN`, credential helper); clone with no identity configured | **all checks pass** |
| Received packs: pkb's `.idx`/`.rev` versus git's for the same pack (local server and github.com) | **byte-identical** |
| Same objects: identical object ids and inflated content | **all objects** |
| Same compressed bytes for each object | **254/431**, see the first known difference below |
| Type-check (`tsc --strict`) | clean |

Each of the 27 required ledger obligations is exercised by at least one passing scenario that includes failure cases (`tests/parity-report.json`). Two outputs are pkb's own by design (the help text and the version string) and are checked against pkb's values.

### REA reconstruction checks

These ran but cannot pass on this host, for the reasons given.

| REA operation | Result | Why |
|---|---|---|
| `build_reconstruction_obligation_ledger` (`rea-evidence/obligation-ledger-final.json`) | status `open`: 27 implemented, 0 verified, 2 out of scope | Each obligation is bound to its owning module (path, symbol, SHA-256) and to static evidence from git.exe. `missing-verifier` and `missing-case` remain because the fixtures and verifier would need REA process-capture evidence. |
| `evaluate_reconstruction_coverage` for boundary `git.v1` (`rea-evidence/coverage-evaluation.json`) | **partial**: 27/27 surfaces owned; 27 `verifier-missing`; build proof missing | Same cause: no REA verifier results. |
| `verify_reconstruction` (`rea-evidence/verify-reconstruction-result.json`) | rejected: "Comparison Evidence identity or authority disagrees" | It requires comparison evidence from `compare_process_captures`. On native Windows, `capture_process_scenario` returns `capability_unavailable`. |

`tests/rea-scenario.mjs real|pkb` is ready for REA capture on Linux or macOS. Locally, its output for real git (after `rebrand()`) and for pkb is identical.

## Known differences and gaps

1. **Compressed bytes of loose objects.** Node bundles Chromium's zlib fork (`1.3.2.1-motley`), and no setting reproduces git's `zlib1.dll` output. The header is the same (`78 01`, level 1), and ids and contents are the same; the deflate stream differs for about 40% of objects. Real git reads them without complaint.
2. **`merge` is fast-forward only.** When branches have diverged, pkb stops with a fatal error; `--no-ff` and octopus merges are refused.
3. **Diff algorithm.** It is Myers' algorithm, with each ambiguous run of changes slid as far down as possible. git's indent heuristic is not implemented, so hunks in code with repeated lines can be placed differently. There is no `--patience`/`--histogram`/`--word-diff`, and rename detection finds exact (100%) renames only.
4. **No line-ending conversion, attributes or filters.** pkb has no system config, and no `core.autocrlf`.
5. **Index.** Reads versions 2 and 3 and writes version 2. Only the `TREE` extension is kept, and version 4 is refused. Whether a TREE node is marked valid can differ from git, because git's choice depends on file timestamps.
6. **Hints mention commands pkb does not have.** git's advice text names `restore`, `rm --cached`, `config` and `rebase`, and these appear rebranded (for example `use "pkb restore <file>..."`). pkb implements only the commands in the table above.
7. **Status.** No upstream/ahead-behind lines, no merge or rebase states, no submodules, no stash.
8. **Log.** No decorations, no `--graph`, and a reduced `--format` set. Path limiting compares each commit only with its first parent.
9. **Not implemented:** hooks, pager, colour, sparse checkout, worktrees, signing, `.mailmap`, and pathspec magic. Unknown commands report `pkb: '<x>' is not a pkb command`.
10. **Stat fields.** On Windows, `ctime` is taken from the file's creation time and dev/ino/uid/gid are 0. Linux and macOS are untested.
11. **Guessed wording.** A few error messages for rare paths were never observed and are marked `// unverified wording` in the code. They are in branch, checkout, init and remote, plus push's "no upstream branch" and "No configured push destination".
12. **Networking limits:**
    - smart HTTP(S), SSH and local paths only; no dumb HTTP, no `git://`;
    - protocol v0 only, with a single negotiation round that sends up to 256 "have" commits, so fetches into large histories may download more than strictly needed;
    - no shallow or partial clones, no LFS, no submodules;
    - push sends full objects without deltas, so uploads are larger than git's;
    - `pull` only fast-forwards (no rebase, no merge commits). That matches git 2.52's default, which also refuses divergent pulls until `pull.rebase` or `pull.ff` is configured;
    - no progress meters.
13. **User agent.** pkb identifies itself to HTTP servers as `git/2.0 (pkb/0.1.0)`, because GitHub serves the smart protocol only to `git/` user agents. Its protocol-level agent is `pkb/0.1.0`.

### Reverse-engineering process gaps

- `inspect_binary_layout` supports Linux binaries only, and `inspect_with_objdump` fails on Windows. `binary_overview`, `list_segments` and `inspect_pe_resources` were used instead.
- `trace_feature` / `trace_call_path` were not run for every command. Handlers were found from the decoded builtin table (`rea-evidence/cmd-table.json`) and from cross-references to their strings, then decompiled.
- REA process capture is unavailable on Windows (see above).

## Layout

| Path | Contents |
|---|---|
| `src/` | The implementation: `brand.ts` (name, paths, env, `rebrand()`, help), `cli.ts`, `repo.ts`, `odb.ts`, `objects.ts`, `dircache.ts`, `refs.ts`, `revparse.ts`, `ignore.ts`, `worktree.ts`, `diff.ts`, `wtstatus.ts`, `remote.ts` (refspecs, upstreams), `pack.ts` (pack parse/index/write), `net/` (pkt-line, smart-HTTP and local transports, credentials), `commands/*` |
| `src/usage-text.ts` | Usage text, generated from the fixtures through `rebrand()` |
| `bin/` | `pkb.mjs` and `pkb.cmd` launchers |
| `harness/` | Scenario definitions (main, held-out, network), runner, local smart-HTTP test server (`http-server.mjs`, wraps git-http-backend), stand-in ssh (`fake-ssh.mjs`, runs git-upload-pack/receive-pack), fixture capture (real git), parity diff (pkb vs rebranded fixtures), transcript |
| `fixtures/` | 106 golden recordings (16 network) from the real git (`result.json`, plus `dotgit/` with the raw `.git` bytes), and `TRANSCRIPT.md` |
| `tests/` | `interop.mjs`, `rea-scenario.mjs`, `parity-report.json`, `holdout-initial-report.json`, `net-holdout-initial-report.json`, `pullssh-holdout-initial-report.json`, `unit/pack-index.ts` (idx/rev vs git) |
| `rea-evidence/` | Findings, the decoded command table, Phase 1 and final evidence bundles, obligation ledgers, coverage input and evaluation, and the `verify_reconstruction` outcome |
| `recon/` | Scripts that produced the evidence, the ledger and the verification inputs |

## Licence note

pkb reproduces git's behaviour and on-disk formats. Its usage text is derived from git's observed output, so the project is GPL-2.0-only (git is GPLv2).
