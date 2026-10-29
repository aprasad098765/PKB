# 01 - Front-end dispatcher (git.exe 2.52.0, sha256 fc0f1cae...4363)

Static analysis only (Ghidra via REA). Names in parentheses are working labels inferred from
behaviour and embedded `git.c`/`setup.c`/`usage.c`/`help.c` trace strings; the binary is stripped.
Confidence: **observed** = read directly in pseudocode/bytes; **inferred** = interpretation.

## Evidence index
| id | operation | subject |
|---|---|---|
| E1 `ev_0a845de6bf63...cb7` | batch_decompile | FUN_140002f80 (cmd_main), FUN_140002e60 (is_builtin) |
| E2 `ev_e496c5236a20...594f38` | pseudo_code | FUN_140001480 (handle_builtin + inlined run_builtin) |
| E3 `ev_64876aab4758...87e9` | batch_decompile | FUN_140002880 (handle_alias), FUN_140282190 (setup_work_tree), FUN_1402c49d0 (die), FUN_1402c4a60 (die_errno), FUN_14013d180 (common exit) |
| E4 `ev_bd617fa2650c...24bd0` | read_bytes 0x14033e320 | usage.c routine pointer table |
| E5 `ev_eb645c577cad...e91e0` | batch_decompile | FUN_1402c4300 (die_builtin), FUN_1402c4750 (warn), FUN_1402c47c0 (error), FUN_1402c4830 ("fatal: " reporter) |
| E6 `ev_f742b95cfe82...37ef` | search_strings | "not a git repository" |
| E7 `ev_77fa3df2b65d...4bf` | search_strings | "is not a git command" |
| E8 `ev_0398063ff3e6...7df133` | pseudo_code | FUN_14019f280 (help_unknown_cmd) |
| E9 `ev_7aede93581da...b360` | pseudo_code | FUN_140284380 (setup_git_directory_gently) |
| E10 `ev_22e3435140ed...60b68` | pseudo_code | FUN_1402850d0 (setup_git_directory) |
| E11 `ev_d3dea0970f0f...0b68` | pseudo_code | FUN_140283100 (setup_git_directory_gently_1 / discovery walk) |
| E12 `ev_95c55b29b1b6...960e` | batch_decompile | FUN_1402c45d0 (usage_builtin), FUN_1400019d0 (handle_options) |
| E13 `ev_fb45914a29f9...c13`, `ev_7516e2d11924...975` | pseudo_code | FUN_1402c4960 / FUN_1402c4920 (usage wrappers -> FUN_1402c45d0) |
| E14 `ev_d7a8d54b3969...2f03`, `ev_0ae8583c3513...1e0` | search/xrefs | "usage: " @0x1403d1807, refs 0x1402c45da, 0x1402c4656 |
| E15 `ev_dba43ce6296a...826`, `ev_827536826bc4...c80`, `ev_6c875c8787fb...9bb8` | strings/xrefs/resolve | "gitdir: " @0x1403c94f0 used in FUN_140282bf0 |
| E16 `ev_1c8146cb6889...595`, `ev_ea153b22dbe6...fb6`, `ev_7bc2747d4ee9...f42` | xrefs/resolve/read_bytes | not-a-repo string xref 0x140284841 in FUN_140284380; DAT_1403c9515 = ".git" |
| E17 `ev_cf1f143d2f57...b3` | callers | FUN_140002e60 called only from 0x14006cef0 |

## A. Call structure (observed, E1/E2)
- **FUN_140002f80 = cmd_main.** Strips dir from argv[0]; if basename starts `git-` it calls
  FUN_140001480 directly and if that returns dies `cannot handle %s as a builtin` (die -> 128).
  Otherwise calls **FUN_1400019d0 (handle_options)** on argv+1, handles `--version`/`-v` -> "version",
  `--help`/`-h` -> "help", then loops: builtin -> dashed external -> alias -> help_unknown_cmd.
- **FUN_140002e60 = is_builtin(name)**: linear strcmp over table 0x14032e000..0x14032edc8 (stride 3 qwords),
  returns 1/0. Only caller 0x14006cef0 (E17). Not on the main dispatch path.
- **FUN_140001480 = handle_builtin with run_builtin inlined.** Strips trailing `.exe` (compare with
  0x6578652e), rewrites `git <cmd> --help` -> `git help --exclude-guides <cmd>`, looks up table; if not
  found it *returns* (caller falls through to externals). If found it applies option bits, calls
  `entry->fn(argc, argv, prefix, repo)` at the `(*(code*)ppuVar9[1])(...)` call, then exits via
  `exit(FUN_14013d180("git.c",0x30f,status))` - i.e. builtin return value becomes the process exit code.
