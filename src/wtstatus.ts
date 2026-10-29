// Work-tree status collection and the long / short printers (shared by status and commit).
// Evidence (rea-evidence/findings/03-index-status.md §6): wt_status_print FUN_1402d3dc0,
//  short format FUN_1402d1300; section headings "Changes to be committed:",
//  "Changes not staged for commit:", "Untracked files:"; labels padded to 12 columns
//  ("new file:   ", "modified:   ", "deleted:    ", "renamed:    "); short codes XY + "?? ";
//  branch line "## %s" / "## No commits yet on %s" / "## HEAD (no branch)".
// Observed (fixtures status-*, commit-nothing*, commit-unstaged-only, detached-head):
//  hint lines, "No commits yet" (status) vs "Initial commit" (commit), the closing line
//  variants, paths relative to cwd (porcelain: repo-relative), untracked listed last.
import type { Repo } from "./repo.ts";
import { Index } from "./dircache.ts";
import { head, shortRef, detachedFrom } from "./refs.ts";
import { parseCommit } from "./objects.ts";
import { flattenTree, entryClean, untrackedPaths } from "./worktree.ts";
import { Excludes } from "./ignore.ts";
import { treePairs, detectRenames, quotePath } from "./diff.ts";
import type { FilePair } from "./diff.ts";
import { relToPrefix } from "./util.ts";
import { trackingLong, trackingShort } from "./remote.ts";

export interface Status {
  branch: string | null; // short name, null when detached
  detachedAt: string | null; // "at 5fcf681" / "from v1.0"
  initial: boolean;
  staged: FilePair[];
  unstaged: { path: string; kind: "modified" | "deleted" }[];
  untracked: string[];
  index: Index;
  headOid: string | null;
}

export function collectStatus(repo: Repo, ix?: Index, opts: { untracked?: boolean } = {}): Status {
  ix ??= Index.read(repo.path("index"));
  const h = head(repo);
  const headTree = h.oid ? parseCommit(repo.odb.read(h.oid)!.body).tree : null;
  const headMap = flattenTree(repo, headTree);
  const idxMap = new Map(ix.entries.map((e) => [e.path, { oid: e.oid, mode: e.mode.toString(8).padStart(6, "0") }]));
  const staged = detectRenames(treePairs(headMap, idxMap));
  const unstaged: Status["unstaged"] = [];
  for (const e of ix.entries) {
    const st = entryClean(repo, ix, e);
    if (st !== "clean") unstaged.push({ path: e.path, kind: st });
  }
  const untracked = opts.untracked === false ? [] : untrackedPaths(repo, ix, new Excludes(repo));
  let detachedAt: string | null = null;
  if (!h.symref && h.oid) {
    const d = detachedFrom(repo, h.oid);
    detachedAt = `${d.word} ${d.name ?? repo.odb.abbrev(d.oid)}`;
  }
  return { branch: h.symref ? shortRef(h.symref) : null, detachedAt, initial: !h.oid, staged, unstaged, untracked, index: ix, headOid: h.oid };
}

const LABEL_W = 12;
const label = (s: string) => (s + ":").padEnd(LABEL_W);

function stagedLabel(p: FilePair): string {
  if (p.rename) return label("renamed");
  if (!p.a) return label("new file");
  if (!p.b) return label("deleted");
  if ((p.a.mode === "120000") !== (p.b.mode === "120000")) return label("typechange");
  return label("modified");
}

const disp = (repo: Repo, path: string) => quotePath(relToPrefix(path, repo.prefix));

export function printLong(repo: Repo, st: Status, forCommit: boolean): string {
  let s = "";
  if (st.branch) s += `On branch ${st.branch}\n`;
  else s += `HEAD detached ${st.detachedAt}\n`;
  if (st.initial) s += `\n${forCommit ? "Initial commit" : "No commits yet"}\n\n`;
  else if (st.branch) {
    const tr = trackingLong(repo, st.branch, st.headOid);
    if (tr) s += tr + "\n";
  }
  if (st.staged.length) {
    s += "Changes to be committed:\n";
    s += st.initial ? '  (use "pkb rm --cached <file>..." to unstage)\n' : '  (use "pkb restore --staged <file>..." to unstage)\n';
    for (const p of st.staged) {
      const name = p.rename ? `${disp(repo, p.a!.path)} -> ${disp(repo, p.b!.path)}` : disp(repo, (p.b ?? p.a)!.path);
      s += `\t${stagedLabel(p)}${name}\n`;
    }
    s += "\n";
  }
  if (st.unstaged.length) {
    s += "Changes not staged for commit:\n";
    s += st.unstaged.some((u) => u.kind === "deleted") ? '  (use "pkb add/rm <file>..." to update what will be committed)\n' : '  (use "pkb add <file>..." to update what will be committed)\n';
    s += '  (use "pkb restore <file>..." to discard changes in working directory)\n';
    for (const u of st.unstaged) s += `\t${label(u.kind)}${disp(repo, u.path)}\n`;
    s += "\n";
  }
  if (st.untracked.length) {
    s += "Untracked files:\n";
    s += '  (use "pkb add <file>..." to include in what will be committed)\n';
    for (const u of st.untracked) s += `\t${disp(repo, u)}\n`;
    s += "\n";
  }
  if (!st.staged.length) {
    if (st.unstaged.length) s += 'no changes added to commit (use "pkb add" and/or "pkb commit -a")\n';
    else if (st.untracked.length) s += 'nothing added to commit but untracked files present (use "pkb add" to track)\n';
    else if (st.initial) s += 'nothing to commit (create/copy files and use "pkb add" to track)\n';
    else s += "nothing to commit, working tree clean\n";
  }
  return s;
}

export function printShort(repo: Repo, st: Status, opts: { branch: boolean; porcelain: boolean }): string {
  let s = "";
  if (opts.branch) {
    if (!st.branch) s += "## HEAD (no branch)\n";
    else if (st.initial) s += `## No commits yet on ${st.branch}\n`;
    else {
      const tr = trackingShort(repo, st.branch, st.headOid);
      s += tr ? `## ${st.branch}...${tr.name}${tr.detail ? ` [${tr.detail}]` : ""}\n` : `## ${st.branch}\n`;
    }
  }
  const show = (p: string) => quotePath(opts.porcelain ? p : relToPrefix(p, repo.prefix), true);
  const rows = new Map<string, { x: string; y: string; from?: string }>();
  for (const p of st.staged) {
    const path = (p.b ?? p.a)!.path;
    const x = p.rename ? "R" : !p.a ? "A" : !p.b ? "D" : (p.a.mode === "120000") !== (p.b.mode === "120000") ? "T" : "M";
    rows.set(path, { x, y: " ", from: p.rename ? p.a!.path : undefined });
  }
  for (const u of st.unstaged) {
    const r = rows.get(u.path) ?? { x: " ", y: " " };
    r.y = u.kind === "deleted" ? "D" : "M";
    rows.set(u.path, r);
  }
  const keys = [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const k of keys) {
    const r = rows.get(k)!;
    s += `${r.x}${r.y} ${r.from ? `${show(r.from)} -> ` : ""}${show(k)}\n`;
  }
  for (const u of st.untracked) s += `?? ${show(u)}\n`;
  return s;
}
