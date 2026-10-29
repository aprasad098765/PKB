// The index ("dircache"): format v2 read/write, cache-tree (TREE extension), locking.
// Evidence (rea-evidence/findings/03-index-status.md):
//  §1 do_read_index FUN_1402132a0 / do_write_index FUN_140213fb0: "DIRC" signature,
//     versions 2..4, default write v2 (v3 only if an entry has extended flags);
//     entry = ctime(s,ns) mtime(s,ns) dev ino mode uid gid size (BE32 each), 20-byte oid,
//     BE16 flags (namelen&0xfff, 0x8000 assume-valid, 0x4000 extended, 0x3000 stage);
//     name NUL-padded so entry length is (62+namelen+8)&~7; SHA-1 over everything as trailer.
//     Extensions written in order IEOT, link, TREE, REUC, UNTR, ...; normally only TREE.
//  §2 lockfile FUN_1401acf60: "<file>.lock" O_EXCL; message "Unable to create '%s.lock': %s."
//     + the "Another pkb process seems to be running..." paragraph (fixture add-lock-held).
//  §3 entries ordered by name bytes then stage.
// Observed (fixtures, see fixtures/README.md): cache-tree subtrees ordered by name length
// then bytes (cache-tree-order); invalid nodes written "-1 <nsub>" without oid; fresh index
// has no TREE; commit/write-tree/checkout/merge write a fully valid TREE; add invalidates the
// ancestors of each path it changes. Stat on Windows: dev/ino/uid/gid 0, ctime = creation time.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { die, err, GitExit } from "./output.ts";
import { toSlash } from "./repo.ts";

export interface IndexEntry {
  ctimeS: number; ctimeNs: number; mtimeS: number; mtimeNs: number;
  dev: number; ino: number; mode: number; uid: number; gid: number; size: number;
  oid: string;
  flags: number; // assume-valid / stage bits (namelen recomputed on write)
  extFlags: number;
  path: string;
}

export interface CacheTreeNode {
  name: string;
  entryCount: number; // -1 = invalid
  oid: string | null;
  children: CacheTreeNode[];
}

export const stageOf = (e: IndexEntry) => (e.flags >> 12) & 3;

export function cmpPath(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
export function cmpEntry(a: IndexEntry, b: IndexEntry): number {
  return cmpPath(a.path, b.path) || stageOf(a) - stageOf(b);
}
export function cmpSubtree(a: string, b: string): number {
  const la = Buffer.byteLength(a), lb = Buffer.byteLength(b);
  return la !== lb ? la - lb : cmpPath(a, b);
}

export class Index {
  entries: IndexEntry[] = [];
  tree: CacheTreeNode | null = null;
  version = 2;
  file: string;
  mtimeMs = 0; // index file mtime, for racy-clean detection
  private lockFd: number | null = null;

  constructor(file: string) {
    this.file = file;
  }

  static read(file: string): Index {
    const ix = new Index(file);
    if (!existsSync(file)) return ix;
    const buf = readFileSync(file);
    if (buf.toString("latin1", 0, 4) !== "DIRC") die("index file corrupt");
    const want = createHash("sha1").update(buf.subarray(0, buf.length - 20)).digest("hex");
    if (want !== buf.toString("hex", buf.length - 20)) die("index file corrupt");
    ix.version = buf.readUInt32BE(4);
    if (ix.version < 2 || ix.version > 3) die(`index file version ${ix.version} is not supported`);
    const n = buf.readUInt32BE(8);
    let o = 12;
    for (let i = 0; i < n; i++) {
      const flags = buf.readUInt16BE(o + 60);
      let nameStart = o + 62, extFlags = 0;
      if (flags & 0x4000) {
        extFlags = buf.readUInt16BE(o + 62);
        nameStart += 2;
      }
      const nameEnd = buf.indexOf(0, nameStart);
      ix.entries.push({
        ctimeS: buf.readUInt32BE(o), ctimeNs: buf.readUInt32BE(o + 4), mtimeS: buf.readUInt32BE(o + 8), mtimeNs: buf.readUInt32BE(o + 12),
        dev: buf.readUInt32BE(o + 16), ino: buf.readUInt32BE(o + 20), mode: buf.readUInt32BE(o + 24), uid: buf.readUInt32BE(o + 28),
        gid: buf.readUInt32BE(o + 32), size: buf.readUInt32BE(o + 36), oid: buf.toString("hex", o + 40, o + 60),
        flags: flags & 0xb000, extFlags, path: buf.toString("utf8", nameStart, nameEnd),
      });
      const entLen = nameStart - o + (nameEnd - nameStart);
      o += (entLen + 8) & ~7;
    }
    while (o < buf.length - 20) {
      const sig = buf.toString("latin1", o, o + 4), len = buf.readUInt32BE(o + 4);
      if (sig === "TREE") ix.tree = parseCacheTree(buf.subarray(o + 8, o + 8 + len));
      else if (sig[0] < "A" || sig[0] > "Z") die(`index uses ${sig} extension, which we do not understand`);
      o += 8 + len;
    }
    try {
      ix.mtimeMs = statSync(file).mtimeMs;
    } catch {}
    return ix;
  }

  // Lock "<index>.lock" (exclusive create). Dies with the observed message on contention.
  lock(): void {
    const lockPath = this.file + ".lock";
    try {
      this.lockFd = openSync(lockPath, "wx");
    } catch (e: any) {
      const reason = e.code === "EEXIST" ? "File exists" : e.message;
      err(`fatal: Unable to create '${toSlash(lockPath)}': ${reason}.\n\n`);
      if (e.code === "EEXIST") {
        err("Another pkb process seems to be running in this repository, e.g.\n" +
          "an editor opened by 'pkb commit'. Please make sure all processes\n" +
          "are terminated then try again. If it still fails, a pkb process\n" +
          "may have crashed in this repository earlier:\n" +
          "remove the file manually to continue.\n");
      }
      throw new GitExit(128);
    }
    process.once("exit", () => this.rollback());
  }

  rollback(): void {
    if (this.lockFd !== null) {
      try { closeSync(this.lockFd); } catch {}
      rmSync(this.file + ".lock", { force: true });
      this.lockFd = null;
    }
  }

  serialize(): Buffer {
    this.entries.sort(cmpEntry);
    const ext = this.entries.some((e) => e.extFlags);
    const parts: Buffer[] = [];
    const head = Buffer.alloc(12);
    head.write("DIRC", 0, "latin1");
    head.writeUInt32BE(ext ? 3 : 2, 4);
    head.writeUInt32BE(this.entries.length, 8);
    parts.push(head);
    for (const e of this.entries) {
      const name = Buffer.from(e.path, "utf8");
      const fixed = ext && e.extFlags ? 64 : 62;
      const len = (fixed + name.length + 8) & ~7;
      const b = Buffer.alloc(len);
      const u32 = [e.ctimeS, e.ctimeNs, e.mtimeS, e.mtimeNs, e.dev, e.ino, e.mode, e.uid, e.gid, e.size];
      u32.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
      b.write(e.oid, 40, "hex");
      b.writeUInt16BE((e.flags & 0xb000) | (e.extFlags ? 0x4000 : 0) | Math.min(name.length, 0xfff), 60);
      if (fixed === 64) b.writeUInt16BE(e.extFlags, 62);
      name.copy(b, fixed);
      parts.push(b);
    }
    if (this.tree) {
      const t = serializeCacheTree(this.tree);
      const h = Buffer.alloc(8);
      h.write("TREE", 0, "latin1");
      h.writeUInt32BE(t.length, 4);
      parts.push(h, t);
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([body, createHash("sha1").update(body).digest()]);
  }

  // Write through the held lock and rename into place.
  commit(): void {
    if (this.lockFd === null) this.lock();
    const data = this.serialize();
    writeSync(this.lockFd!, data);
    closeSync(this.lockFd!);
    this.lockFd = null;
    renameSync(this.file + ".lock", this.file);
  }

  find(path: string): IndexEntry | undefined {
    let lo = 0, hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = cmpPath(this.entries[mid].path, path);
      if (c === 0) return this.entries[mid];
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    return undefined;
  }

  sort(): void {
    this.entries.sort(cmpEntry);
  }

  set(e: IndexEntry): void {
    const i = this.entries.findIndex((x) => x.path === e.path);
    if (i >= 0) this.entries[i] = e;
    else {
      this.entries.push(e);
      this.sort();
    }
    this.invalidate(e.path);
  }

  remove(path: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.path !== path);
    if (this.entries.length !== before) {
      this.invalidate(path);
      return true;
    }
    return false;
  }

  // Mark the root and every cache-tree node on the way to `path` invalid.
  invalidate(path: string): void {
    let node = this.tree;
    if (!node) return;
    node.entryCount = -1;
    node.oid = null;
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1 && node; i++) {
      node = node.children.find((c) => c.name === parts[i]) ?? null;
      if (node) {
        node.entryCount = -1;
        node.oid = null;
      }
    }
  }
}


