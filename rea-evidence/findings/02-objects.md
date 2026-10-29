# 02 - Object database and object formats (git.exe 2.52.0, sha256 fc0f1cae...4363)

Static analysis only (Ghidra via REA, stripped binary). "observed" = seen directly in pseudocode/bytes;
"inferred" = reasoned from observed code plus naming/context. Function names in parentheses are
role labels I assigned, not symbols.

## 1. Loose object writing

- **Header format** `"%s %I64u"` (type name, decimal size), written with a 0x20-byte limit; the header
  length used for hashing is `snprintf_ret + 1`, so the trailing NUL is part of the hashed header.
  Hash = H(header + NUL + content): the code calls hash init, then update(header, hdrlen), then
  update(content, len), then final.
  - Fn: 0x1401d0d40 (format_object_header+hash). String @0x1403b2900.
  - Fails with `object-file.c` line 0x72: "could not get a type name for 'enum object_type' value %d".
  - Evidence: ev_012280717e24a1f8c6acfa4e6d65f9898afff096b85448250fe78831c736318c, ev_3da9755f51ed6fb70f67341dc40009a29beb2c5610f684af57b1e3f12278734c. Confidence: observed.
- **Type-name table** @0x1403b3a20 (index 0..4): [0]=NULL, 1="commit", 2="tree", 3="blob", 4="tag".
  Lookup fn 0x1401d99a0 returns NULL for idx>=5. Strings @0x1403b39f4..0x1403b3a05.
  - ev_fac8455af454f1b2fc3787645bedf8bdd8ee6edd6edfec77674f2f05b34a79ac, ev_a42b861da9e9b7f59f4a9ccd2dec1fc310afb83bfc74502f68464217becd50f1, ev_7aef30f9cf099f585578d9cc71181fd38967dafeb64c28834f884a059d282400. Observed.
- **Write path**: 0x1401d3120 (write_loose_object). It builds the path (0x1401d2530), creates the temp
  file + deflate stream (0x1401d2220), loops deflate (0x1401d0b50) until Z_STREAM_END (1), calls
  deflateEnd (0x1401d0ca0), and re-checks that the streamed hash equals the expected oid. Then it
  closes/fsyncs (0x1401d1ce0), optionally sets the mtime (utime), and finalizes (0x1401d2f50).
  Errors: "unable to deflate new object %s (%d)", "deflateEnd on object %s failed (%d)",
  "confused by unstable object source data for %s", "failed utime() on %s". If
  core.fsyncMethod=batch is set, it lazily creates a "bulk-fsync" tmp-objdir.
  - ev_51c46f9643b83919ae4297e8a41c7788fe9e10cb525d2ea53c877c4dc5b718a7. Observed.
  - A second caller of the temp creator, 0x1401d34e0, is the streaming writer (inferred). Related strings:
    "write stream object %ld != %I64u", "unable to stream deflate new object (%d)",
    "deflateEnd on stream object failed (%d)". ev_3311acc60436158829f264eff8d02d589e69c46b62d20630aca988621c043816.
- **Object path layout**: `<objdir>` + '/' + hex(byte0) + '/' + hex(bytes1..rawsz-1). The loop emits 2 hex
  chars per byte using "0123456789abcdef" and inserts '/' after the first byte only, i.e. `objects/xx/yyyy...`
  (38 hex chars for SHA-1). Fn 0x1401d2530. ev_1f32a89f03615f3cd380707431b18826aa1740028c04922942ac67f3e58aea37. Observed.
- **Temp file**: it takes the directory of the final path (strrchr '/') and appends `"tmp_obj_XXXXXX"`,
  then calls git_mkstemp_mode(path, **0x124 = 0444**), so the temp file is created read-only. On ENOENT
  it creates the `xx` dir with mode **0x1ff (0777)** (EEXIST tolerated), adjusts shared perms
  (0x1401fb280), and retries with `"/tmp_obj_XXXXXX"`. Errors: "unable to create temporary file";
  if errno==EACCES: "insufficient permission for adding an object to repository database %s".
  Fn 0x1401d2220. Strings @0x1403b2bc0/0x1403b2bcf.
  - ev_c4f2042ec7d8576e1c42ddc6e284c79f9c0b563294cc97f00da09c2d7bcf4802, ev_d7428b8bf964dd8dc647dfd4f7705f5900f3de8e574f3c7eba4d4c5424f927df, ev_eefad8832f5dc6fe20d7afbf8b6affeaf2ce5d4698cd632afc30c4dbccc12813. Observed.
