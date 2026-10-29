// git write-tree
// Evidence (rea-evidence/findings/02-objects.md §4): cmd_write_tree 0x1400fb5a0, RUN_SETUP;
//  writes tree objects for the index via the cache-tree and prints the root oid; the
//  index is rewritten with a fully valid TREE extension (fixtures write-tree-*, tree-ordering,
//  cache-tree-order). Options --missing-ok, --prefix=<dir>/ (usage fixture usage-texts).
import type { Repo } from "../repo.ts";
import { Index } from "../dircache.ts";
import { parseOptions } from "../options.ts";
import { writeTree } from "../worktree.ts";
import { treeLookup } from "../revparse.ts";
import { die, out } from "../output.ts";

export function cmdWriteTree(argv: string[], repo: Repo): number {
  const p = parseOptions("write-tree", argv, [
    { long: "missing-ok", key: "missingOk" },
    { long: "prefix", arg: "required", key: "prefix" },
  ]);
  const ix = Index.read(repo.path("index"));
  ix.lock();
  let oid = writeTree(repo, ix);
  ix.commit();
  if (p.opts.prefix) {
    const hit = treeLookup(repo, oid, p.opts.prefix);
    if (!hit) die(`pkb-write-tree: prefix ${p.opts.prefix} not found`);
    oid = hit.oid;
  }
  out(oid + "\n");
  return 0;
}
