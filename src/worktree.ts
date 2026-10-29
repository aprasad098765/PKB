// Work-tree scanning, blob hashing of files, tree building from the index.
// Evidence:
//  rea-evidence/findings/02-objects.md §4 — tree objects built from the index through the
//    cache-tree (write-tree 0x1400fb5a0 → cache_tree_update), directories mode 40000.
//  rea-evidence/findings/03-index-status.md §6 — untracked directories shown collapsed as
//    "dir/" when nothing inside is tracked (fixtures status-untracked-new, status-subdir-relative).
//  Observed: after checkout/merge the cache-tree is repaired only for trees whose objects
//    already exist (fixture checkout-dirty-carry keeps a valid TREE without new objects).
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync, chmodSync, unlinkSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Repo } from "./repo.ts";
import { Index, entryFromStat, cmpSubtree, stageOf } from "./dircache.ts";
import type { IndexEntry, CacheTreeNode } from "./dircache.ts";
import { hashObject } from "./odb.ts";
import { parseTree, serializeTree, isTreeMode } from "./objects.ts";
import type { TreeEntry } from "./objects.ts";
import type { Excludes } from "./ignore.ts";
import { REPO_DIR } from "./brand.ts";

export interface FlatEntry {
  oid: string;
  mode: string; // "100644" | "100755" | "120000" | "160000"
}

export function flattenTree(repo: Repo, treeOid: string | null, prefix = "", out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  if (!treeOid) return out;
  const t = repo.odb.read(treeOid);
  if (!t) throw new Error(`missing tree ${treeOid}`);
  for (const e of parseTree(t.body)) {
    const p = prefix + e.name;
    if (isTreeMode(e.mode)) flattenTree(repo, e.oid, p + "/", out);
    else out.set(p, { oid: e.oid, mode: e.mode.padStart(6, "0") });
  }
  return out;
}

export function readWorkFile(repo: Repo, path: string): Buffer {
  const full = join(repo.wt(), path);
  const st = lstatSync(full);
  if (st.isSymbolicLink() && repo.config.bool("core.symlinks", process.platform !== "win32")) {
    return Buffer.from(readlinkSync(full), "utf8");
  }
  return readFileSync(full);
}

export function blobOidOfFile(repo: Repo, path: string): string {
  return hashObject("blob", readWorkFile(repo, path)).oid;
}

export function modeForFile(repo: Repo, path: string, existing?: number): number {
  const st = lstatSync(join(repo.wt(), path));
  if (st.isSymbolicLink() && repo.config.bool("core.symlinks", process.platform !== "win32")) return 0o120000;
  if (!repo.config.bool("core.filemode", process.platform !== "win32")) return existing && existing !== 0o120000 ? existing : 0o100644;
  return st.mode & 0o111 ? 0o100755 : 0o100644;
}

// Hash a work-tree file into the odb (when write) and build its index entry.
export function makeEntry(repo: Repo, path: string, write: boolean, existing?: IndexEntry): IndexEntry {
  const data = readWorkFile(repo, path);
  const oid = write ? repo.odb.write("blob", data) : hashObject("blob", data).oid;
  const st = lstatSync(join(repo.wt(), path), { bigint: true });
  return entryFromStat(path, oid, st, modeForFile(repo, path, existing?.mode));
}

// Is the work-tree file identical to the index entry? Uses stat first, content when racy/changed.
export function entryClean(repo: Repo, ix: Index, e: IndexEntry): "clean" | "modified" | "deleted" {
  const full = join(repo.wt(), e.path);
  let st;
  try {
    st = lstatSync(full, { bigint: true });
  } catch {
    return "deleted";
  }
  if (st.isDirectory()) return "deleted";
  const mode = modeForFile(repo, e.path, e.mode);
  if (mode !== e.mode) return "modified";
  const size = Number(st.size & 0xffffffffn);
  if (size !== e.size) return "modified";
  const mtS = Number(st.mtimeNs / 1000000000n), mtN = Number(st.mtimeNs % 1000000000n);
  const racy = ix.mtimeMs === 0 || Number(st.mtimeMs) >= ix.mtimeMs - 1;
  if (!racy && mtS === e.mtimeS && mtN === e.mtimeNs && size === e.size) return "clean";
  return blobOidOfFile(repo, e.path) === e.oid ? "clean" : "modified";
}