- **zlib**: deflateInit_(strm, level, "1.3.1", 0x58) in 0x1401933e0 (git-zlib.c wrapper; die
  "deflateInit: %s (%s)"). Loose-object level comes from global DAT_14033a050, whose **static
  initializer is 1 (Z_BEST_SPEED)**. Config (core.loosecompression/core.compression) can change it at
  runtime (inferred). zlib is **dynamically imported** (zlib1.dll), not statically linked: import names
  `inflate`, `inflateEnd`, `inflateInit2_`, `inflateInit_`, `inflateReset` appear in .idata @0x14044d57a..
  The deflate output buffer is set up with avail_out=0x1000 (4096).
  - ev_0915b2e2adbb079eb2c73337901ec69f2a0c8662cb332f0cfd6e2d45c2576426, ev_33871ed567b4b83dcf1f6ca0b259fb7ef60532f09ddfccb17aa5cfc8e0b5ae79, ev_30b9e147fbde2df7903f92f270a2a97ab7e0a9aac928ef95d0be7db5138eb36e. Observed (level default); inferred (config override).
- **Finalize (rename/link)**: 0x1401d2f50 retries up to 7 times. If object_creation_mode
  (DAT_14033a02c) != 1, it tries link(tmp, final) first. Otherwise, or after a non-EEXIST link failure,
  it checks the target and calls rename(tmp, final). If the target already exists (errno 0x11 EEXIST)
  and the "skip collision check" flag is not set, it runs a collision check (0x1401d1de0; strings
  "files '%s' and '%s' differ in contents", "hash mismatch for %s (expected %s)"). Then it unlinks the
  temp file and calls adjust_shared_perm (0x1401fb280).
  Errors: "unable to write file %s", "unable to write repeatedly vanishing file %s",
  "unable to set permission to '%s'".
  **DAT_14033a02c statically = 1**, so this Windows build uses rename rather than hardlink by default.
  - ev_de8b88c532ee3a39f0c3b54eeaa73435209a683a996ab1f0101be85336ecfbeb, ev_eeb9f52f66178aed0aa5829887bf439d071cba602615e225b9ff10ed3f1bb6a0. Observed (the meaning of mode value 1 is inferred).
- Other object-file.c strings @0x1403b2860..: "unable to write loose object file", "object fails fsck: %s",
  "refusing to create malformed object", "object file %s is empty", "unexpected deflate failure: %d",
  "error when closing loose object file", "core.fsyncMethod = batch is unsupported on this platform",
  "unable to create directory %s", "cannot read object for %s", "cannot map object %s to %s".
  ev_693f65147c4dc2d4796ceae3227af8486484c8db0b7e777802557745c4145337. Observed (strings).

## 2. Loose object reading / parsing

- **Reader** 0x1401d4aa0 (loose_object_info). It opens the loose file (0x1401d2760), mmaps it
  (0x1401d1080), and inflates the header into a **32-byte (0x20) buffer** (0x1401d2c60). Return 1 =
  unpack fail, 2 = header too long. It then parses the header (0x1401d2d30) and, if the body is wanted,
  inflates it (0x1401d1760). With the "die on corrupt" flag (0x20) set, it dies "loose object %s (stored in %s) is corrupt".
  It also reports the hash format: algo ptr 0x1403a7da0 => 0, 0x1403a7e10 => 1 (sha1), 0x1403a7e80 ("sha256") => 2.
  Messages (verbatim): "unable to open loose object %s" (if errno != ENOENT), "unable to unpack %s header",
  "header for %s too long, exceeds %d bytes" (32), "unable to parse %s header", "invalid object type".
  - ev_66649505ae24fb680d72cdc0940e545e48ee35972508447a2ea90c5a21cd7abb. Observed.
