// Files-backend references, symbolic refs and reflogs.
// Evidence (rea-evidence/findings/04-refs-porcelain.md):
//  §2 files backend (FUN_140230490): loose ref file "<40hex>\n"; symref "ref: <target>\n";
//     packed-refs header "# pack-refs with: peeled fully-peeled sorted " and "^" peel lines;
//     reflog line "%s %s %s" (old, new, committer ident) + "\t<msg>\n"; core.logAllRefUpdates
//     (true in non-bare repos) creates logs for HEAD and refs/heads/*.
// Observed (fixtures merge-ff, checkout-branches, detached-head, branch-ops):
//  updating a branch through HEAD logs both logs/HEAD and logs/refs/heads/<b>;
//  branch creation logs "branch: Created from <start>"; deleting a branch removes its reflog.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Repo } from "./repo.ts";
import { ident } from "./ident.ts";
import { ZERO_OID } from "./odb.ts";
import { die } from "./output.ts";

export interface HeadInfo {
  symref: string | null; // e.g. refs/heads/master; null when detached
  oid: string | null; // null when unborn
}

function readPacked(repo: Repo): Map<string, string> {
  const m = new Map<string, string>();
  const f = repo.path("packed-refs");
  if (!existsSync(f)) return m;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [oid, name] = line.split(" ");
    m.set(name, oid);
  }
  return m;
}

export function readRefRaw(repo: Repo, name: string): string | null {
  const f = repo.path(name);
  if (existsSync(f)) {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {
      return null; // a directory (e.g. refs/heads)
    }
  }
  return readPacked(repo).get(name) ?? null;
}

// Follow symrefs; returns the final ref name and its oid (null if unborn/missing).
export function resolveRef(repo: Repo, name: string): { ref: string; oid: string | null } | null {
  let cur = name;
  for (let depth = 0; depth < 5; depth++) {
    const raw = readRefRaw(repo, cur);
    if (raw === null) return depth === 0 ? null : { ref: cur, oid: null };
    if (raw.startsWith("ref: ")) {
      cur = raw.slice(5).trim();
      continue;
    }
    return /^[0-9a-f]{40}$/.test(raw) ? { ref: cur, oid: raw } : null;
  }
  return null;
}

export function head(repo: Repo): HeadInfo {
  const raw = readRefRaw(repo, "HEAD") ?? "";
  if (raw.startsWith("ref: ")) {
    const target = raw.slice(5).trim();
    return { symref: target, oid: resolveRef(repo, target)?.oid ?? null };
  }
  return { symref: null, oid: /^[0-9a-f]{40}$/.test(raw) ? raw : null };
}

