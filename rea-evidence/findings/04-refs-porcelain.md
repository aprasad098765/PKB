# 04 - Refs, reflog and porcelain output (init, commit, branch, checkout/switch, merge, log, diff)

Target: Git for Windows 2.52.0 `git.exe` sha256 fc0f1cae1304fcdcf4d0749f421c5ed21471efc856301f92f56d4b844be84363
Method: static only (Ghidra via REA): search_strings, xrefs, pseudocode, read_bytes. Function names are FUN_<addr>.
The names in parentheses (e.g. "init_db") are the investigator's labels, inferred from behavior; they are not symbols.
Confidence: **observed** = the string or logic appears directly in REA output; **inferred** = deduced from context or from
how git is known to behave, without a direct trace.

Key string-search evidence ids used throughout:
- S1 ev_dd2b2fd9828aefb54a1c3ffa33f929bf893a64ffaf424471f1326c922e965559 (Initialized empty)
- S2 ev_72ee4c0b1ab180b0b5f2c71aa1f57189e8c987868a443f5baaf6ce8380265c1b (Reinitialized / core.* / ref: / master)
- S3 ev_d8abb63ec6a6e91b14f2b0ff0f1cac79985d3a633318187c12dafe72a5f145b5 (reflog msgs, root-commit, nothing to commit)
- S4 ev_85ac1be49c7b0f7c56c46d045bf513d7c8125ae056a7caa94dd65eb6c964c4d3 (branch/checkout/merge/ident errors)
- S5 ev_119f3c87c8e724804b7792a1a6442d9e10c3542a922ef358eb17584e71c3fb79 (diff/stat/log headers)
- S6 ev_f1112c46d24fdd84e37f5c371bee82801285917557c66c64e7ccba02b5e96c30 (index line, hunk header, algorithms)
- S7 ev_1fb065afd64c9897559a91eb6ea07fb823687977ed94ec5585dd308a621ff573 (date fmts, mode lines, nothing added)
- S8 ev_449c0168bbf689161009f3ba0275981e51369f6d1b9261ff0e04d551a2ce0f21 (branch list format, HEAD detached)
- S9 ev_d5c138e26f4a10f0458f2604ee216c28e73bde607a31edfd56ffd88318ea8745 (diff --git, ---/+++ formats)
- S10 ev_cf074ec239107c97ca30600a941213ea22ed75f059a355b2c23e0948e14fc6f4 (xdiff source names, no changes added)

---------------------------------------------------------------------------------------------------
## 1. init

### 1.1 Repository creation driver: FUN_1402856d0 ("init_db")  [observed]
evidence: ev_b3c4b65a057446405a22f176445461d723a9415548931b5507689173ad8b5135 (pseudocode); the xref from 0x140285f41 to the "Initialized" string is ev_9b01a237...
- Final message, printed with printf(fmt, git_dir, suffix):
  - `"Initialized empty Git repository in %s%s\n"` @0x1403c9c18
  - `"Initialized empty shared Git repository in %s%s\n"` @0x1403c9c48
  - `"Reinitialized existing Git repository in %s%s\n"` @0x1403c9bb0
  - `"Reinitialized existing shared Git repository in %s%s\n"` @0x1403c9be0
  - The second %s is "/" (DAT_1403c9ba7) when the git_dir does not already end in '/', and "" otherwise
    (read_bytes ev_8e00d930...: 0x1403c9ba2="true", 0x1403c9ba7="/"). The message is suppressed when flag bit 0 (quiet) is set.