- **Header parse** 0x1401d2d30: it scans to the first ' ' (fails on NUL), maps the type string via
  0x1401d99c0, then reads decimal digits. A **leading '0' is accepted only for size "0"**: after a 0
  digit the next char must be NUL, otherwise it returns -1. Overflow dies with "size_t overflow: %I64u * %I64u" /
  "size_t overflow: %I64u + %I64u". If size >= 2^32 it dies with "object too large to read on this
  platform: %I64u is cut off to %lu" (32-bit unsigned long on Windows). The header must end in NUL
  (returns -1 if trailing chars remain).
  ev_6c188e0ab870117f0b54b8fcf319d2e2d1e4a1d80bcf47ba23bc693fe2751010. Observed.
- **Body inflate** 0x1401d1760: it copies the already-inflated bytes after the header NUL, then calls
  inflate(Z_FINISH=4) under the obj_read mutex. Messages: "corrupt loose object '%s'" (status != Z_STREAM_END),
  "garbage at end of loose object '%s'" (avail_in != 0 after stream end).
  ev_cc9bd7d00647ae1ccfc223dfc8b024e1c7846e4fb9eec04579d0cbcd32d1bad2, ev_bf0704bf59678231008dff547f60e741b710d99756e939536d05c642793c2718. Observed.
- zlib wrapper strings: "inflateInit: %s (%s)", "inflateInit2: %s (%s)", "inflateEnd: %s (%s)",
  "inflate: out of memory", "inflate: %s (%s)" @0x1403a68b3..; "bad object header" @0x1403b6542 (pack).
  ev_30b9e147fbde2df7903f92f270a2a97ab7e0a9aac928ef95d0be7db5138eb36e. Observed (strings).
- Other: "loose object at %s could not be examined" @0x140373cb8, "invalid object type \"%s\"" @0x1403b3920.
  ev_94764e0307b3688afbde9406143e753917072a42d85fb7acc996a1f2559b0b2d. Observed.

## 3. Hash algorithm

- SHA-1 IV in .rdata @0x1403d86c0: `01234567 89abcdef fedcba98 76543210` (LE words 0x67452301, 0xefcdab89,
  0x98badcfe, 0x10325476; 0xc3d2e1f0 not adjacent in this table). It is the only byte match for that pattern.
  The only xref is 0x1402e4400 (sha1 init, 54 bytes). ev_c6b66597c118c83c5e8d55278ba3ebbd0fa74ced1bb2803679e7c4e77f74700c, ev_2804d6f10264a821fbea30704f1fd24241c1188af05777c8cc63c2ff01e97f95, ev_886f1a8436b5df484136adbce14885678079a2ed0e407f0aef9221b2677ee1bc. Observed.
- **sha1dc (collision detection) is used**. 0x1402e0320 (SHA-1 final wrapper) calls the DC final
  (0x1402e44b0), and if it returns nonzero it dies with **"SHA-1 appears to be part of a collision attack: %s"**.
  ev_3ca5099ee10b4f1263e4c4a5baca2574258a7281fd9f82328190bd2ff0c2c1b9, ev_28f9501594c5fbec9503d4332870cd5cb65090cc3ec69a1312823d14b691cc18. Observed.
- Build-options strings @0x1403a8280: "zlib: %s\n" with "1.3.1", **"SHA-1: %s\n" with "SHA1_DC"**,
  "SHA-256: %s" with "SHA256_BLK" (referenced from 0x14019ddc2, version --build-options).
  ev_2138bfb30a04476efff3860ddd7781ea4207b8360c0029cb2aeeefc6fa4cf5bf, ev_d0a1d3df18b9d5ab8ab2283ee2d8f6309cc5eb93e180e2bbd63311fce31bb598. Observed.