- `DAT_14032edc8` (the qword right after the table) = global `use_pager` (-1 unset, 0 no, 1 yes). Set by
  `-p/--paginate` (1) and `-P/--no-pager` (0) in FUN_1400019d0.

## B. Option bits (cmd-table uint32 at entry+0x10)
| bit | meaning | where tested | evidence | conf |
|---|---|---|---|---|
| 0x01 | RUN_SETUP: `FUN_1402850d0()` = `FUN_140284380(NULL)` (non-gentle discovery, dies if no repo); prefix returned; `repo` arg passed to builtin (local_ac=0) | FUN_140001480 `if ((uVar12 & 1) != 0)` at LAB_1400015b0 (~0x1400015b0) | E2, E10 | observed |
| 0x02 | RUN_SETUP_GENTLY: `FUN_140284380(&nongit)`; repo pointer passed to builtin only if nongit==0 | FUN_140001480 `uVar14 = uVar12 & 3; if (uVar14 != 0) goto LAB_140001762` | E2 | observed |
| 0x01 + help | for `git <cmd> -h` / `--help-all` with argc==2, a RUN_SETUP builtin is set up *gently* instead (no die) | FUN_140001480 `bVar1 = true; if ((uVar12&1)==0) goto ...; LAB_140001762` | E2 | observed |
| 0x04 | USE_PAGER: if use_pager still -1 and no `pager.<cmd>` config, force use_pager=1 | FUN_140001480 `((ulonglong)ppuVar9[2] & 4)` (LAB_14000191f sets DAT_14032edc8=1); also no-args path at `(uVar12 & 4)==0` | E2 | observed |
| 0x08 | NEED_WORK_TREE: `FUN_140282190()` (setup_work_tree) unless help mode | FUN_140001480 `if ((!bVar1) && ((ppuVar9[2] & 8) != 0))` at LAB_1400015ea | E2, E3 | observed |
| 0x10 | DELAY_PAGER_CONFIG: skip `FUN_1401f30e0(repo, cmd)` (pager.<cmd> config lookup) in the dispatcher | FUN_140001480 `if ((ppuVar9[2] & 0x10) != 0)` | E2 | observed (meaning inferred from name) |
| 0x20 | NO_PARSE_OPT: only consulted by `--list-cmds=parseopt`, which lists builtins *without* 0x20 | FUN_1400019d0 `if ((ppuVar15[2] & 0x20) == 0) FUN_140291ef0(...)` | E12 | observed |
| 0x40 | DEPRECATED: in cmd_main, when bit set, alias expansion (FUN_140002880) is tried *before* running the builtin; also listed by `--list-cmds=deprecated` | FUN_140002f80 `if ((ppuVar17[2] & 0x40) != 0 && FUN_140002880(...) != 0)`; FUN_1400019d0 `& 0x40` | E1, E12 | observed |

Table values from cmd-table.json decode as: add/commit/status/checkout/switch/merge 0x09 = RUN_SETUP|NEED_WORK_TREE;
branch 0x11 = RUN_SETUP|DELAY_PAGER_CONFIG; log/cat-file/write-tree 0x01 = RUN_SETUP; diff 0x20 = NO_PARSE_OPT
(diff does its own setup); init/hash-object 0x00 (inferred decode).

Pager application (observed, E2): after setup, if use_pager==0 -> `FUN_1402f6b40("GIT_PAGER", DAT_140346063, 1)`
(setenv; value at 0x140346063 not dumped - likely "cat", inferred); if ==1 -> `FUN_1401f2cd0(repo)` (setup_pager).
If `*PTR_DAT_14033d718` (startup_info->have_repository, inferred) is set, `FUN_14029ee00(repo)` is called first
(inferred: commit_pager_choice / repo config). Trace2 string `"trace: built-in: git"` logged at git.c:0x1f6.

Post-builtin stdout check (observed, E2, only when status==0 and stdout is not a pipe/FIFO (`st_mode&0xf000 != 0x1000`)):
- fflush failure -> die_errno `write failure on standard output` (128)
- ferror -> die `unknown write failure on standard output` (128)
- fclose failure -> die_errno `close failed on standard output` (128)

## C. Work-tree requirement (observed, E3)
FUN_140282190 (setup_work_tree): returns if already initialized (DAT_140435238). If config is invalid
(DAT_140435258) -> die `unable to set up work tree using invalid config`. If `FUN_140255e00(repo)` (work tree)
is NULL or chdir to it fails -> die **`this operation must be run in a work tree`** -> `fatal: ...` on stderr,
exit **128**. On success it unsets `GIT_WORK_TREE` env if it was set.

