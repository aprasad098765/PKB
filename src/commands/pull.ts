// pkb pull = fetch + fast-forward merge of what was fetched for merging.
// Observed (fixtures net-pull, net-pull-refused, net-ssh), real git 2.52 with no pull.* config:
//  - fetch output first ("From ..."), then the merge output ("Updating a..b", "Fast-forward",
//    diffstat) or "Already up to date."; reflogs "pull: Fast-forward" /
//    "pull origin side: Fast-forward", tracking refs "pull origin side: fast-forward";
//  - divergent branches without --ff-only/pull.ff: the "You have divergent branches and need
//    to specify how to reconcile them." hint block + "Need to specify how to reconcile divergent
//    branches." (128); with --ff-only: merge's diverging hint + "Not possible to fast-forward";
//  - no upstream: "There is no tracking information for the current branch." paragraph (exit 1);
//  - a fetch failure makes pull exit 1.
// Rebase pulls and true merges are not supported (pkb only fast-forwards).
import type { Repo } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { head, shortRef } from "../refs.ts";
import { remoteNames, upstreamOf } from "../remote.ts";
import { fetchFrom } from "./fetch.ts";
import { fastForward, divergingFFOnly } from "./merge.ts";
import { die, err, hint, GitExit } from "../output.ts";
import { NAME } from "../brand.ts";
import { readFileSync } from "node:fs";

function divergent(repo: Repo): never {
  hint([
    "You have divergent branches and need to specify how to reconcile them.",
    "You can do so by running one of the following commands sometime before",
    "your next pull:",
    "",
    `  ${NAME} config pull.rebase false  # merge`,
    `  ${NAME} config pull.rebase true   # rebase`,
    `  ${NAME} config pull.ff only       # fast-forward only`,
    "",
    `You can replace "${NAME} config" with "${NAME} config --global" to set a default`,
    "preference for all repositories. You can also pass --rebase, --no-rebase,",
    "or --ff-only on the command line to override the configured default per",
    "invocation.",
  ]);

  die("Need to specify how to reconcile divergent branches.");
}

export async function cmdPull(argv: string[], repo: Repo): Promise<number> {
  const p = parseOptions("pull", argv, [
    { short: "q", long: "quiet", key: "quiet" },
    { long: "ff-only", key: "ffOnly" },
    { long: "ff", key: "ff", negatable: true },
    { short: "r", long: "rebase", arg: "optional", key: "rebase" },
    { long: "no-rebase", key: "noRebase" },
    { short: "n", long: "no-stat", key: "noStat" },
  ]);
  const rebase = p.opts.noRebase ? false : p.opts.rebase !== undefined ? p.opts.rebase !== "false" : repo.config.bool("pull.rebase", false);
  if (rebase) die(`${NAME} pull: --rebase is not supported; ${NAME} can only fast-forward`);
  if (p.opts.ff === false || repo.config.get("pull.ff") === "false") die(`${NAME} pull: --no-ff is not supported; ${NAME} can only fast-forward`);
  const ffOnly = !!p.opts.ffOnly || repo.config.get("pull.ff") === "only";
  const h = head(repo);
  const branch = h.symref ? shortRef(h.symref) : null;
  let remote = p.args[0];
  const refspecs = p.args.slice(1);
  const up = branch ? upstreamOf(repo, branch) : null;
  if (remote === undefined) {
    if (!up) {
      err(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee ${NAME}-pull(1) for details.\n\n    ${NAME} pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    ${NAME} branch --set-upstream-to=origin/<branch> ${branch ?? "<branch>"}\n\n`);
      return 1;
    }
    remote = up.remote;
  }
  // the fetch runs first, so a bad remote reports the fetch error (fixture net-pull-refused)
  const named = remoteNames(repo).includes(remote);
  const url = named ? repo.config.get(`remote.${remote}.url`)! : remote;
  try {
    const r = await fetchFrom(repo, named ? remote : null, url, refspecs, { quiet: !!p.opts.quiet, prune: false, reflog: ["pull", ...argv].join(" ") });
    if (r.code) return 1;
  } catch (e) {
    if (e instanceof GitExit) return 1;
    throw e;
  }
  // merge what FETCH_HEAD marks for merging
  const target = readFileSync(repo.path("FETCH_HEAD"), "utf8").split("\n").find((l) => l && !l.split("\t")[1]);
  if (!target) {
    err(`You asked to pull from the remote '${remote}', but did not specify\na branch. Because this is not the default configured remote\nfor your current branch, you must specify a branch on the command line.\n`); // unverified wording
    return 1;
  }
  return fastForward(repo, target.slice(0, 40), {
    reflog: ["pull", ...argv].join(" "),
    quiet: !!p.opts.quiet,
    stat: !p.opts.noStat,
    origHeadLate: true,
    diverged: () => (ffOnly ? divergingFFOnly(repo) : divergent(repo)),
  });
}
