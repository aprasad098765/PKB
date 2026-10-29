// Revision parsing: names, abbreviated hex, ~N, ^N, ^{type}, <rev>:<path>, :<path>.
// Evidence: rea-evidence/findings/02-objects.md §6 (cat-file resolves its argument with
// get_oid_with_context; "Not a valid object name %s" on failure) and the observed messages
// "path '%s' does not exist in '%s'" (fixture cat-file) and "ambiguous argument '%s':
// unknown revision or path not in the working tree." (fixtures log-history, diff-commits).
// Ref lookup order follows the dwim rules: <name>, refs/<name>, refs/tags/<name>,
// refs/heads/<name>, refs/remotes/<name>, refs/remotes/<name>/HEAD.
import type { Repo } from "./repo.ts";
import { resolveRef, head } from "./refs.ts";
import { parseCommit, parseTree, isTreeMode } from "./objects.ts";
import { Index } from "./dircache.ts";
import { die } from "./output.ts";

export function dwimRef(repo: Repo, name: string): { ref: string; oid: string } | null {
  if (name === "@") name = "HEAD";
  const cands = [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`];
  for (const c of cands) {
    if (c !== "HEAD" && !c.startsWith("refs/") && !/^[A-Z_]+$/.test(c)) continue;
    const r = resolveRef(repo, c);
    if (r && r.oid) return { ref: c, oid: r.oid };
  }
  return null;
}

function resolveBase(repo: Repo, name: string): string | null {
  if (/^[0-9a-f]{40}$/i.test(name)) return name.toLowerCase();
  const r = dwimRef(repo, name);
  if (r) return r.oid;
  if (/^[0-9a-f]{4,39}$/i.test(name)) {
    const m = repo.odb.findPrefix(name.toLowerCase());
    if (m.length === 1) return m[0];
  }
  return null;
}

export function peel(repo: Repo, oid: string, want: string): string | null {
  for (let i = 0; i < 20; i++) {
    const o = repo.odb.read(oid);
    if (!o) return null;
    if (want === "" ? o.type !== "tag" : o.type === want) return oid;
    if (o.type === "tag") {
      const m = o.body.toString("utf8").match(/^object ([0-9a-f]{40})/);
      if (!m) return null;
      oid = m[1];
    } else if (o.type === "commit" && want === "tree") return parseCommit(o.body).tree;
    else return null;
  }
  return null;
}

function applySuffixes(repo: Repo, oid: string, suffix: string): string | null {
  let s = suffix;
  let cur: string | null = oid;
  while (s && cur) {
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^\^\{(\w*)\}/))) {
      cur = peel(repo, cur, m[1] === "object" ? "" : m[1]);
    } else if ((m = s.match(/^~(\d*)/))) {
      const n = m[1] === "" ? 1 : Number(m[1]);
      for (let i = 0; i < n && cur; i++) {
        const c: string | null = peel(repo, cur, "commit");
        cur = c ? parseCommit(repo.odb.read(c)!.body).parents[0] ?? null : null;
      }
    } else if ((m = s.match(/^\^(\d*)/))) {
      const n = m[1] === "" ? 1 : Number(m[1]);
      const c = peel(repo, cur, "commit");
      cur = c ? (n === 0 ? c : parseCommit(repo.odb.read(c)!.body).parents[n - 1] ?? null) : null;
    } else return null;
    s = s.slice(m[0].length);
  }
  return cur;
}

export function treeLookup(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  let cur = { oid: treeOid, mode: "40000" };
  for (const part of path.split("/").filter(Boolean)) {
    if (!isTreeMode(cur.mode)) return null;
    const t = repo.odb.read(cur.oid);
    if (!t || t.type !== "tree") return null;
    const e = parseTree(t.body).find((x) => x.name === part);
    if (!e) return null;
    cur = { oid: e.oid, mode: e.mode };
  }
  return cur;
}

// Resolve to an object id, or null. Dies for "<rev>:<missing path>" like git.
export function resolveRev(repo: Repo, spec: string): string | null {
  const colon = spec.indexOf(":");
  if (colon >= 0) {
    const rev = spec.slice(0, colon);
    let path = spec.slice(colon + 1);
    if (path.startsWith("./") || path.startsWith("../")) path = normalize(repo.prefix + path);
    if (rev === "") {
      const ix = Index.read(repo.path("index"));
      const e = ix.find(path);
      if (!e) die(`path '${path}' does not exist (neither on disk nor in the index)`);
      return e.oid;
    }
    const base = resolveRev(repo, rev);
    if (!base) return null;
    const tree = peel(repo, base, "tree");
    if (!tree) return null;
    if (path === "") return tree;
    const hit = treeLookup(repo, tree, path);
    if (!hit) die(`path '${path}' does not exist in '${rev}'`);
    return hit.oid;
  }
  const m = spec.match(/^(.*?)((?:\^\{\w*\}|~\d*|\^\d*)*)$/);
  if (!m || m[1] === "") return null;
  const base = resolveBase(repo, m[1]);
  if (!base) return null;
  return m[2] ? applySuffixes(repo, base, m[2]) : base;
}

export function resolveCommit(repo: Repo, spec: string): string | null {
  const o = resolveRev(repo, spec);
  return o ? peel(repo, o, "commit") : null;
}

export function headCommit(repo: Repo): string | null {
  return head(repo).oid;
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}