- Algo name strings @0x14035d9fe: "sha1", "sha256", "unknown", "SHA-1", "SHA-256". Hash-algo structs are
  0x70 bytes each, starting at 0x1403a7da0: [0]=unknown, [1]=sha1 @0x1403a7e10, [2]=sha256 @0x1403a7e80. The oid struct
  stride is 0x24 (32-byte hash + 4-byte algo). SHA-1 is the default (inferred from the [1] slot and
  sha1dc; the repo format comes from extensions.objectformat at runtime).
  ev_6d93df5584643ed407adfcb10f8c58ceb680815ee2b6b90dc19bc6cc70df593c, ev_66649505ae24fb680d72cdc0940e545e48ee35972508447a2ea90c5a21cd7abb. Observed tables; default inferred.

## 4. Tree object format

- **Entry emit** in cache-tree update 0x140126250 (cache-tree.c): `strbuf_addf("%o %.*s%c", mode, len, name, '\0')`
  followed by the raw hash bytes (rawsz = algo->rawsz, 20 for SHA-1). `%o` means no zero padding: directory
  entries use mode 0x4000, which prints as "40000". The tree is written via write_object(..., type 2=tree)
  (0x1401dc6d0), or only hashed in dry-run (0x1401d3470). Gitlinks (0xe000 = 0160000) skip the
  object-existence check. Error strings: "invalid object %06o %s for '%.*s'", "index cache-tree records empty sub-tree",
  "cache-tree.c: '%.*s' in '%s' not found". Entries are emitted in index order (the index is already sorted); subtrees are
  recursed at the first path containing '/'.
  ev_8d27ca69f02fc24d469b91cc842ebb225f776006eb3206fb448c465c14fb7bec, ev_7061d8ed2675d12a6e95aa85ae2afa45862c0643829fe49e98d2e9b9ff66a667. Observed.
  Other "%o %.*s%c" users: 0x1401ccad5/0x1401ccdc2 (object-file-convert); "%o %s%c" @0x14035caa5 (builtin mktree, likely).
  ev_c7ce70384de7b81b972c6b762fc2e73a7aad4d868007cc6efc569f912d11842d. Observed (strings), roles inferred.
- **Valid modes** (fsck_tree, 0x14018f260): 0x81a4=100644, 0x81ed=100755, 0x4000=040000 (dir), 0xa000=120000 (symlink),
  0xe000=160000 (gitlink, matched via `(mode & 0xbfff)==0xa000`), and 0x81b4=100664 (accepted unless strict).
  Anything else gives "contains bad file modes". A mode text starting with '0' gives "contains zero-padded file modes".
  ev_b4913b9557d273dc655c8977fc3481fe094962b2ed18d128439a205b8577f874. Observed.
- **Sort rule** (verify in fsck_tree 0x14018f260): memcmp over the common length. When one name is a prefix of
  the other, the next char of the shorter name is taken as '/' if that entry is a tree (mode 0x4000), else NUL. So
  directories sort as if their name had a trailing '/'. Equal names give "contains duplicate file entries";
  order violations give "not properly sorted". Other checks: "contains entries pointing to null sha1", "contains full pathnames",
  "contains empty pathname", "contains '.'", "contains '..'", "contains '.git'", "contains excessively large pathname",
  ".gitmodules is a symbolic link", ".gitattributes is a symlink", ".gitignore is a symlink", ".mailmap is a symlink".
  ev_b4913b9557d273dc655c8977fc3481fe094962b2ed18d128439a205b8577f874. Observed (the logic is in decompiled form; mapping to base_name_compare semantics is inferred).

## 5. Commit object format

- **Builder** 0x140138f90 (commit_tree buffer formatter; sole caller 0x14013be30). It pre-sizes the strbuf
  to 0x2000, then writes, in order:
  `"tree %s\n"` -> one `"parent %s\n"` per parent (oid stride 0x24) -> `"author %s\n"` (default from
  0x1401a1be0 = GIT_AUTHOR_NAME/EMAIL/DATE) -> `"committer %s\n"` (default 0x1401a1c70) ->
  `"encoding %s\n"` **only if i18n.commitEncoding (DAT_140423740) is not UTF-8** -> extra headers (each
  key/value; multi-line values via add-lines with a continuation prefix @0x140399e0e, likely "\n "/" ") -> a single '\n' (blank
  line) -> message bytes appended **verbatim** (no trailing newline added here).
  Strings @0x140399dd4..0x140399e01. ev_a00e5f597a795530c41b06d3425324db257027952a7c886acf23029958c3bef6, ev_9d264d9b9966dbe713033286d766d87178591e6f8b29be297c633df3b263bb61. Observed.