- Config keys written via FUN_140145eb0 (repo_config_set), in this order:
  - `core.repositoryformatversion` = "%d" (FUN_140285210, ev_52ea856e...). The value is 0 for sha1 with the files backend; it is 1 when
    `extensions.objectformat` or `extensions.refstorage` is needed (those are written in that case).
  - `core.filemode` = "true"/"false", decided by a chmod/stat probe on `config` (toggles mode bit 0x40 and re-stats).
    On a Windows NTFS checkout this probe normally yields "false" (inferred: Windows cannot toggle the x bit).
  - When not bare: `core.bare`="false"; then `core.logallrefupdates`="true" if the setting is unset (-1); then `core.worktree`
    only if the work tree is not the parent of git_dir ("/.git" comparison).
  - When bare: `core.bare`="true".
  - Fresh init only (not on reinit): a symlink probe on temp file "tXXXXXX"/"testing". If the symlink test fails,
    `core.symlinks`="false" is written (the typical Windows result, inferred). Then `CoNfIg` is probed for existence;
    if it exists (a case-insensitive filesystem), `core.ignorecase`="true" is written.
  - With shared repo: `core.sharedrepository`="%d" and `receive.denyNonFastforwards`="true".
- Directories: git_dir is created via FUN_1401fb530 (safe_create_dir). The objects dir is created, followed by `<objdir>/pack` and `<objdir>/info`.
  The strings ".git/hooks", ".git/objects/info" and "info/exclude" exist (S7). The template-copy routine
  FUN_140281190 creates the rest (hooks/, info/exclude, description), which is inferred from the template-copy call.
- Environment variables: `GIT_DEFAULT_HASH` and `GIT_DEFAULT_REF_FORMAT` are honored. Errors:
  "attempt to reinitialize repository with different hash" and "unknown ref storage format '%s'".
- Separate git dir: writes the `gitdir: %s` gitfile and errors with "%s already exists".

### 1.2 Templates  [observed]
- In FUN_1402856d0: the template dir comes from FUN_140285190 (config `init.templateDir` @0x140368357 or the compiled default; the source is inferred).
  A '/' is appended, the directory is opened (warns `"templates not found in %s"`), the template `config` is read for its
  repositoryformatversion check (warns `"not copying templates from '%s': %s"`), and then the copy runs via FUN_140281190.

### 1.3 HEAD and initial branch: FUN_140285510 ("create_reference_database")  [observed]
evidence: ev_72a151a5754c239b89ac3bb1da7e10dcead223df7d5062f8f41ecc0023701e9c
- On a fresh init: branch = --initial-branch, otherwise FUN_140226970. It builds `"refs/heads/%s"`, validates it
  (`"invalid initial branch name: '%s'"`), and calls FUN_14022b140(refs, "HEAD" (DAT_1403c8ca9, ev_07ea25f4...), "refs/heads/<b>", NULL),
  which creates a symref. The resulting file content is `"ref: %s\n"` (string @0x1403bf942, referenced only from FUN_140234060
  in the files backend, xref ev_5279cf34...). So HEAD = `ref: refs/heads/master\n` by default.
- On reinit with --initial-branch: warning `"re-init: ignored --initial-branch=%s"`.
- The placeholder `"ref: refs/heads/.invalid"` @0x140353086/0x1403bfd3b exists (used for reftable/clone).

### 1.4 Default branch name: FUN_140226970 ("repo_default_branch_name")  [observed]
evidence: ev_634b646f8ff5b544342d2e8351439b0a1d0b89b0c140b8ec3de96c183cfbfd68, string ev_f74a4527...
- Precedence: env `GIT_TEST_DEFAULT_INITIAL_BRANCH_NAME`, then config `init.defaultbranch`, then `"master"`.
- When it falls back to "master" and is not quiet, it emits advice (FUN_140104950(7, ...), the advice type is inferred to be
  ADVICE_DEFAULT_BRANCH_NAME and is printed with "hint: " prefixes). The text, verbatim @0x1403be1c0:
  ```
  Using '%s' as the name for the initial branch. This default branch name
  will change to "main" in Git 3.0. To configure the initial branch name
  to use in all of your new repositories, which will suppress this warning,
  call:

  	git config --global init.defaultBranch <name>

  Names commonly chosen instead of 'master' are 'main', 'trunk' and
  'development'. The just-created branch can be renamed via this command:

  	git branch -m <name>
  ```
