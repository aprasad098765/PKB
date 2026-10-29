# 03 - Index (.git/index), lock files, add, status

Target: Git for Windows 2.52.0 `git.exe` sha256 fc0f1cae1304fcdcf4d0749f421c5ed21471efc856301f92f56d4b844be84363
Method: static only (Ghidra via REA). Function names are FUN_<addr>; role names in parentheses are inferred labels.
Confidence: **observed** = read directly in pseudocode, bytes, or strings; **inferred** = deduced from structure or naming and not directly confirmed.
Multi-byte integers in the index are big-endian (every field read and written goes through a bswap or htons).

## 1. Index file format

### 1.1 Header validation (verify_hdr) - FUN_1402132a0
- **Behavior:** checks the signature `0x43524944` (the bytes "DIRC" read as a little-endian dword). On mismatch it reports `bad signature 0x%08x`.
  Version = bswap(hdr[1]) and must satisfy `version - 2 < 3`, so only **2, 3 and 4** are accepted. Otherwise it reports `bad index version %d`.
  When the checksum-verify flag DAT_140434a54 is set, it hashes the file minus the trailing hash and compares the result with the trailer. On mismatch it reports `bad index file sha1 signature`.
  If the trailer equals the null OID (FUN_14019cc40), the hash check is skipped.
  The trailer length is `hash_algo->rawsz` (field +0x10), so 20 bytes for SHA-1 and 32 for SHA-256.
- **Evidence:** ev_ea2d8d1f7a3bd305416ba967b3a1ad0f14ade4c00586f82a7de5894f2bfedfcd, ev_ece861eef603944a6092e4f1ed9ec13edb727e41bb38a6d0f9584588e083dd70
- **Confidence:** observed. (That DAT_140434a54 is `index.skipHash`/verify_index_checksum is inferred.)

### 1.2 Read routine (do_read_index) - FUN_1402135d0
- If the open fails with ENOENT (errno 2) and the caller did not require the file, the index is treated as empty. Any other open failure gives `%s: index file open failed`.
- `%s: cannot stat the open index`, `Cannot handle files this big`.
- Size check: `st_size < rawsz + 12` gives `%s: index file smaller than expected`, so the minimum is a 12-byte header plus the hash.
- The file is mmapped (`%s: unable to map index file%s`), then verify_hdr runs. A return of -1 gives `index file corrupt`.
- The trailing hash is copied into istate+0xa0 (`param_1+0x14`). The hash algo id is 0 (unknown), 1 (sha1) or 2 (sha256).
- Header layout: `[0..4) "DIRC"`, `[4..8) version BE`, `[8..12) entry count BE`. Entries start at offset 0xc.
- Cache array capacity is `alloc_nr(n) = (n*3+0x30)>>1`.
- Extensions load on a separate thread (`unable to create load_index_extensions thread: %s`). Entries load on threads when IEOT is present (`unable to create load_cache_entries thread: %s`). Thread count is cache_nr/10000, capped by the CPU count (FUN_14029d560) and `index.threads` (FUN_1401446a0).
- IEOT check: signature `0x49454f54` ("IEOT"), version must be 1 (`invalid IEOT version %d`), entries are 8 bytes each (`invalid number of IEOT entries %d`).
- trace2 records `read/version` and `read/cache_nr` (read-cache.c lines 0x90e/0x910).
- An entry with mode `0x4000` (a directory) sets istate+0x3c, the sparse-index flag.
- **Evidence:** ev_f63730ae3cf129ff4a3b0a9c01722a1a1b72983fa6e95aea5fe65611f97ab26d, ev_35f5cb38ec607e90d55b1753868f88f78bb09b4ab90f9b55275715625f6f4a3f
- **Confidence:** observed

### 1.3 On-disk entry layout (create_from_disk) - FUN_140212720

Writer: FUN_140211fb0 (copy_cache_entry_to_ondisk).

| Offset (rawsz=20) | Field | In-memory ce offset |
|---|---|---|
| 0x00 | ctime.sec | +0x10 |
| 0x04 | ctime.nsec | +0x14 |
| 0x08 | mtime.sec | +0x18 |
| 0x0c | mtime.nsec | +0x1c |
| 0x10 | dev | +0x20 |
| 0x14 | ino | +0x24 |
| 0x18 | mode | +0x34 |
| 0x1c | uid | +0x28 |
| 0x20 | gid | +0x2c |
| 0x24 | size | +0x30 |
| 0x28 | oid (rawsz bytes) | +0x48 |
| 0x28+rawsz | flags u16 | +0x38 (upper bits) |
| +2 | (only if extended) flags2 u16 | +0x38 >>16 |
| then | name | +0x6c (len at +0x40) |

