// git add
// Evidence (rea-evidence/findings/03-index-status.md §5): cmd_add 0x1400039a0 (RUN_SETUP |
//  NEED_WORK_TREE); no pathspec → "Nothing specified, nothing added." + advice
//  addEmptyPathspec, exit 0; unmatched pathspec → "pathspec '%s' did not match any files"
//  (fatal, nothing added); ignored paths → "The following paths are ignored by one of your
//  .gitignore files:" list + advice addIgnoredFile, exit 1; -A/--all and "." also stage
//  removals; -u updates tracked files only; -f forces ignored files.
// Index written through index.lock (§2) with cache-tree invalidation of touched paths.
// Fixtures: add-*, status-staged-delete.
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "../repo.ts";
import { Index } from "../dircache.ts";
import { parseOptions } from "../options.ts";
import { Excludes } from "../ignore.ts";
import { listFiles, makeEntry, entryClean } from "../worktree.ts";
import { makePathspecs, matchPathspec } from "../util.ts";
import { die, err, out, hint } from "../output.ts";

export function cmdAdd(argv: string[], repo: Repo): number {
  const p = parseOptions("add", argv, [
    { short: "n", long: "dry-run", key: "dryRun" },
    { short: "v", long: "verbose", key: "verbose" },
    { short: "f", long: "force", key: "force" },
    { short: "u", long: "update", key: "update" },
    { short: "A", long: "all", key: "all" },
    { long: "no-all", key: "noAll" },
    { long: "ignore-removal", key: "noAll" },
    { long: "ignore-errors", key: "ignoreErrors" },
  ]);
  const root = repo.wt();
  if (!p.args.length && !p.opts.update && !p.opts.all) {
    err("Nothing specified, nothing added.\n");
    hint(["Maybe you wanted to say 'pkb add .'?"], repo.config.bool("advice.addemptypathspec", true) ? "addEmptyPathspec" : undefined);
    if (!repo.config.bool("advice.addemptypathspec", true)) return 0;
    return 0;
  }
  const specs = makePathspecs(repo.prefix, p.args.length ? p.args : [repo.prefix ? "." : "."]);
  const whole = !p.args.length; // -A / -u without pathspec: whole tree
  const ix = Index.read(repo.path("index"));
  ix.lock();
  const ex = new Excludes(repo);
  const { files } = listFiles(root);
  const trackedSet = new Set(ix.entries.map((e) => e.path));
  const matched = new Set<number>();
  const ignoredHits: string[] = [];
  const toAdd: string[] = [];
  const inSpec = (path: string) => {
    if (whole) return true;
    let hit = false;
    specs.forEach((s, i) => {
      if (matchPathspec(s, path)) {
        matched.add(i);
        hit = true;
      }
    });
    return hit;
  };
  if (!p.opts.update) {
    for (const f of files) {
      if (trackedSet.has(f)) continue;
      if (!inSpec(f)) continue;
      if (!p.opts.force && ex.isIgnored(f, false)) {
        // explicitly named ignored files are reported; directory recursion just skips them
        if (specs.some((s) => s.path === f)) ignoredHits.push(f);
        continue;
      }
      toAdd.push(f);
    }
  }
  // tracked files: modifications and (unless --no-all) removals
  const removals: string[] = [];
  for (const e of ix.entries) {
    if (!inSpec(e.path)) continue;
    const st = entryClean(repo, ix, e);
    if (st === "modified") toAdd.push(e.path);
    else if (st === "deleted" && !p.opts.noAll) removals.push(e.path);
  }
  // pathspecs that matched nothing at all
  if (!whole) {
    specs.forEach((s, i) => {
      if (matched.has(i)) return;
      if (ignoredHits.includes(s.path)) return;
      const full = join(root, s.path);
      if (s.path === "" || (existsSync(full) && lstatSync(full).isDirectory())) return;
      ix.rollback();
      die(`pathspec '${s.raw}' did not match any files`);
    });
  }
  if (!p.opts.dryRun) {
    for (const f of toAdd) ix.set(makeEntry(repo, f, true, ix.find(f)));
    for (const f of removals) ix.remove(f);
  }
  if (p.opts.verbose || p.opts.dryRun) {
    for (const f of toAdd) out(`add '${f}'\n`);
    for (const f of removals) out(`remove '${f}'\n`);
  }
  if (p.opts.dryRun) ix.rollback();
  else ix.commit();
  if (ignoredHits.length) {
    err("The following paths are ignored by one of your .pkbignore files:\n");
    for (const f of ignoredHits) err(f + "\n");
    hint(["Use -f if you really want to add them."], repo.config.bool("advice.addignoredfile", true) ? "addIgnoredFile" : undefined);
    return 1;
  }
  return 0;
}