- Validation error: `"invalid branch name: %s = %s"` (with "init.defaultBranch").

---------------------------------------------------------------------------------------------------
## 2. Refs and reflog (files backend)

- Loose ref file content: `<hex>\n`. **inferred**: the write path was not decompiled. The symref form `"ref: %s\n"` is observed (1.3).
- packed-refs header written: `"# pack-refs with: peeled fully-peeled sorted \n"` @0x1403c0dc0, which has a trailing space before \n.
  It is referenced from 0x14023ee93 (xref ev_24d2b3e0...). The reader checks the prefix `"# pack-refs with: "` @0x1403c06d2 and errors
  with `"'%.*s' does not start with '# pack-refs with: '"` @0x1403c0a88 (S? ev_162c753d...).  [observed strings]
- **Reflog line writer** FUN_140230490 ("files_log_ref_write"), ev_ee51627c5fe7a2e23dda3ffa9e8a88291d0e7df06e13b1a94d855c62f5795983  [observed]:
  `strbuf_addf("%s %s %s", hex(old), hex(new), committer)`, where committer defaults to FUN_1401a1c70(0) (git_committer_info:
  "Name <email> <ts> <tz>"). If msg is non-empty, it appends '\t' + msg. It always appends '\n' and then appends the line to the log fd.
  Result: `<old-hex> <new-hex> Name <email> 1700000000 +0000\t<msg>\n`. Old hex is all zeros for creation (inferred: null oid).
  Error: `"unable to append to '%s': %s"`. Bit 0x1000 in flags skips the write (inferred: REF_SKIP_REFLOG).
- The reflog reader/printer callback FUN_14022e0a0 uses `"%s %s %s %I64u %+05d\t%s"` (ev_d882baf0...), so ts and tz are separate fields.
- Reflog paths: "logs/HEAD", "logs/refs/..." (S7, 0x1403b8112).

### 2.1 Reflog messages
- commit (cmd_commit 0x14002ff50, ev_0256e66a840d6902260589ee187ee9eaec013e9dc8338a95ae598c2a0d9e5d67)  [observed]:
  The action comes from `GIT_REFLOG_ACTION` if set. Otherwise: `"commit (initial)"` when there is no parent, `"commit (amend)"`,
  `"commit (merge)"`, `"commit (cherry-pick)"`, `"commit (rebase)"`, and plain `"commit"`.
  FUN_14026fd30 ("update_head_with_reflog", ev_11d39ec1...) builds `action + ": "` (DAT_1403c58b0=": ", ev_4087cbc4...)
  plus the first line of the message including its '\n' (or the whole message + '\n'). It then updates "HEAD" (DAT_1403c544f) in a transaction.
  So the reflog msg is `commit (initial): <subject>` or `commit: <subject>`.
- checkout/switch: `"checkout: moving from %s to %s"` @0x1403511f0 (S3)  [observed string; caller not traced]
- branch create: `"branch: Created from %s"` @0x14039722c (S3)  [observed string]
- merge fast-forward: cmd_merge sets `GIT_REFLOG_ACTION` = "merge" + " %s" per merged head (DAT_14036fb57=" %s", ev_799e724d...).
  FUN_140087e50 ("finish", ev_2d417913575969c2b81cdbbcaa70e29bc9a8fc15023f4fee7d05a0cf2a573cff) formats `"%s: %s"` (action, msg)
  with msg="Fast-forward", so the reflog is `merge <name>: Fast-forward`.  [observed]

---------------------------------------------------------------------------------------------------
## 3. commit (0x14002ff50)