- **flags u16:**
  - `& 0x0fff` is the name length. A value of `0xfff` means the length is computed with strlen, i.e. the name is at least 4095 bytes. On write the length is clamped `if (len > 0xfff) len = 0xfff`.
  - `0x8000` is assume-valid (inferred from the mask `& 0xf000` being written).
  - `0x4000` is extended (observed: it adds a second u16).
  - `0x3000` is the stage; `(flags >> 12) & 3` is used throughout (observed).
- **Extended flags2:** the writer emits `htons((ce_flags >> 16) & 0x6000)`, which is skip-worktree 0x4000 and intent-to-add 0x2000 (inferred meaning). On read, `(flags2<<16) & 0x9fff0000 != 0` dies with `unknown index entry format 0x%08x`.
- **Entry size for v2/v3:** `(0x28 + rawsz + (ext?4:2) + namelen + 8) & ~7`. The decompiler shows this as `(namelen + 0x34 + rawsz - (ext?0:2)) & ~7`. With SHA-1 and no extended flags this is `(namelen + 70) & ~7`.
  So the name is NUL-padded with **1-8 NULs** to an 8-byte boundary, measured from the start of the entry.
  - Writer: emits the name, then `(n + 8 & ~7) - n` bytes from the zero buffer DAT_140434a68.
- **v4:** the name is prefix-compressed. A varint (FUN_1402c7900 to decode, FUN_1402c7980 to encode) gives the number of bytes to strip from the previous name, followed by the NUL-terminated suffix. There is no padding: the writer emits exactly one NUL.
  Read error: `malformed name field in the index, near path '%s'`.
- **Evidence:** ev_e461212eec1be0c5a3eebb9b8d347e897dad0c3bccd05c4d3e10c5311bca7988, ev_fcf4ce2d09216e90e85923bbaea57a897c5e11a92950dccb279f335056a00d2a, ev_3c52e906ec0f5e07447bac7e5c59b2974ea62597203992859f2ce2ece9e0c214
- **Confidence:** layout and constants observed; flag-bit names inferred.

### 1.4 Write routine (do_write_index) - FUN_140213fb0

Callers include FUN_140216fd0, write_locked_index, used by add.
- **Version selection:** if istate->version == 0:
  - The env var `GIT_INDEX_VERSION` is used if it is 2..4 and fully numeric. Otherwise the warning `GIT_INDEX_VERSION set, but the value is invalid.\nUsing version %i` (3) is printed.
  - Failing that, the repo setting `index.version` (repo_settings +0x140) is used if it is >= 0 and valid. Otherwise the warning `index.version set, but the value is invalid.\nUsing version %i` is printed.
  - **Default is 2.** It is bumped to **3** only if some entry has extended flags (`ce_flags & 0x60000000`). The writer sets or clears the 0x4000 extended bit per entry accordingly. An explicit version of 4 is kept.
- **Header written:** `"DIRC"` (0x43524944 LE), version BE, entry count BE. The count excludes entries with CE_REMOVE (0x20000), which are skipped.
- **Racy-git smudging:** if `mtime.sec >= index_timestamp` (istate+0x30), the entry is not a gitlink (`mode&0xf000 != 0xe000`), and the stat data still matches but the content differs, then ce size (+0x30) is set to 0. (FUN_140212c90 / FUN_140211d00, inferred as ce_match_stat / ce_modified.)
- **Null OID guard:** an entry whose OID is all zero gives `cache entry has null sha1: %s` and the write fails. If `GIT_ALLOW_NULL_SHA1` is set, it is only a warning.
- **Extension write order (observed):**
  1. `IEOT` (0x49454f54): version 1, then (offset, count) pairs. Written only if `index.recordoffsettable` (default follows index.threads != 1) and computed threads >= 2. The thread count is cache_nr/10000 capped at ncpu-1, so in practice only indexes of about 20k entries or more get IEOT (inferred).
  2. `link` (0x6c696e6b): split index. Gives `cannot write split index for a sparse index`.
  3. `TREE` (0x54524545): if a cache_tree exists and drop_cache_tree is not set.
  4. `REUC` (0x52455543): if resolve_undo exists.
  5. `UNTR` (0x554e5452): if the untracked cache exists.
  6. `FSMN` (0x46534d4e): if fsmonitor data exists.
  7. `sdir` (0x73646972): zero-length marker, written when the index is sparse.
  8. `EOIE` (0x45494f45): last. Its payload is a 4-byte BE offset of the extension area plus a hash over the extension headers. Enabled by `index.recordendofindexentries`; when that is unset, it follows `index.threads` != 1.
