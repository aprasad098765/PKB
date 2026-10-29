// Object database: loose objects (read/write) and read-only pack support.
// Evidence (rea-evidence/findings/02-objects.md):
//  §1 write_object_file 0x1401d0d40: header "%s %I64u" + NUL, SHA-1 over header+body,
//     path objects/<2hex>/<38hex>; temp file "tmp_obj_XXXXXX" created 0444 then renamed
//     (0x1401d2220 / 0x1401d2f50); missing fan-out dirs created 0777.
//  §2 loose read 0x1401d4aa0: inflate, parse "<type> <size>\0".
//  §3 SHA-1 (sha1dc) 0x1403d86c0 — identical digests to plain SHA-1 for non-colliding input.
// Fixtures: every loose object starts with zlib header 78 01 (level 1) — fixtures/README.md.
// Packs: read-only, so repos repacked by the real git stay readable (idx v2, OFS/REF deltas).
import { createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";

export type ObjType = "blob" | "tree" | "commit" | "tag";
export const OBJ_TYPES: ObjType[] = ["blob", "tree", "commit", "tag"];
export interface GitObject {
  type: ObjType;
  body: Buffer;
}

export const ZERO_OID = "0".repeat(40);
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function hashObject(type: string, body: Buffer): { oid: string; raw: Buffer } {
  const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, "latin1"), body]);
  return { oid: createHash("sha1").update(raw).digest("hex"), raw };
}

interface Pack {
  idx: Buffer;
  packPath: string;
  count: number;
}

export class ObjectDB {
  dir: string;
  private packs: Pack[] | null = null;
  private cache = new Map<string, GitObject>();

  constructor(objectsDir: string) {
    this.dir = objectsDir;
  }

  // forget the pack list after new packs were written (fetch/clone)
  reloadPacks(): void {
    this.packs = null;
  }

  loosePath(oid: string): string {
    return join(this.dir, oid.slice(0, 2), oid.slice(2));
  }

