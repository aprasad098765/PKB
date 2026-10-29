// Phase 4: builds the inputs for REA's reconstruction checks.
//  1. a ledger manifest binding each obligation to its owning module (path, symbol, sha256)
//     and to the static original-case Evidence that established it;
//  2. a reconstruction-coverage document for boundary "git.v1".
// Parity, interop and fsck results come from harness/parity.mjs and tests/interop.mjs. They are
// NOT REA Evidence: REA's process capture is unavailable on native Windows, so these inputs
// carry no verifier results, and REA is expected to report those claims as unproven.
// Usage: node recon/build-verification-inputs.mjs <outDir>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const out = process.argv[2];
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const ledgerIn = JSON.parse(readFileSync(join(out, "ledger-input-base.json"), "utf8"));
const bundle = ledgerIn.evidence_bundle;
const obligations = ledgerIn.reviewed_obligations;

const OWNERS = {
  "cli.dispatch": ["src/cli.ts", "main"],
  "cli.worktree-required": ["src/cli.ts", "main"],
  "cli.exit-codes": ["src/output.ts", "die"],
  "cli.not-a-repo": ["src/repo.ts", "requireRepo"],
  "cli.unknown-command": ["src/cli.ts", "unknownCommand"],
  "repo.discovery": ["src/repo.ts", "discover"],
  "odb.loose-write": ["src/odb.ts", "ObjectDB.write"],
  "odb.loose-read": ["src/odb.ts", "ObjectDB.read"],
  "odb.hash": ["src/odb.ts", "hashObject"],
  "odb.tree-format": ["src/objects.ts", "serializeTree"],
  "odb.commit-format": ["src/objects.ts", "serializeCommit"],
  "cmd.hash-object": ["src/commands/hash-object.ts", "cmdHashObject"],
  "cmd.cat-file": ["src/commands/cat-file.ts", "cmdCatFile"],
  "index.format-v2": ["src/dircache.ts", "Index.serialize"],
  "index.lockfile": ["src/dircache.ts", "Index.lock"],
  "index.sort": ["src/dircache.ts", "cmpEntry"],
  "cmd.add": ["src/commands/add.ts", "cmdAdd"],
  "cmd.status": ["src/commands/status.ts", "cmdStatus"],
  "cmd.write-tree": ["src/commands/write-tree.ts", "cmdWriteTree"],
  "cmd.init": ["src/commands/init.ts", "cmdInit"],
  "refs.files": ["src/refs.ts", "updateRef"],
  "cmd.commit": ["src/commands/commit.ts", "cmdCommit"],
  "cmd.branch": ["src/commands/branch.ts", "cmdBranch"],
  "cmd.checkout-switch": ["src/commands/checkout.ts", "cmdCheckout"],
  "cmd.merge-ff": ["src/commands/merge.ts", "cmdMerge"],
  "cmd.log": ["src/commands/log.ts", "cmdLog"],
  "cmd.diff": ["src/commands/diff.ts", "cmdDiff"],
};

const active = obligations.filter((o) => o.disposition === "active");
// 1. ledger manifest
const manifest = {
  bindings: active.map((o) => {
    const [path, symbol] = OWNERS[o.obligation_id];
    return {
      obligation_id: o.obligation_id,
      owner: { module_path: path, symbol, owner_sha256: sha(path) },
      parser_type: null,
      // The static evidence shows where the behaviour lives (a positive case). Negative cases
      // exist only as observed fixtures, which are not REA Evidence, so none are claimed here.
      original_cases: [{ kind: "positive", evidence_id: o.review_evidence_ids[0], location: o.target.location }],
      fixtures: [],
      verifier: null,
    };
  }),
  contradictions: [],
};
writeFileSync(join(out, "ledger-manifest.json"), JSON.stringify(manifest, null, 2));

// 2. coverage document
const gitSha = obligations[0].target.artifact_sha256;
const envSha = createHash("sha256").update("windows-x86_64-git-2.52.0.windows.1-node-" + process.version).digest("hex");
const allReview = [...new Set(active.flatMap((o) => o.review_evidence_ids))];
const coverage = {
  evidence_bundle: bundle,
  artifacts: [{ artifact_id: "git.exe", artifact_sha256: gitSha, version: "2.52.0.windows.1", environment_sha256: envSha, evidence_ids: allReview.slice(0, 1) }],
  surfaces: active.map((o) => ({
    surface_id: o.obligation_id, family: o.family, artifact_id: "git.exe", occurrence_id: null, location: o.target.location,
    authority: "observed", dependency_surface_ids: [], evidence_ids: o.review_evidence_ids,
  })),
  owners: active.map((o) => {
    const [path, symbol] = OWNERS[o.obligation_id];
    return { surface_id: o.obligation_id, ownership: { disposition: "implemented", owner_path: path, owner_export: symbol, owner_sha256: sha(path), path_state: "present", package_state: "distributed", authority_route: "none" } };
  }),
  claims: active.map((o) => ({ claim_id: `claim.${o.obligation_id}`, title: o.title, kind: "behavioral", surface_ids: [o.obligation_id], required_dimensions: ["terminal", "exit", "filesystem"], required_authority: "controlled-replay" })),
  verifier_contracts: [],
  verifier_results: [],
  residual_unknown_ids: [],
  contradictions: [],
  package_proofs: [],
  boundaries: [{
    boundary_id: "git.v1", title: "git v1 command subset (init hash-object cat-file add write-tree commit status log diff branch checkout/switch merge-ff)",
    required_surface_ids: active.map((o) => o.obligation_id), required_claim_ids: active.map((o) => `claim.${o.obligation_id}`),
    required_package_proof_kinds: ["build"], allowed_dispositions: [], allowed_unknown_ids: [],
  }],
};
writeFileSync(join(out, "coverage-input.json"), JSON.stringify({ boundary_id: "git.v1", coverage }));
console.log(`${manifest.bindings.length} bindings, ${coverage.surfaces.length} surfaces -> ${out}`);