- **Default extensions in a normal repo:** TREE (once a cache tree exists, e.g. after commit or write-tree), and EOIE when index.threads is the default (0 = auto). Both are inferred from the config logic.
- **Trailer:** finalize_hashfile (FUN_140150a50) writes the hash of all preceding bytes into istate+0xa0. Then: close (`could not close '%s'`), stat to record the index timestamp, trace `write index, changed mask = %x`, trace2 `write/version` and `write/cache_nr`.
- **Evidence:** ev_3c52e906ec0f5e07447bac7e5c59b2974ea62597203992859f2ce2ece9e0c214, ev_88bb2f3e5af39ac39947896f5cb2a57fdc3db3e80fc0846dfec6213e7d690a57, ev_440d6c351e65859a0a45174896cf86a22e56fd63a58fc1242fc37886d54b3db7
- **Confidence:** observed, except the "default extensions" conclusion (inferred).

### 1.5 Extension reader (read_index_extension) - FUN_140212ed0
- Walks `[sig4][len4 BE][data]` blocks until `size - rawsz - 8`.
- Known signatures:
  - TREE: FUN_1401277c0, stored at istate+0x20.
  - REUC: FUN_14025a890, stored at +0x18.
  - link: FUN_14028b430.
  - UNTR: FUN_14017ddb0, stored at +0xc8.
  - FSMN: FUN_140190e70.
  - EOIE and IEOT: skipped, already handled.
  - sdir: sets the sparse flag.
- Unknown signature whose first byte is 'A'..'Z' (`(byte)(c-0x41) <= 0x19`): optional, warns `ignoring %.4s extension`.
- Any other unknown signature is fatal: `index uses %.4s extension, which we do not understand`, then `index file corrupt`.
- **Evidence:** ev_7b71d8138d587e7009c2d1feb9255678b1adc78d04baf4133e29dfac92ab232d
- **Confidence:** observed

## 2. Lock files
- **Message builder:** FUN_1401acf60 (unable_to_lock_message). With errno 0x11 (EEXIST) the message is verbatim (`%s` = path without `.lock`, then strerror):
  ```
  Unable to create '%s.lock': %s.

  Another git process seems to be running in this repository, e.g.
  an editor opened by 'git commit'. Please make sure all processes
  are terminated then try again. If it still fails, a git process
  may have crashed in this repository earlier:
  remove the file manually to continue.
  ```
  Any other errno gives `Unable to create '%s.lock': %s`.
  So the default index lock is `<gitdir>/index.lock`, and the EEXIST case reads `Unable to create '.../index.lock': File exists.` (strerror text inferred from MSVCRT).
- **Suffix:** the `.lock` literal at 0x1403aca4a is referenced from 0x1401acd8c and 0x1401ad2be (lock_file / commit paths, inferred).
- **Related strings:** `unable to create lock file %s.lock; non-directory in the way` (0x1403bf770), `couldn't close '%s.lock'` (0x1403bf965).
- **Evidence:** ev_8985cfc41a1b0e2cac2c0242041f9b46834b36db1974a723a7177de657dbf2d0, ev_bb7609aa8daee817dd326cc9d4641186d97a409b3b7773c6ccc8f651be6d31d6, ev_144fda9f5dbe4e196876b3cf0997e2ccd99e64691a7f5aa05adafc15cae9ffae, ev_ff39f094766999e29a5955bc9d48d585ebad7c43921e9a682b34b33e1d76f96f
- **Confidence:** message text observed; `index.lock` naming inferred (it is `<index path>` + ".lock").

## 3. Entry sort order
- **Comparator:** FUN_1402b7660 (name_compare) does `memcmp(a, b, min(len1, len2))`. A tie is broken by length: the shorter name sorts first. This is raw unsigned byte order with no case folding.
- **Binary search:** FUN_140212600 (index_name_stage_pos) searches by name and then by stage `(ce_flags>>12)&3`, lower stage first. It returns the position, or `-pos-1` when not found.
  With a sparse index, it expands the sparse directory (FUN_14028abf0) and retries.