- **Ident** 0x1401a14c0 (fmt_ident): name (crud-stripped) + `" <"` (bytes @0x1403abc18 = 20 3c) + email + `'>'` + `' '`
  + date. Default date comes from 0x140153b20 (now). Explicit dates are parsed by 0x140153670 ("invalid date format: %s").
  Errors: "empty ident name (for <%s>) not allowed", "name consists only of disallowed characters: %s",
  "no email was given and auto-detection is disabled", "unable to auto-detect email address (got '%s')",
  "no name was given and auto-detection is disabled", "unable to auto-detect name (got '%s')".
  The raw date format string `"%I64u %+05d"` @0x14039d277 (used in date code 0x140152300) gives "<epoch> <+zzzz>".
  ev_c7979d186b0fe245bd2a21ea108f6830edc9769e240cb3765bf2990b74703e72, ev_6bf2598f62a015013852e466f61b2d0dfb052b094a2be6a2ec5bdcc92db78ab2, ev_42e4b4bb375ffee4c6e04b4ac605dfb9c69011c8f69247b1e465db0854798b35, ev_69e8affdc2b5a9908ebf2d6c8474503981ba6d9f49d1f7de4432c33a7e672e06. Observed; that the ident date uses exactly that format string is inferred.
- **Message normalization** is not done in the builder. builtin commit has cleanup modes "strip", "whitespace",
  "verbatim", "scissors", with "Invalid cleanup mode %s", "Aborting commit due to empty commit message.\n", and
  "Aborting commit due to empty commit message body.\n". The stripspace-style trailing-newline normalization
  happens there (inferred; that function was not decompiled). ev_8d5110978243217d8816478db52b58144a673e318e018cfbe9f0759a9177cdc5.
- fsck commit checks (0x14018f260): "invalid 'tree' line format - bad sha1", "invalid 'parent' line format - bad sha1",
  "invalid format - expected 'author' line", "invalid format - multiple 'author' lines",
  "invalid format - expected 'committer' line", "NUL byte in the commit object body". Observed.

## 6. hash-object (0x14006c780) and cat-file (0x14001a690)

### hash-object
- Options (parse-options table, observed): `-t <type>` ("object type", default **"blob"** @0x140396940),
  `-w` ("write the object into the object database"; sets flag bit0), `--stdin` ("read the object from stdin";
  counted), `--stdin-paths` ("read file names from stdin"), `--no-filters` ("store file as is without filters"),
  `--literally` ("just hash any random garbage to create corrupt objects for debugging Git"),
  `--path <file>` ("process file as it were from this path"). Default flags = 2 (format check, inferred).
- Usage errors (printed via error("%s") then usage_with_options, which exits 129, inferred):
  "Multiple --stdin arguments are not supported", "Can't use --path with --no-filters",
  "Can't use --stdin-paths with --stdin", "Can't specify files with --stdin-paths", "Can't use --stdin-paths with --path".
  --stdin-paths lines starting with '"' are C-unquoted; on failure it dies "line is badly quoted".
- Per-file 0x14006c680: fstat, then index_fd (0x1401d3f40). On success it prints `"%s\n"` (hex oid) to stdout and
  calls maybe_flush_or_die("hash to stdout"). On failure it dies "Unable to hash %s", or with -w
  "Unable to add %s to database". Returns 0.
  ev_39c09b4a5c41f693bd6e23bee2d470d16119d445b53c27a5fe06ff81d138685a, ev_c6afce79929d8f695542a13a3a0ac9354dee0403508eb1b6cf8c2a982e24a42f, ev_7ad9f8828ba71a3ee8a353ffe0c8708dafdbec076592bfc17a6478518b39d872, ev_53dbe27bc2a8fc34714bf6c2d909fc1c4717a5fb12c6651e00fee53946f7e30e. Observed.

