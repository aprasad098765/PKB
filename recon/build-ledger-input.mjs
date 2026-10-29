// Builds the input for `rea build-reconstruction-obligation-ledger` from the
// Phase 1 evidence bundle and the four findings files. Each obligation is one
// behavior the reimplementation must reproduce; its review_evidence_ids are the
// REA Evidence IDs cited in the findings section that established it.
// Usage: node recon/build-ledger-input.mjs <repoRoot> <outJson> [manifestJson]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, out, manifestPath] = process.argv.slice(2);
const ev = join(root, "rea-evidence");
const bundle = JSON.parse(readFileSync(join(ev, "phase1-evidence-bundle.json"), "utf8"));
const allIds = bundle.records.map((r) => r.evidence_id);
const SHA = "fc0f1cae1304fcdcf4d0749f421c5ed21471efc856301f92f56d4b844be84363";

// Split a findings file into "## " sections, returning {heading -> full evidence ids}.
function sections(file) {
  const text = readFileSync(join(ev, "findings", file), "utf8");
  const map = new Map();
  let head = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) head = line.slice(3).trim();
    if (!head) continue;
    for (const m of line.match(/ev_[a-f0-9]{8,64}/g) ?? []) {
      const full = allIds.find((i) => i.startsWith(m));
      if (full) (map.get(head) ?? map.set(head, new Set()).get(head)).add(full);
    }
  }
  return map;
}
const S = {
  d: sections("01-dispatcher.md"),
  o: sections("02-objects.md"),
  i: sections("03-index-status.md"),
  r: sections("04-refs-porcelain.md"),
};
// Evidence-index sections list every id for a file; used when a section cites by alias (E1..).
const fileIds = (k) => [...new Set([...S[k].values()].flatMap((s) => [...s]))];
const ids = (k, prefix) => {
  const hit = [...S[k].entries()].filter(([h]) => h.startsWith(prefix)).flatMap(([, v]) => [...v]);
  return hit.length ? [...new Set(hit)] : fileIds(k);
};