- **Insert:** FUN_140217e90 (add_index_entry_with_check) has a fast path when the new name is greater than the last entry (strcmp). It memmoves the array to insert, and sets istate->cache_changed |= 8.
- **Insert errors:**
  - `'%s' appears as both a file and as a directory` (D/F conflict, unless ADD_CACHE_OK_TO_REPLACE)
  - `invalid path '%s'`
  - Adding stage 0 removes the higher-stage entries with the same name.
- **Evidence:** ev_f4d65a7a6de01308167eab7aef9afbef77d1132a1876ab88b687909a06c7cc55, ev_43554eb610c51405f4dc76fd38194e6a6b6f75ee20efbc82ed5ff65ea0aaf12b, ev_7f2960d95a04db357c8f9ed1b20be50e3cd2e44474ef5a6164ff8aef2712c317, ev_b790cae7beac99ab10ff3178153eb6fbc1acfdf014ba02958e767849aa0869bf
- **Confidence:** observed

## 4. File modes and stat settings (Windows)
- **Core config parser:** FUN_140180af0 (git_default_core_config) sets:
  - `core.filemode`: DAT_14033a070 (trust_executable_bit)
  - `core.trustctime`: DAT_14033a06c
  - `core.checkstat`: DAT_14033a068. `default` gives 1, `minimal` gives 0, anything else gives `invalid value for '%s': '%s'`.
  - `core.symlinks`: DAT_14033a064
  - `core.ignorestat`: DAT_140423748
- Compiled-in defaults read at 0x14033a064..0x14033a070 are all `1`. So filemode=true, trustctime=true, checkstat=default and symlinks=true unless config overrides them.
- On Windows, the per-repo `core.filemode=false` / `core.symlinks=false` normally come from the config written by `git init` (probing), not from these defaults (inferred; the probe was not traced).
- **Modes:** only 100644/100755/120000/160000/040000 occur. The mode constants 0x4000 (dir), 0xe000 (gitlink) and 0x8000 (regular) are observed in add/read/write.
  When filemode=false the executable bit is taken from the existing index entry (inferred; ce_mode_from_stat not decompiled).
- **`git add --chmod`:** `--chmod param '%s' must be either -x or +x`. It is applied with FUN_140215fa0 (chmod_index_entry). Failure gives `cannot chmod %cx '%s'` (sets the return to -1).
- **Evidence:** ev_040370acdea8b19c35a7ac6ca0669eaaac63ffd22951cb69f30e05ecd72ba66d, ev_a42be52c3c9c7172d7f368f69c5e1d29a2693bc22091e6728da3053103be2b10, ev_108c933fcc4dc9d7da24f307baf68e0a324b7307814ba854a5ddf0090043415d, ev_5876273648f59652ae02de9a18630be419f0cbe6d898298bfe7e1f38f4be1af4
- **Confidence:** config keys and defaults observed; Windows-specific effective values inferred.

## 5. git add - FUN_1400039a0 (cmd_add)
- **No pathspec and no -A/-u:**
  - Prints `Nothing specified, nothing added.\n` to stderr, then the advice `Maybe you wanted to say 'git add .'?` (FUN_140104950, advise_if_enabled).
  - Returns **0**: uVar25 is initialized to 0 and that path jumps straight to the return.
  - `add.ignore-errors` handling is not involved here.
  - Evidence: ev_5876273648f59652ae02de9a18630be419f0cbe6d898298bfe7e1f38f4be1af4. Observed.
- **Unmatched pathspec:**
  - `pathspec '%s' did not match any files` goes through FUN_1402c49d0 (die), so the process exits (exit code 128 inferred for die).
  - It is skipped for paths matched only by ignored files, and with `--ignore-missing` plus `--dry-run`.
  - String 0x140347398. Observed.
- **Ignored paths:**
  - stderr `The following paths are ignored by one of your .gitignore files:\n`, then one path per line, then advice `Use -f if you really want to add them.`
  - Return value is ORed with 1, so **exit 1**. Observed (exit value inferred from return to main).
- **Other errors:**
  - `adding files failed` (die, unless --ignore-errors)
  - `unable to write new index file` (die)
  - `index file corrupt`
  - `could not read the index`
  - Option conflicts: `options '%s' and '%s' cannot be used together` (--dry-run vs --interactive/--patch, --pathspec-from-file vs --interactive/--patch or --edit), `the option '%s' requires '%s'` (--ignore-missing requires --dry-run; --pathspec-file-nul requires --pathspec-from-file; --unified/--inter-hunk-context require --interactive/--patch), `'%s' and pathspec arguments cannot be used together`, `'%s' cannot be negative`.
  - Embedded repository: `adding embedded git repository: %s` plus the long "You've added another git repository..." advice.
  - Refresh: `Unstaged changes after refreshing the index:`