### cat-file
- Usage lines: "git cat-file <type> <object>", "git cat-file (-e | -p | -t | -s) <object>",
  "git cat-file (--textconv | --filters)\n             [<rev>:<path|tree-ish> | --path=<path|tree-ish> <rev>]",
  "git cat-file (--batch | --batch-check | --batch-command) [--batch-all-objects]\n             [--buffer] [--follow-symlinks] [--unordered]\n             [--textconv | --filters] [-Z]".
  Options: -e "check if <object> exists", -p "pretty-print <object> content", -t "show object type (one of 'blob', 'tree', 'commit', 'tag', ...)",
  -s "show object size", --allow-unknown-type "historical option -- no-op", --use-mailmap/--mailmap, --batch, --batch-check,
  --batch-command, -z/-Z, --batch-all-objects, --buffer, --follow-symlinks, --unordered, --textconv, --filters, --path, --filter.
- Dispatch is a switch on (opt - 'c'): 
  - **-e** (case 2): it calls has_object (0x1401dd470, flags 3), and the **return value is 0 if the object exists, 1 if not** (no output).
  - **-t** (0x11): object_info, then printf "%s\n" with the type name (0x1401d99a0).
  - **-s** (0x10): printf "%I64u\n" with the size (with --use-mailmap on commit/tag, the size is computed after mailmap rewrite).
  - **-p** (0xd): it reads the type. tree (2) runs internal "ls-tree <obj>". blob (3) is streamed to stdout (0x140291160).
    Others are read (0x1401dd3f0) and written raw to fd 1.
  - `<type> <object>` mode: for blob it peels tag `"object "` lines. It reads with the expected type (0x1401dd620).
  - Default case: "git cat-file: unknown option: %s".
- Errors (die => exit 128; die() 0x1402c49d0 returns 0x80 on its recursion path): "Not a valid object name %s"
  (get_oid_with_context 0x1401d9930 fails, flags 0x3880), "Cannot read object %s", "git cat-file %s: bad file",
  "git cat-file: could not get object info", "unable to read %s", "%s not a valid tag",
  "<object> required with '-%c'", "too many arguments", "only two arguments allowed in <type> <object> mode, not %d",
  "'-%c' is incompatible with batch mode", "batch modes take no arguments", "'%s' requires a batch mode",
  "<rev> required with '%s'", "objects filter only supported in batch mode", "objects filter not supported: '%s'",
  "empty command in input", "whitespace before command: '%s'", "unknown command: '%s'", "%s takes no arguments",
  "%s requires arguments". The default batch format is "%(objectname) %(objecttype) %(objectsize)".
  The "fatal: " prefix comes from the die routine (inferred; the default die prefix was not decompiled).
  ev_a2271ebc7eb7a42830610a5bd7b39b590afd2bb8daff1fc431b15cda3b493fa7 (full pseudocode, 1038 lines), ev_449c730c7a8246ea40ee7e8e06e68fbc775b0ac6a5c29590ed8dc4f3278a18dd, ev_b15e8ffd410b47e1be4a85a6061e3f00dc2c0ddde33ee4430c8490b174d74940. Observed (exit 128 inferred from die routine).

## Open questions / not verified
- The runtime value of the loose compression level after config (static default 1). The core.compression
  config handler was not traced.
- The exact continuation prefix bytes @0x140399e0e for multi-line extra headers (gpgsig) were not read.
- builtin commit's stripspace/cleanup function and the exact trailing-newline behavior were not decompiled.
- write-tree builtin 0x1401fb5a0 was not decompiled. The tree format evidence comes from cache-tree 0x140126250, which write-tree presumably uses.
- The SHA-1 E constant (0xc3d2e1f0) location and the full sha1dc compression routine were not inspected.
- The die prefix "fatal: " and the usage_with_options exit code 129 are inferred, not observed.