- Summary printer FUN_140270100 ("print_commit_summary"), ev_17cf7d23fc7a0951e516b3b28a5ee6d9f7d61c6e3a0c4a00d3ab079362911796  [observed]:
  - It prints `"[%s%s "` with branch = HEAD's target minus "refs/heads/" (or `"detached HEAD"`) and suffix `" (root-commit)"`
    when flag bit0 is set (the caller sets bit0 = no parent). Then it uses log format `"format:%h] %s"`, giving
    `[master (root-commit) 1a2b3c4] subject`.
  - If author != committer, it adds `"\n Author: "`. With flag bit1 (date/author override) it adds `"\n Date: "` using format `"%ad"`
    (DAT_1403c62da, ev_61db04ac...). When the ident is auto-detected, it adds `"\n Committer: "` plus the long
    "Your name and email address were configured automatically..." advice (2 variants depending on ~/.gitconfig existence).
  - A diffstat follows with rev flags |= 0x25000 and diffopt output_format 0x28 (inferred: DIFF_FORMAT_SHORTSTAT|DIFF_FORMAT_SUMMARY),
    which produces the shortstat plus " create mode ..." summary lines.
- Shortstat strings (diff.c, S5)  [observed]: `" %d file changed"` / `" %d files changed"`, `", %d insertion(+)"` /
  `", %d insertions(+)"`, `", %d deletion(-)"` / `", %d deletions(-)"`, `" 0 files changed\n"`.
- Summary line format `" %s mode %06o "` @0x14039f4a4 (S7) [observed], with "create"/"delete" as the %s arg. It renders as
  ` create mode 100644 <path>` (arg strings inferred). Mode change: `" mode change %06o => %06o"` @0x14039f6f2.
- Nothing to commit (wt-status, S3/S10)  [observed strings]:
  `"nothing to commit (create/copy files and use \"git add\" to track)\n"` @0x1403d7758,
  `"nothing to commit (use -u to show untracked files)\n"` @0x1403d77b0,
  `"no changes added to commit (use \"git add\" and/or \"git commit -a\")\n"` @0x1403d7670, `"no changes added to commit\n"` @0x1403d76b3,
  `"nothing added to commit but untracked files present (use \"git add\" to track)\n"` @0x1403d76d0.
  Exit code 1 in that case is **inferred** (cmd_commit returns `bVar33`, which is true on the early path; not fully traced).
- Empty message aborts (cmd_commit, observed with exit via FUN_14013d180(..,1) => exit status 1):
  `"Aborting commit due to empty commit message.\n"` (builtin/commit.c:0x772),
  `"Aborting commit; you did not edit the message.\n"` (0x777),
  `"Aborting commit due to empty commit message body.\n"` (0x782, amend!).
- Ident errors (ident.c, S4)  [observed strings]: `"Author identity unknown\n"` @0x1403ab97c and
  ```

  *** Please tell me who you are.

  Run

    git config --global user.email "you@example.com"
    git config --global user.name "Your Name"

  to set your account's default identity.
  Omit --global to set the identity only in this repository.

  ```
  @0x1403ab9b8 (other "Committer identity unknown" variants not searched).

---------------------------------------------------------------------------------------------------
## 4. branch (0x140014c00)

- Listing format (ref-filter atom string @0x14034c2a0, S8)  [observed]:
  `%%(if)%%(HEAD)%%(then)* %s%%(else)%%(if)%%(worktreepath)%%(then)+ %s%%(else)  %s%%(end)%%(end)`.
  The current branch gets "* ", a branch checked out in another worktree gets "+ ", and others get two spaces. The %s slots are color codes (inferred).
- Detached display: `"(HEAD detached at %s)"` @0x1403bc73a, `"(HEAD detached from %s)"` @0x1403bc750.
- Errors (S4): `"a branch named '%s' already exists"` @0x140397120, `"'%s' is not a valid branch name"` @0x140396ba8/0x14034f3d8,
  `"not a valid object name: '%s'"` @0x140396be7, `"invalid reference: %s"`.
