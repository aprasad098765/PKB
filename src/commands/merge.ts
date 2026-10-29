// git merge (fast-forward only)
// Evidence (rea-evidence/findings/04-refs-porcelain.md §6): cmd_merge 0x1400897e0
//  (RUN_SETUP | NEED_WORK_TREE): "Updating %s..%s", "Fast-forward", "Already up to date.",
//  reflog "merge %s: Fast-forward", ORIG_HEAD written with the pre-merge HEAD.
// Observed (fixtures merge-*): diffstat after "Fast-forward"; "merge: %s - not something we
//  can merge" (exit 1); no argument → "No remote for the current branch." (128);
//  --ff-only on diverged history → the advice.diverging hint + "Not possible to
//  fast-forward, aborting." (128); dirty/untracked refusals use "by merge" wording (exit 1).
// True (non-fast-forward) merges are outside v1 scope and refused explicitly.
import { writeFileSync } from "node:fs";
import type { Repo } from "../repo.ts";
import { Index } from "../dircache.ts";
import { parseOptions } from "../options.ts";
import { head, updateRef } from "../refs.ts";
import { resolveCommit } from "../revparse.ts";
import { parseCommit } from "../objects.ts";
import { flattenTree } from "../worktree.ts";
import { treePairs, detectRenames, patchFor, statLines, shortStat, summaryLines } from "../diff.ts";
import { switchTrees } from "./checkout.ts";
import { upstreamOf } from "../remote.ts";
import { isAncestor } from "./branch.ts";
import { die, err, out, hint } from "../output.ts";

export function cmdMerge(argv: string[], repo: Repo): number {
  const p = parseOptions("merge", argv, [
    { long: "ff-only", key: "ffOnly" },
    { long: "ff", key: "ff", negatable: true },
    { short: "q", long: "quiet", key: "quiet" },
    { short: "n", key: "noStat" },
    { long: "stat", key: "stat", negatable: true },
    { short: "m", long: "message", arg: "required", key: "m" },
  ]);
  if (!p.args.length) {
    // no argument: merge the current branch's upstream (merge.defaultToUpstream)
    const cur = head(repo).symref;
    const up = cur ? upstreamOf(repo, cur.replace(/^refs\/heads\//, "")) : null;
    if (!up) die("No remote for the current branch.");
    p.args.push(up.tracking); // reflog names the full ref: "merge refs/remotes/origin/master: Fast-forward"
  }
  if (p.args.length > 1) die("octopus merges are not supported by this implementation");
  const name = p.args[0];
  const theirs = resolveCommit(repo, name);
  if (!theirs) {
    err(`merge: ${name} - not something we can merge\n`);
    return 1;
  }
  if (p.opts.ff === false) die("--no-ff merges are not supported by this implementation.");
  return fastForward(repo, theirs, {
    reflog: `merge ${name}`,
    quiet: !!p.opts.quiet,
    stat: !p.opts.noStat && p.opts.stat !== false,
    diverged: () => {
      if (p.opts.ffOnly) divergingFFOnly(repo);
      die("Not possible to fast-forward; true merges are not supported by this implementation.");
    },
  });
}

// "--ff-only" refusal, shared with pull (fixtures merge-ff-only-diverged, net-pull-refused)
export function divergingFFOnly(repo: Repo): never {
  hint(["Diverging branches can't be fast-forwarded, you need to either:", "", "\tpkb merge --no-ff", "", "or:", "", "\tpkb rebase", ""], repo.config.bool("advice.diverging", true) ? "diverging" : undefined);
  die("Not possible to fast-forward, aborting.");
}

// Fast-forward HEAD (and the work tree) to `theirs`; prints git's merge output.
// origHeadLate: pull refuses divergent histories before touching ORIG_HEAD (fixture
// net-pull-refused), while merge records it as soon as the target resolves (merge-ff-only-diverged).
export function fastForward(repo: Repo, theirs: string, o: { reflog: string; quiet: boolean; stat: boolean; diverged: () => never; origHeadLate?: boolean }): number {
  const h = head(repo);
  // ORIG_HEAD is recorded as soon as the merge target resolves (fixtures merge-ff, merge-already-ancestor)
  const upToDate = !!h.oid && (h.oid === theirs || isAncestor(repo, theirs, h.oid));
  // pull: refuse divergent history first, then record ORIG_HEAD (also when already up to date;
  // fixtures net-pull-refused, net-ho-pull-ssh)
  if (o.origHeadLate && h.oid && !upToDate && !isAncestor(repo, h.oid, theirs)) o.diverged();
  if (h.oid) writeFileSync(repo.path("ORIG_HEAD"), h.oid + "\n");
  const ix = Index.read(repo.path("index"));
  const treeOf = (x: string | null) => (x ? parseCommit(repo.odb.read(x)!.body).tree : null);
  if (upToDate) {
    if (!o.quiet) out("Already up to date.\n");
    return 0;
  }
  if (h.oid && !isAncestor(repo, h.oid, theirs)) o.diverged();
  if (h.oid && !o.quiet) out(`Updating ${repo.odb.abbrev(h.oid)}..${repo.odb.abbrev(theirs)}\n`);
  ix.lock();
  if (!switchTrees(repo, ix, treeOf(h.oid), treeOf(theirs), "merge")) {
    ix.rollback();
    return 1;
  }
  if (!o.quiet) out("Fast-forward\n");
  updateRef(repo, "HEAD", theirs, `${o.reflog}: Fast-forward`);
  if (!o.quiet && o.stat) {
    const pairs = detectRenames(treePairs(flattenTree(repo, treeOf(h.oid)), flattenTree(repo, treeOf(theirs))));
    const stats = pairs.map((pp) => patchFor(repo, pp, 3).stat);
    if (stats.length) out(statLines(stats) + shortStat(stats) + summaryLines(pairs));
  }
  return 0;
}