  write(type: ObjType, body: Buffer): string {
    const { oid, raw } = hashObject(type, body);
    if (this.has(oid)) return oid;
    const fanout = join(this.dir, oid.slice(0, 2));
    mkdirSync(fanout, { recursive: true, mode: 0o777 });
    const tmp = join(fanout, `tmp_obj_${randomBytes(4).toString("hex").slice(0, 6)}`);
    writeFileSync(tmp, deflateSync(raw, { level: 1 }), { mode: 0o444 });
    try {
      renameSync(tmp, this.loosePath(oid));
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!existsSync(this.loosePath(oid))) throw e;
    }
    return oid;
  }

  has(oid: string): boolean {
    if (this.cache.has(oid) || existsSync(this.loosePath(oid))) return true;
    return this.packFind(oid) !== null;
  }

  read(oid: string): GitObject | null {
    const c = this.cache.get(oid);
    if (c) return c;
    let obj: GitObject | null = null;
    const p = this.loosePath(oid);
    if (existsSync(p)) {
      const inf = inflateSync(readFileSync(p));
      const nul = inf.indexOf(0);
      const [type, size] = inf.toString("latin1", 0, nul).split(" ");
      const body = inf.subarray(nul + 1);
      if (!OBJ_TYPES.includes(type as ObjType) || Number(size) !== body.length) throw new Error(`loose object ${oid} is corrupt`);
      obj = { type: type as ObjType, body };
    } else {
      const loc = this.packFind(oid);
      if (loc) obj = this.packRead(loc.pack, loc.offset);
    }
    if (obj) this.cache.set(oid, obj);
    return obj;
  }

  // All object ids starting with a hex prefix (loose + packed).
  findPrefix(prefix: string): string[] {
    const out = new Set<string>();
    const fan = join(this.dir, prefix.slice(0, 2));
    if (prefix.length >= 2 && existsSync(fan)) {
      for (const f of readdirSync(fan)) if (/^[0-9a-f]{38}$/.test(f) && (prefix.slice(0, 2) + f).startsWith(prefix)) out.add(prefix.slice(0, 2) + f);
    }
    for (const pk of this.loadPacks()) {
      for (let i = 0; i < pk.count; i++) {
        const oid = pk.idx.toString("hex", 8 + 1024 + i * 20, 8 + 1024 + i * 20 + 20);
        if (oid.startsWith(prefix)) out.add(oid);
      }
    }
    return [...out];
  }

  // Shortest unique abbreviation, minimum 7 (fixtures: commit summaries, log --oneline, diff index lines).
  abbrev(oid: string, min = 7): string {
    for (let n = min; n < 40; n++) {
      const p = oid.slice(0, n);
      if (this.findPrefix(p).filter((o) => o !== oid).length === 0) return p;
    }
    return oid;
  }

  private loadPacks(): Pack[] {
    if (this.packs) return this.packs;
    this.packs = [];
    const pd = join(this.dir, "pack");
    if (!existsSync(pd)) return this.packs;
    for (const f of readdirSync(pd)) {
      if (!f.endsWith(".idx")) continue;
      const idx = readFileSync(join(pd, f));
      if (idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) continue;
      this.packs.push({ idx, packPath: join(pd, f.replace(/\.idx$/, ".pack")), count: idx.readUInt32BE(8 + 255 * 4) });
    }
    return this.packs;
  }

  private packFind(oid: string): { pack: Pack; offset: number } | null {
    const want = Buffer.from(oid, "hex");
    for (const pk of this.loadPacks()) {
      const first = want[0];
      let lo = first === 0 ? 0 : pk.idx.readUInt32BE(8 + (first - 1) * 4);
      let hi = pk.idx.readUInt32BE(8 + first * 4);
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const c = pk.idx.compare(want, 0, 20, 8 + 1024 + mid * 20, 8 + 1024 + mid * 20 + 20);
        if (c === 0) {
          const offTab = 8 + 1024 + pk.count * 24;
          let off = pk.idx.readUInt32BE(offTab + mid * 4);
          if (off & 0x80000000) {
            const big = offTab + pk.count * 4 + (off & 0x7fffffff) * 8;
            off = Number(pk.idx.readBigUInt64BE(big));
          }
          return { pack: pk, offset: off };
        }
        // c compares the idx entry against `want`: entry < want means search right
        if (c < 0) lo = mid + 1;
        else hi = mid;
      }
    }
    return null;
  }

  private packRead(pk: Pack, offset: number): GitObject {
    const fd = openSync(pk.packPath, "r");
    try {
      return this.packReadAt(fd, pk, offset);
    } finally {
      closeSync(fd);
    }
  }

  private packReadAt(fd: number, pk: Pack, offset: number): GitObject {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, offset);
    let p = 0;
    let c = head[p++];
    const typeNum = (c >> 4) & 7;
    let len = c & 15, shift = 4;
    while (c & 0x80) {
      c = head[p++];
      len += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let base: GitObject | null = null;
    if (typeNum === 6) {
      c = head[p++];
      let rel = c & 0x7f;
      while (c & 0x80) {
        c = head[p++];
        rel = ((rel + 1) * 128) + (c & 0x7f);
      }
      base = this.packReadAt(fd, pk, offset - rel);
    } else if (typeNum === 7) {
      const baseOid = head.toString("hex", p, p + 20);
      p += 20;
      base = this.read(baseOid);
      if (!base) throw new Error(`missing delta base ${baseOid}`);
    }
    // Inflate from the data start; read a generous window and let zlib stop at stream end.
    const avail = size - (offset + p);
    const win = Buffer.alloc(Math.min(avail, Math.max(len * 2 + 1024, 65536)));
    readSync(fd, win, 0, win.length, offset + p);
    let data: Buffer;
    try {
      data = inflateSync(win, { finishFlush: 2 });
    } catch {
      const all = Buffer.alloc(avail);
      readSync(fd, all, 0, avail, offset + p);
      data = inflateSync(all, { finishFlush: 2 });
    }
    if (base) return { type: base.type, body: applyDelta(base.body, data) };
    const t = ["", "commit", "tree", "blob", "tag"][typeNum] as ObjType;
    return { type: t, body: data.subarray(0, len) };
  }
}

function applyDelta(base: Buffer, d: Buffer): Buffer {
  let p = 0;
  const varint = () => {
    let v = 0, s = 0, c;
    do {
      c = d[p++];
      v += (c & 0x7f) * 2 ** s;
      s += 7;
    } while (c & 0x80);
    return v;
  };
  varint();
  const outLen = varint();
  const out = Buffer.alloc(outLen);
  let o = 0;
  while (p < d.length) {
    const op = d[p++];
    if (op & 0x80) {
      let off = 0, n = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= d[p++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) n |= d[p++] << (8 * i);
      if (n === 0) n = 0x10000;
      base.copy(out, o, off >>> 0, (off >>> 0) + n);
      o += n;
    } else {
      d.copy(out, o, p, p + op);
      o += op;
      p += op;
    }
  }
  return out;
}