- Delete: `"Deleted branch %s (was %s).\n"` @0x14034b9ad, and `"Deleted remote-tracking branch %s (was %s).\n"` @0x14034b9d0.
  The "(was %s)" value is an abbreviated hash (inferred).

---------------------------------------------------------------------------------------------------
## 5. checkout / switch (0x140024090 / 0x1400243b0)  [observed strings, S4]
- `"Switched to branch '%s'\n"` @0x1403505c3, `"Switched to a new branch '%s'\n"` @0x140350520,
  `"Switched to and reset branch '%s'\n"` @0x1403505a0, `"Already on '%s'\n"` @0x14035058c.
- `"invalid reference: %s"` @0x14035097c.
- `"pathspec '%s' did not match any file(s) known to git"` @0x1403a2210, which is printed via error(), so it gets the "error: " prefix (inferred).
- Detached advice @0x1403929a8, verbatim start:
  `"Note: switching to '%s'.\n\nYou are in 'detached HEAD' state. You can look around, make experimental\nchanges and commit them, ..."`
  It ends with `"Turn off this advice by setting config variable advice.detachedHead to false\n\n"`.
- Overwrite errors (unpack-trees): `"Your local changes to the following files would be overwritten by checkout:\n%%sPlease commit your changes or stash them before you switch branches."` @0x1403cfd48
  (short variant @0x1403cfcf8). The untracked variants are @0x1403d0208 and @0x1403d0260.

---------------------------------------------------------------------------------------------------
## 6. merge (0x1400897e0), fast-forward path
evidence: cmd_merge pseudocode ev_ba6025cc593047ecdf03750d98068bde7c26f42406dd2e00a2cb6dcb1a8407a3, finish ev_2d417913...  [observed]
- When the remote head is a descendant and ff is allowed, it prints `"Updating %s..%s\n"` (@0x14037072e) with both oids abbreviated
  via FUN_1401d76d0(repo, oid, default_abbrev). default_abbrev DAT_14033a05c = -1 (auto), ev_6b99bec4..., so this is typically 7 hex digits (inferred).
- Message is `"Fast-forward"` (or `"Fast-forward (no commit created; -m option ignored)"`). FUN_1401c1440 then performs a checkout-fast-forward.
  finish() prints the msg plus newline (DAT_14036fbc0, presumably "%s\n", not read), updates HEAD with reflog "merge X: Fast-forward",
  and shows a diffstat when DAT_140335580 (show_diffstat) is set, using diff flags (stat|summary) for value 1 (inferred meaning of bits).
- `"Already up to date."` @0x14036fc38 (also "Already up to date. (nothing to squash)").
- `"%s - not something we can merge"` @0x140370688 (used in cmd_merge at pseudocode line ~332). Also `"not something we can merge"`.
- `"Your local changes to the following files would be overwritten by merge:\n  %s"`.

---------------------------------------------------------------------------------------------------
## 7. log (0x140079af0)
- Header strings: `"commit "` @0x1403ba292 (log-tree), and `"commit %s\n"` (merge squash msg). pretty.c region @0x1403b9000
  (ev_73a1f719...) contains `"Author"`, `"Commit"`, `"%s: "`, `"%.*s <%.*s>"`, `"Date:   %s\n"` (3 spaces), `"Date: %s\n"`, `"Merge:"` @0x1403b9382.
  So the medium format is `Author: Name <email>` followed by `Date:   <date>`. The 4-space message indent is **inferred** (not traced).
- Default date format: show_date FUN_140152300 (ev_204bacacb3c8758bf7fc9080af2dd9d2575556890777c6ed6cb7147f7d949bbb), default case [observed]:
  `"%.3s "` weekday + `"%.3s %d "` month mday + `"%02d:%02d"` + `":%02d"` + `" %d"` year (DAT_14039d323, ev_9af57d76...) + `" %+05d"` tz.
  This gives `Thu Oct 28 14:03:12 2026 +0530`. Other modes: iso `"%04d-%02d-%02d %02d:%02d:%02d %+05d"`, rfc `"%.3s, %d %.3s %d %02d:%02d:%02d %+05d"`,
  raw `"%I64u %+05d"`, unix `"%I64u"`. Env `GIT_TEST_DATE_NOW` is honored.