// Recursively list work-tree files (posix relative paths), skipping .git and nested repos.
export function listFiles(root: string, dir = "", out: string[] = [], nested: string[] = []): { files: string[]; nested: string[] } {
  let ents;
  try {
    ents = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return { files: out, nested };
  }
  for (const e of ents) {
    if (isRepoDirName(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (isNestedRepo(join(root, rel))) nested.push(rel);
      else listFiles(root, rel, out, nested);
    } else if (e.isFile() || e.isSymbolicLink()) out.push(rel);
  }
  return { files: out, nested };
}

// Untracked paths, collapsing directories with no tracked content to "dir/".
export function untrackedPaths(repo: Repo, ix: Index, ex: Excludes): string[] {
  const root = repo.wt();
  const tracked = new Set(ix.entries.map((e) => e.path));
  const trackedDirs = new Set<string>();
  for (const p of tracked) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join("/"));
  }
  const out: string[] = [];
  const hasVisible = (dir: string): boolean => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (isRepoDirName(e.name)) continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (ex.isIgnored(rel, true)) continue;
        if (isNestedRepo(join(root, rel)) || hasVisible(rel)) return true;
      } else if (!ex.isIgnored(rel, false)) return true;
    }
    return false;
  };
  const visit = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (isRepoDirName(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (trackedDirs.has(rel)) {
          visit(rel);
          continue;
        }
        if (tracked.has(rel)) continue;
        if (ex.isIgnored(rel, true)) continue;
        if (isNestedRepo(join(root, rel)) || hasVisible(rel)) out.push(rel + "/");
      } else if (!tracked.has(rel) && !ex.isIgnored(rel, false)) out.push(rel);
    }
  };
  visit("");
  return out.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

// Build (and optionally write) tree objects from the index, maintaining the cache-tree.
// repair=true: never write objects; a node is valid only if its tree object already exists.
export function writeTree(repo: Repo, ix: Index, opts: { repair?: boolean; write?: boolean } = {}): string {
  const write = opts.write ?? !opts.repair;
  const entries = ix.entries.filter((e) => stageOf(e) === 0);
  const old = ix.tree;
  const build = (prefix: string, list: IndexEntry[], prev: CacheTreeNode | null, name: string): { node: CacheTreeNode; oid: string; exists: boolean } => {
    const items: TreeEntry[] = [];
    const children: CacheTreeNode[] = [];
    let allExist = true;
    let i = 0;
    while (i < list.length) {
      const rest = list[i].path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        items.push({ mode: list[i].mode.toString(8), name: rest, oid: list[i].oid });
        i++;
        continue;
      }
      const dname = rest.slice(0, slash);
      const sub: IndexEntry[] = [];
      while (i < list.length && list[i].path.startsWith(prefix + dname + "/")) sub.push(list[i++]);
      const prevChild = prev?.children.find((c) => c.name === dname) ?? null;
      const r = build(prefix + dname + "/", sub, prevChild, dname);
      children.push(r.node);
      allExist &&= r.exists;
      items.push({ mode: "40000", name: dname, oid: r.oid });
    }
    let oid: string;
    let exists: boolean;
    if (prev && prev.entryCount === list.length && prev.oid && prev.entryCount >= 0) {
      oid = prev.oid;
      exists = true;
    } else {
      const body = serializeTree(items);
      if (write) {
        oid = repo.odb.write("tree", body);
        exists = true;
      } else {
        oid = hashObject("tree", body).oid;
        exists = allExist && repo.odb.has(oid);
      }
    }
    children.sort((a, b) => cmpSubtree(a.name, b.name));
    const node: CacheTreeNode = { name, entryCount: exists ? list.length : -1, oid: exists ? oid : null, children };
    return { node, oid, exists };
  };
  const r = build("", entries, old, "");
  ix.tree = r.node;
  return r.oid;
}

// Write a blob to the work tree, creating parent dirs and replacing what is there.
export function checkoutFile(repo: Repo, path: string, oid: string, mode: string): void {
  const full = join(repo.wt(), path);
  const blob = repo.odb.read(oid);
  if (!blob) throw new Error(`unable to read ${oid}`);
  // a file standing where a directory must go (or vice versa) is removed
  let d = dirname(path);
  while (d !== "." && d !== "") {
    try {
      if (!lstatSync(join(repo.wt(), d)).isDirectory()) unlinkSync(join(repo.wt(), d));
    } catch {}
    d = dirname(d);
  }
  mkdirSync(dirname(full), { recursive: true });
  try {
    const st = lstatSync(full);
    if (st.isDirectory()) rmSync(full, { recursive: true, force: true });
    else {
      try { chmodSync(full, 0o666); } catch {}
      unlinkSync(full);
    }
  } catch {}
  writeFileSync(full, blob.body, { mode: mode === "100755" ? 0o777 : 0o666 });
}

export function removeWorkFile(repo: Repo, path: string): void {
  const root = repo.wt();
  try {
    unlinkSync(join(root, path));
  } catch {}
  let d = dirname(path);
  while (d !== "." && d !== "") {
    try {
      rmdirSync(join(root, d));
    } catch {
      break;
    }
    d = dirname(d);
  }
}

export function indexEntryFromTree(repo: Repo, path: string, fe: FlatEntry): IndexEntry {
  const full = join(repo.wt(), path);
  const st = statSync(full, { bigint: true });
  return entryFromStat(path, fe.oid, st, parseInt(fe.mode, 8));
}

// pkb never descends into its own repository directory, nor into a git one living alongside it.
function isRepoDirName(n: string): boolean {
  return n === REPO_DIR || n === ".git";
}
function isNestedRepo(dir: string): boolean {
  return existsSync(join(dir, REPO_DIR)) || existsSync(join(dir, ".git"));
}