- **Write:** FUN_140216fd0(istate, lock, 3), i.e. write_locked_index with COMMIT_LOCK|SKIP_IF_UNCHANGED (flag meaning inferred).
- **Evidence:** ev_5876273648f59652ae02de9a18630be419f0cbe6d898298bfe7e1f38f4be1af4, ev_f748ef6769b8457a3e88276e43655ad0c768f45c382e754e123d8a50f60db8bd
- **Confidence:** observed

## 6. git status

### 6.1 Long format - FUN_1402d3dc0 (wt_longstatus_print)
Strings are verbatim; section headers are printed by color helpers that add "\n".
- **Branch line:**
  - `On branch ` + branch name, with `refs/heads/` stripped.
  - `Not currently on any branch.`
  - `HEAD detached at ` / `HEAD detached from `
  - `interactive rebase in progress; onto ` / `rebase in progress; onto `
- **Initial commit:** `No commits yet` (status) or `Initial commit` (commit template), selected by a flag.
- **Upstream (remote.c):**
  - `Your branch is up to date with '%s'.\n`
  - `Your branch is ahead of '%s' by %d commit.\n` / `...commits.\n`
  - `Your branch is behind '%s' by %d commit, and can be fast-forwarded.\n` / `...commits...`
  - `Your branch and '%s' have diverged,\nand have %d and %d different commits each, respectively.\n`
  - `Your branch is based on '%s', but the upstream is gone.\n`
  - Hints: `  (use "git push" to publish your local commits)\n`, `  (use "git pull" to update your local branch)\n`, `  (use "git pull" if you want to integrate the remote branch with yours)\n`, `  (use "git branch --unset-upstream" to fixup)\n`
- **Section: `Changes to be committed:`**
  - `  (use "git restore --staged <file>..." to unstage)`
  - `  (use "git restore --source=%s --staged <file>..." to unstage)`
  - `  (use "git rm --cached <file>..." to unstage)`, used for the initial commit.
- **Section: `Unmerged paths:`**
  - `  (use "git add <file>..." to mark resolution)`
  - `  (use "git add/rm <file>..." as appropriate to mark resolution)`
  - `  (use "git rm <file>..." to mark resolution)`
- **Section: `Changes not staged for commit:`**
  - `  (use "git add <file>..." to update what will be committed)`
  - `  (use "git add/rm <file>..." to update what will be committed)`
  - `  (use "git restore <file>..." to discard changes in working directory)`
  - `  (commit or discard the untracked or modified content in submodules)`
- **Untracked and ignored sections:**
  - `Untracked files` / `Ignored files` (a colon is appended by the printer, inferred)
  - Hint `  (use "git %s <file>..." to include in what will be committed)`, where %s = `add` (or `add -f` for ignored files)
  - `Untracked files not listed%s` with ` (use -u option to show untracked files)`
- **Change labels** (FUN_1402d1000, keyed by diff status letter): `new file:` `copied:` `deleted:` `modified:` `renamed:` `typechange:` `unknown:` `unmerged:`.
  Unmerged labels: `both deleted:` `added by us:` `deleted by them:` `added by them:` `deleted by us:` `both added:` `both modified:`.
- **Padding** (FUN_1402d2150, observed): the width is computed once as `1 + max(utf8_strwidth(label))` over status letters 'A'..'Z' and cached in DAT_140435920 with a space buffer at DAT_140435928.
  Each line is `"\t"` (0x1403d667c) + `"%s%.*s%s"` with (label, width - strlen(label), spaces, path). Renames use `"%s%.*s%s -> %s"`.
  For English the longest label is `typechange:` (11), so the width is 12. Example: `\tnew file:   path` (3 spaces), `\tmodified:   path`, `\tdeleted:    path`.
  Submodule suffix: ` (` + `new commits, ` / `modified content, ` / `untracked content, ` with the trailing ", " replaced by `)`.
  Assert: `unhandled diff status %c`.