- Decoration: pieces in the log-tree string pool @0x1403accae (ev_4683eb6b...): `"refs/heads/"`, `" ("`, `")"`, `", "`, `" -> "`, `"tag: "`, `"refs/"`, `"HEAD"`.
  These form `(HEAD -> master, tag: v1)`. `log.decorate` is parsed by FUN_1400768c0 (ev_2ffabe32...) with values short/full/auto.
  "auto" means short only if isatty(1) (FUN_1402f2ce0(1)) or the pager is in use (FUN_1401f2f10). So when stdout is **not** a terminal and
  there is no pager, no decoration is printed by default. The default being auto when log.decorate is unset is **inferred**.
  Config cb FUN_140076950 also shows `log.date`, `log.showroot`, `log.mailmap`, `diff.context`, and so on.

---------------------------------------------------------------------------------------------------
## 8. diff (0x14003f850)
- Headers (diff.c string pool, S7/S9) [observed]:
  - `"%s%sdiff --git %s %s%s\n"` @0x1403a1494 (meta color, line prefix, a/<path>, b/<path>, reset)
  - `"%s%snew file mode %06o%s\n"` @0x1403a14ac, `"%s%sdeleted file mode %06o%s\n"` @0x1403a14c6,
    `"%s%sold mode %06o%s\n"`, `"%s%snew mode %06o%s\n"`
  - `"%s%sindex %s..%s"` @0x1403a1634 followed immediately by `" %06o"` (bytes ev_90594d50...), so the line is `index abc1234..def5678 100644`.
  - `"%s%s--- %s%s%s\n"` / `"%s%s+++ %s%s%s\n"` @0x14039ee83/0x14039ee73, and `"/dev/null"` for created/deleted files.
  - `"%sBinary files %s and %s differ\n"` @0x1403a1530, `"%s%ssimilarity index %d%%"`, `"rename from "`.
  - Hunk header seen as `"%s%s@@ -%ld,%ld +%ld,%ld @@%s\n"` @0x1403ac350. That string is in a combine-diff/aux region; the main path's
    `@@ -a,b +c,d @@` comes from xdiff's emitter and was **not** traced, so the exact format of the main hunk header is inferred.
  - `"\\ No newline at end of file\n"` @0x1403ac134 and `"\n\\ No newline at end of file\n"` @0x1403d8300.
- Default context lines: diff_context_default DAT_140339f8c = **3** (read_bytes ev_c29117ef..., written by `diff.context` cfg in FUN_140076950) [observed].
- Abbreviation: default_abbrev = -1 (auto) [observed]. Auto typically resolves to 7 hex digits in small repos (inferred).
- Algorithm: xdiff sources are linked in ("xdiff/xdiffi.c", "xdiff/xprepare.c", "xdiff-interface.c", S10). Algorithm names include
  "myers", "minimal", "patience" and "histogram" (`diff.algorithm` parsed by FUN_140163a60). The default is Myers (value 0, **inferred**).

---------------------------------------------------------------------------------------------------
## Open questions / not traced
- The loose-ref writer's exact "<hex>\n" output was not decompiled. The 4.5KB files-backend function FUN_140234060 holds "ref: %s\n".
- The main xdiff hunk-header emitter (`@@ -%ld,%ld +%ld,%ld @@`) has no defined string; this needs search_bytes or xdl_emit_hunk_hdr tracing.
- The exact cmd_commit exit code for "nothing to commit" (expected 1) is not confirmed.
- The checkout/branch reflog message call sites (which branch passes which %s) are not traced.
- DAT_14036fbc0 (finish msg format) was not read. The diffstat bitflag meaning for merge/commit is inferred.