function parseCacheTree(buf: Buffer): CacheTreeNode | null {
  let p = 0;
  const readNode = (): CacheTreeNode => {
    const nul = buf.indexOf(0, p);
    const name = buf.toString("utf8", p, nul);
    p = nul + 1;
    const nl = buf.indexOf(0x0a, p);
    const [cnt, sub] = buf.toString("latin1", p, nl).split(" ").map(Number);
    p = nl + 1;
    let oid: string | null = null;
    if (cnt >= 0) {
      oid = buf.toString("hex", p, p + 20);
      p += 20;
    }
    const node: CacheTreeNode = { name, entryCount: cnt, oid, children: [] };
    for (let i = 0; i < sub; i++) node.children.push(readNode());
    return node;
  };
  try {
    return buf.length ? readNode() : null;
  } catch {
    return null;
  }
}

function serializeCacheTree(root: CacheTreeNode): Buffer {
  const parts: Buffer[] = [];
  const walk = (n: CacheTreeNode) => {
    n.children.sort((a, b) => cmpSubtree(a.name, b.name));
    parts.push(Buffer.from(`${n.name}\0${n.entryCount} ${n.children.length}\n`, "utf8"));
    if (n.entryCount >= 0 && n.oid) parts.push(Buffer.from(n.oid, "hex"));
    n.children.forEach(walk);
  };
  walk(root);
  return Buffer.concat(parts);
}

// Build an index entry from a work-tree stat.
export function entryFromStat(path: string, oid: string, st: BigIntStats, mode: number): IndexEntry {
  const ns = (t: bigint) => [Number(t / 1000000000n) >>> 0, Number(t % 1000000000n)];
  // Windows: git-for-windows reports creation time as ctime and zero dev/ino/uid/gid (fixture add-basic raw index).
  const [cs, cn] = ns(process.platform === "win32" ? st.birthtimeNs : st.ctimeNs);
  const [ms, mn] = ns(st.mtimeNs);
  const win = process.platform === "win32";
  return {
    ctimeS: cs, ctimeNs: cn, mtimeS: ms, mtimeNs: mn,
    dev: win ? 0 : Number(st.dev) >>> 0, ino: win ? 0 : Number(st.ino & 0xffffffffn), mode,
    uid: win ? 0 : Number(st.uid), gid: win ? 0 : Number(st.gid), size: Number(st.size & 0xffffffffn),
    oid, flags: 0, extFlags: 0, path,
  };
}