- **Summary lines** (exact selection logic observed at FUN_1402d3dc0):
  - `no changes added to commit (use "git add" and/or "git commit -a")\n` (or `no changes added to commit\n` when hints are off)
  - `nothing added to commit but untracked files present (use "git add" to track)\n` (or the no-hint variant)
  - `nothing to commit (create/copy files and use "git add" to track)\n` (initial commit, hints on)
  - `nothing to commit\n`
  - `nothing to commit (use -u to show untracked files)\n`
  - `nothing to commit, working tree clean\n`
- **Other:** `Your stash currently has %d entry` / `entries`, and `It took %.2f seconds to enumerate untracked files.`
- **Evidence:** ev_b42a7edfaae5cf6bf21f1cb5d5c2198b62ea0d7448c9ce22fd88cebc77b2bf8b, ev_bed668c87c531f093d09bbe93870ab26c03855831a7196e56d10f4cdfc7f5d0b, ev_dcdd6a9a05028a09f8aa4560ca845764459ffc527359f41f7b027a048af707df, ev_566d4336f6fb7aa938b2cac6de7509383e3741eacc8a12ba6d9afa2d6c0f0cd0, ev_c2046c0cb3627e4a60ab1e0018c17051b5ff92ca75c5a0314875c3052ef87e8b, ev_0aaaa7ca345780bfc44d6aac78b7cfec0072d163deef0057eb84362859b23d70
- **Confidence:** strings observed; the "colon added by printer" and English width 12 are inferred from the computation.

### 6.2 Short / porcelain v1 - FUN_1402d1300 (wt_shortstatus_print)
- **Branch header (with -b):**
  - `## ` + branch, or `No commits yet on ` + branch, or `HEAD (no branch)`
  - Then `...` + upstream.
  - Then ` [` + `ahead ` N / `behind ` N / `ahead N, behind M` (`, %s`) / `gone` / `different` + `]`.
- **Change line:**
  - X = index status letter, or ' ' if none.
  - Y = worktree status letter, or ' ' if none.
  - Then ' ', then `orig -> ` (renames), then the path, then a newline.
  - With -z: `%s\0`, and the rename source follows as its own NUL-terminated field.
- **Unmerged:** `DD` `AU` `UD` `UA` `DU` `AA` `UU` for stagemask cases 1..7 (mapping observed in the porcelain v2 switch in FUN_1402d3dc0; the strings are at 0x1403d641b..0x1403d642d).
- **Untracked / ignored:** `??` (0x1403d6418) and `!!` (0x1403d6455) via FUN_1402d08e0.
- Status letters come from the diff (A, M, D, R, C, T, U).
- **Evidence:** ev_491127ef3fa4353f98d491b0756e0067a05aac0ab507ee53a5c83371cf975dd8, ev_e866e24d2c3c0ed903861601ce403e8b5af5cb1c2e043bcc49df40c6b87e1736, ev_bde19f2bd185fa263d4ec6339e9a99021213da95e732b5924b6e0a3b34d16b85, ev_48248c599173fb75559081383ae43d9221d13a8e326be7aa847af4332b2497b5
- **Confidence:** observed

### 6.3 Porcelain v2 (observed strings)
- `# branch.oid %s%c` (or `(initial)`)
- `# branch.head %s%c` (or `(detached)` / `(unknown)`)
- `# branch.upstream %s%c`, `# branch.ab +%d -%d%c`, `# branch.ab +? -?%c`, `# branch.ab +0 -0%c`, `# stash %d%c`
- Changed entry: `1 %s %s %06o %06o %06o %s %s %s%c`
- Renamed/copied entry: `2 %s %s %06o %06o %06o %s %s %c%d %s%c%s%c`
- Unmerged entry: `%c %s %s %06o %06o %06o %06o %s %s %s %s%c` (prefix `u`)
- **Evidence:** ev_fcad20af7c5c94f7b827a2b18c29575802f376a69cc2b9e71cfe803b6c1488fd, ev_b42a7edfaae5cf6bf21f1cb5d5c2198b62ea0d7448c9ce22fd88cebc77b2bf8b
- **Confidence:** observed

## Open questions / not verified
- cmd_status (0x14002fbf0) was not decompiled. Its exit code (0 for status; commit --dry-run returns 1 when there is nothing to commit) is inferred.
- The exit code of die (FUN_1402c49d0), assumed 128, was not confirmed.
- The Windows `core.filemode` probe at init and ce_mode_from_stat were not traced.
- The exact place where long-format headers get a trailing ':' for Untracked/Ignored was not traced (the strings lack the colon).
- That DAT_140434a54 is the checksum-verify flag (index.skipHash interplay) is inferred.