## D. die / error / usage routines (observed, E3/E4/E5/E12/E13)
- Routine pointer table at 0x14033e330..0x14033e348 (E4): 0x330 -> FUN_1402c4dc0 (die_is_recursing),
  0x338 -> FUN_1402c4750 (warn_routine), 0x340 -> FUN_1402c47c0 (error_routine), 0x348 -> FUN_1402c4300 (die_routine).
- **die = FUN_1402c49d0**, **die_errno = FUN_1402c4a60**: recursion guard prints
  `fatal: recursion detected in die handler\n` / `fatal: recursion detected in die_errno handler\n` and exits 0x80;
  otherwise calls die_routine.
- **die_routine FUN_1402c4300**: `FUN_1402c4830(...)` then `exit(FUN_14013d180("usage.c",0x57,0x80))` -> **exit 128**.
- **FUN_1402c4830**: prefix `"fatal: "` (gettext'd), writes to `__acrt_iob_func(2)` = **stderr** via FUN_1402c4450 (vreportf).
- **error_routine FUN_1402c47c0**: prefix `"error: "`, stderr, returns (no exit; callers typically return -1, inferred).
- **warn_routine FUN_1402c4750**: prefix `"warning: "`, stderr.
- **usage_routine FUN_1402c45d0**: prefix `"usage: "` (0x1403d1807), stderr, `exit(FUN_14013d180("usage.c",0x42,0x81))` -> **exit 129**.
  Reached via FUN_1402c4960 -> FUN_1402c4920 -> FUN_1402c45d0 (E13). FUN_1402c4960's pseudocode is garbled
  (Ghidra treats FUN_1402c4920 as returning); treat the 129 path as observed for FUN_1402c45d0, inferred for the wrapper.
- `PTR_FUN_140345b70` = `__acrt_iob_func`: arg 2 = stderr, arg 1 = stdout (inferred from usage with _fileno/fclose).
- **FUN_14013d180 (common exit)**: flushes stdout, errors with BUG `on exit(): had bug() call(s) in this process without explicit BUG_if_bug()`
  if a bug() was recorded, else trace2 exit and returns code unchanged.

## E. "not a git repository" (observed, E6/E9/E10/E16)
Emitted by **FUN_140284380 (setup_git_directory_gently)** only when called with `nongit_ok == NULL`
(i.e. via RUN_SETUP / FUN_1402850d0); with a non-NULL pointer it sets `*nongit_ok = 1` and continues.
All go through die (FUN_1402c49d0) -> stderr `fatal: ` + text, **exit 128**. Switch on discovery result:
- -1: `not a git repository (or any of the parent directories): %s` with `%s` = `.git` (DAT_1403c9515) ->
  final text **`fatal: not a git repository (or any of the parent directories): .git`**
- -2: `not a git repository (or any parent up to mount point %s)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).`
- -4: `detected dubious ownership in repository at '%s'\n%sTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory %s`
- -5: `cannot use bare repository '%s' (safe.bareRepository is '%s')` (`explicit`/`all`)
- other: BUG `unhandled setup_git_directory_gently_1() result` (setup.c:0x724)
- Also `Unable to read current working directory` (die_errno), `cannot change to '%s'`, `cannot come back to cwd`.
Other variants in strings (not on this path): `not a git repository: %s` @0x1403c9495, `not a git repository: '%s'` @0x1403c978b,
`Not a git repository. Use --no-index to compare two paths outside a working tree` @0x14039ec48 (diff).
On success sets `GIT_PREFIX` env to the prefix (or empty) and `startup_info->have_repository=1` (inferred field).

## F. Unknown command (observed, E1/E8)
cmd_main loop order: builtin (FUN_140001480) -> external `git-<cmd>` via run_command (FUN_140265fd0, trace
`_run_dashed_`; non-ENOENT failure -> exit 128 via git.c:0x33b; success -> exit with child status) -> alias
(FUN_140002880) -> first time only, **FUN_14019f280 (help_unknown_cmd)**.
- help_unknown_cmd prints to **stderr**: **`git: '%s' is not a git command. See 'git --help'.`** (fprintf_ln, inferred
  newline), optionally `\nThe most similar command is` / `\nThe most similar commands are` + list, then
  `exit(FUN_14013d180("help.c",0x301,1))` -> **exit 1**. Same message + exit 1 at help.c:0x291 when
  help.autocorrect is "never"(-2) or prompt mode without a TTY.
- Autocorrect: `WARNING: You called a Git command named '%s', which does not exist.` then
  `Continuing under the assumption that you meant '%s'.` (immediate) / `Continuing in %0.1f seconds, assuming that you meant '%s'.` /
  prompt `Run '%s' instead [y/N]? ` (no -> exit 1, help.c:0x2e6). Returns corrected name; cmd_main retries once.
- If the corrected command also fails: `failed to run command '%s': %s\n` on stderr, return 1.
- Alias failure: `expansion of alias '%s' failed; '%s' is not a git command\n` stderr, exit 1 (git.c:0x3e1).
- `'%s' appears to be a git command, but we were not\nable to execute it. Maybe git-%s is broken?` -> die 128.
- `Uh oh. Your system reports no Git commands at all.` -> die 128.
- Alias errors (FUN_140002880, all die 128): `bad alias.%s string: %s`, `alias '%s' changes environment variables.\nYou can use '!git' in the alias to do this`,
  `empty alias for %s`, `recursive alias: %s`, `alias loop detected: expansion of '%s' does not terminate:%s`,
  `while expanding alias '%s': '%s'` (die_errno). `'%s' is aliased to '%s'` printed on stderr for `git <alias> -h`.

## G. No-argument / global options (observed, E1/E12)
- `git` with no command: `printf("usage: %s\n\n", <usage string>)` + common-cmds list + "'git help -a' and 'git help -g' list available subcommands..."
  to **stdout**, `exit(1)` (git.c:0x3c3). (Not the 129 usage routine.)
- handle_options unknown global option: stderr `unknown option: %s\n` then usage() -> stderr `usage: git [-v | --version] ...` exit **129**.
  Same for `no directory given for '%s' option\n` (--git-dir, --work-tree, -C), `no namespace given for --namespace\n`,
  `-c expects a configuration string\n`, `no config key given for --config-env\n`, `no attribute source given for --attr-source\n`.
- `--exec-path`/`--html-path`/`--man-path`/`--info-path` print to stdout via puts and exit 0.
- `--git-dir[=]` -> setenv GIT_DIR; `--work-tree[=]` -> GIT_WORK_TREE; `--namespace` -> GIT_NAMESPACE; `--bare` -> GIT_DIR=cwd,
  DAT_14033a058=1 (is_bare_repository_cfg), GIT_IMPLICIT_WORK_TREE=0; `-C` chdir (die_errno `cannot change to '%s'`);
  `--no-optional-locks` -> GIT_OPTIONAL_LOCKS=0; `--no-advice` -> GIT_ADVICE=0; `--no-lazy-fetch` -> GIT_NO_LAZY_FETCH=1;
  `--no-replace-objects` -> GIT_NO_REPLACE_OBJECTS=1; `--literal/glob/noglob/icase-pathspecs` -> corresponding env vars;
  `--list-cmds=` types: builtins, main, others, config, nohelpers, alias, deprecated, parseopt, list-<cat>; else die
  `unsupported command listing type '%s'`. param_3 (`envchanged`) set for options that alter environment.

## H. Repository discovery (observed, E9/E11/E15; brief)
FUN_140283100 (setup_git_directory_gently_1):
1. If env `GIT_DIR` set -> use it (result 1, then FUN_140284030 = setup_explicit_git_dir).
2. Else read `GIT_CEILING_DIRECTORIES` (split, longest matching ceiling limits walk) and
   `GIT_DISCOVERY_ACROSS_FILESYSTEM` (bool; if false, compare device id via stat each step -> result -2 on change).
3. Loop from cwd upward: append `.git`; FUN_140282bf0 (read_gitfile_gently, uses `"gitdir: "` @0x1403c94f0) - a
   `.git` *file* with `gitdir: <path>` redirects; a `.git` directory is validated by FUN_140281e50 (is_git_directory).
   Found -> ownership check FUN_140280670 (safe.directory) -> result 2 (or -4 dubious ownership).
4. Else test cwd itself as a bare repo (FUN_140281e50): trace `implicit-bare-repository`; `safe.bareRepository=explicit`
   rejects unless path is inside `/.git/worktrees/` or `/.git/modules/` (-5); else result 3 (bare; sets
   `GIT_IMPLICIT_WORK_TREE`).
5. Strip last `/` or `\` component and repeat; reaching root/ceiling -> -1.
`GIT_WORK_TREE` env / core.worktree (DAT_1404236c0) influence work-tree setup in FUN_140284380 cases 2/3.

## Open questions
- Exact value at 0x140346063 (GIT_PAGER value for --no-pager) not read; expected "cat".
- FUN_14029ee00 role (called when have_repository) not decompiled.
- FUN_14028fb40 assumed to be fprintf_ln (adds newline) - not verified.
- Caller 0x14006cef0 of is_builtin not identified.