export const shortRef = (r: string) => r.replace(/^refs\/(heads|tags|remotes)\//, "");

function shouldLog(repo: Repo, ref: string): boolean {
  if (existsSync(repo.path("logs", ref))) return true;
  const v = repo.config.get("core.logallrefupdates");
  const on = v === undefined ? !repo.bare : ["true", "always", "yes", "on", "1"].includes(v.toLowerCase());
  if (!on) return false;
  return v?.toLowerCase() === "always" || ref === "HEAD" || /^refs\/(heads|remotes|notes)\//.test(ref);
}

export function appendReflog(repo: Repo, ref: string, oldOid: string | null, newOid: string, msg: string): void {
  if (!shouldLog(repo, ref)) return;
  const f = repo.path("logs", ref);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${oldOid ?? ZERO_OID} ${newOid} ${ident("committer", repo.config, true)}\t${msg.replace(/\n/g, " ")}\n`);
}

function writeLocked(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const lock = file + ".lock";
  try {
    writeFileSync(lock, content, { flag: "wx" });
  } catch (e: any) {
    die(`cannot lock ref '${file}': Unable to create '${lock.replace(/\\/g, "/")}': ${e.code === "EEXIST" ? "File exists" : e.message}.`);
  }
  renameSync(lock, file);
}

// Update `name` (a full ref, or HEAD which is dereferenced unless detached/noDeref).
export function updateRef(repo: Repo, name: string, newOid: string, msg: string, opts: { noDeref?: boolean } = {}): void {
  let target = name;
  const viaHead = name === "HEAD";
  if (viaHead && !opts.noDeref) {
    const h = head(repo);
    if (h.symref) target = h.symref;
  }
  const old = target === "HEAD" ? head(repo).oid : resolveRef(repo, target)?.oid ?? null;
  writeLocked(repo.path(target), `${newOid}\n`);
  appendReflog(repo, target, old, newOid, msg);
  if (viaHead && target !== "HEAD") appendReflog(repo, "HEAD", old, newOid, msg);
  else if (!viaHead) {
    // Updating the branch HEAD points at also records in HEAD's reflog.
    const h = head(repo);
    if (h.symref === target) appendReflog(repo, "HEAD", old, newOid, msg);
  }
}

export function setHeadSymref(repo: Repo, target: string): void {
  writeLocked(repo.path("HEAD"), `ref: ${target}\n`);
}
export function setHeadDetached(repo: Repo, oid: string): void {
  writeLocked(repo.path("HEAD"), `${oid}\n`);
}

export function deleteRef(repo: Repo, name: string): void {
  rmSync(repo.path(name), { force: true });
  const packed = repo.path("packed-refs");
  if (existsSync(packed)) {
    const lines = readFileSync(packed, "utf8").split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].endsWith(" " + name) && !lines[i].startsWith("#")) {
        if (lines[i + 1]?.startsWith("^")) i++;
        continue;
      }
      out.push(lines[i]);
    }
    writeLocked(packed, out.join("\n"));
  }
  rmSync(repo.path("logs", name), { force: true });
  // prune now-empty directories under refs/ and logs/refs/
  for (const base of ["", "logs"]) {
    let d = dirname(join(repo.gitDir, base, name));
    const stop = join(repo.gitDir, base, "refs", "heads");
    while (d.length > stop.length) {
      try { rmdirSync(d); } catch { break; }
      d = dirname(d);
    }
  }
}

// All refs under a prefix ("refs/heads/"), sorted by name.
export function listRefs(repo: Repo, prefix: string): { name: string; oid: string }[] {
  const out = new Map<string, string>(readPacked(repo));
  const walk = (rel: string) => {
    const d = repo.path(rel);
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (!e.name.endsWith(".lock")) {
        const v = readFileSync(repo.path(r), "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(v)) out.set(r, v);
      }
    }
  };
  walk(prefix.replace(/\/$/, ""));
  return [...out].filter(([n]) => n.startsWith(prefix)).map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// check-ref-format rules for a branch name component list.
export function validRefName(name: string): boolean {
  if (!name || name === "@" || name.startsWith("-")) return false;
  if (/(^|\/)\.|\.\.|@\{|[\x00-\x20\x7f~^:?*[\\]|\/\/|\/$|\.$|\.lock(\/|$)/.test(name)) return false;
  return true;
}

// "HEAD detached at|from <x>": taken from the last "checkout: moving from A to B" HEAD
// reflog entry (fixture detached-head shows the abbreviated target commit).
export function detachedFrom(repo: Repo, headOid: string): { word: "at" | "from"; oid: string; name: string | null } {
  const f = repo.path("logs", "HEAD");
  if (existsSync(f)) {
    const lines = readFileSync(f, "utf8").trimEnd().split("\n").reverse();
    for (const l of lines) {
      const m = l.match(/^[0-9a-f]{40} ([0-9a-f]{40}) .*\tcheckout: moving from .* to (.*)$/);
      if (m) {
        const target = m[2];
        const isRefName = !/^[0-9a-f]{4,40}$/.test(target) && !/[~^:@]/.test(target) && target !== "HEAD";
        return { word: m[1] === headOid ? "at" : "from", oid: m[1], name: isRefName ? target : null };
      }
    }
  }
  return { word: "at", oid: headOid, name: null };
}