// [id, title, layer, family, file, sectionPrefix, location, disposition]
const defs = [
  ["cli.dispatch", "Builtin command table lookup and option-bit setup (RUN_SETUP, gentle, NEED_WORK_TREE)", "cli", "dispatch", "d", "B.", "0x14032e000 / FUN_140001480"],
  ["cli.worktree-required", "Commands with bit 0x08 die 'this operation must be run in a work tree' (128)", "cli", "dispatch", "d", "C.", "FUN_140282190"],
  ["cli.exit-codes", "fatal: -> exit 128 on stderr; usage: -> exit 129; error:/warning: prefixes", "cli", "errors", "d", "D.", "FUN_1402c4300 / FUN_1402c45d0"],
  ["cli.not-a-repo", "'fatal: not a git repository (or any of the parent directories): .git' (128)", "cli", "errors", "d", "E.", "FUN_140284380"],
  ["cli.unknown-command", "Unknown command message and exit 1", "cli", "errors", "d", "F.", "FUN_14019f280"],
  ["repo.discovery", "Locate .git via GIT_DIR, upward walk, gitdir: files", "persistence", "repository", "d", "H.", "FUN_140284380 / FUN_140282bf0"],
  ["odb.loose-write", "Loose object: '<type> <size>\\0'+content, SHA-1 over it, zlib, objects/xx/38hex, tmp_obj_ then rename, 0444", "persistence", "objects", "o", "1.", "0x1401d0d40 / 0x1401d2220 / 0x1401d2f50"],
  ["odb.loose-read", "Inflate and parse loose objects; corrupt/garbage errors", "persistence", "objects", "o", "2.", "0x1401d4aa0"],
  ["odb.hash", "SHA-1 (collision-detecting) object ids, 40-hex", "persistence", "objects", "o", "3.", "0x1403d86c0"],
  ["odb.tree-format", "Tree entries '<octal mode> <name>\\0<raw hash>', git name ordering", "persistence", "objects", "o", "4.", "0x14018f260 (fsck) / cache-tree"],
  ["odb.commit-format", "Commit object: tree/parent/author/committer/[encoding], blank line, message", "persistence", "objects", "o", "5.", "0x140138f90"],
  ["cmd.hash-object", "hash-object [-t] [-w] [--stdin] prints oid", "cli", "plumbing", "o", "6.", "0x14006c780"],
  ["cmd.cat-file", "cat-file -t/-s/-e/-p and errors", "cli", "plumbing", "o", "6.", "0x14001a690"],
  ["index.format-v2", "Index v2: DIRC header, 62-byte entries + NUL-padded names, sorted, SHA-1 trailer", "persistence", "index", "i", "1.", "FUN_1402132a0 / FUN_1402135d0 / FUN_140213fb0"],
  ["index.lockfile", "index.lock creation and 'Unable to create ... File exists.' message", "persistence", "index", "i", "2.", "FUN_1401acf60"],
  ["index.sort", "Entries sorted by name bytes then stage", "persistence", "index", "i", "3.", "index compare"],
  ["cmd.add", "add pathspec handling, 'Nothing specified, nothing added.', unmatched pathspec fatal", "cli", "porcelain", "i", "5.", "0x1400039a0"],
  ["cmd.status", "status long format headings/hints/labels, short format codes", "cli", "porcelain", "i", "6.", "FUN_1402d3dc0 / FUN_1402d1300"],
  ["cmd.write-tree", "write-tree writes tree objects from the index and prints the root oid", "cli", "plumbing", "o", "4.", "0x1400fb5a0"],
  ["cmd.init", "init: dirs, HEAD symref, config keys, default branch + advice, messages", "cli", "porcelain", "r", "1.", "FUN_1402856d0 / FUN_140285510 / FUN_140226970"],
  ["refs.files", "Loose refs '<hex>\\n', symrefs 'ref: ', reflog lines", "persistence", "refs", "r", "2.", "FUN_140230490"],
  ["cmd.commit", "commit: object creation, '[branch (root-commit) abbrev] subject', reflog msg, nothing-to-commit", "cli", "porcelain", "r", "3.", "0x14002ff50"],
  ["cmd.branch", "branch list/create/delete and messages", "cli", "porcelain", "r", "4.", "0x140014c00"],
  ["cmd.checkout-switch", "checkout/switch branch, -b/-c, messages, worktree update", "cli", "porcelain", "r", "5.", "0x140024090 / 0x1400243b0"],
  ["cmd.merge-ff", "merge fast-forward only: Updating a..b / Fast-forward / Already up to date.", "cli", "porcelain", "r", "6.", "0x1400897e0"],
  ["cmd.log", "log default medium format and date format", "cli", "porcelain", "r", "7.", "0x140079af0"],
  ["cmd.diff", "diff unified patch output (headers, index line, hunks, context 3)", "cli", "porcelain", "r", "8.", "0x14003f850"],
  ["cmd.status-porcelain-v2", "status --porcelain=v2 output", "cli", "porcelain", "i", "6.", "porcelain v2 strings", "out-of-scope"],
  ["index.v3-v4-extensions", "Index v3/v4 (extended flags, prefix compression) and UNTR/FSMN/link extensions", "persistence", "index", "i", "1.", "FUN_140213fb0", "out-of-scope"],
];

const reviewed_obligations = defs.map(([id, title, layer, family, k, sec, loc, disp = "active"]) => ({
  obligation_id: id,
  obligation_version: 1,
  title,
  application_layer: layer,
  family,
  target: { artifact_sha256: SHA, application_node_id: null, semantic_node_id: null, location: loc },
  required: disp === "active",
  required_case_kinds: ["positive", "negative"],
  required_original_authority: "static",
  required_fixture_authority: "packaged-process",
  required_verifier_authority: "packaged-process",
  requires_parser_type: false,
  dependency_obligation_ids: [],
  residual_unknown_ids: [],
  unavailable_authority: [],
  required_next_evidence: disp === "active" ? ["golden fixture from real git (Phase 2)", "parity test result (Phase 4)"] : [],
  disposition: disp,
  review_evidence_ids: ids(k, sec),
}));

const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : { bindings: [], contradictions: [] };
writeFileSync(out, JSON.stringify({ evidence_bundle: bundle, reviewed_obligations, manifest }));
console.log(`${reviewed_obligations.length} obligations -> ${out}`);
