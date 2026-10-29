// Pack files: indexing a received pack (.idx v2 + .rev), exploding small packs into loose
// objects, and writing packs for push.
// Format notes (observed in fixtures/net-clone-basic/dotgit/objects/pack, and matching what
// odb.ts already reads): "PACK", version 2, object count, entries, SHA-1 trailer; a pack is
// named after that trailer. Entry header: type in bits 4-6 of the first byte, size in a
// little-endian base-128 varint; OFS_DELTA (6) carries a big-endian "offset-1" varint,
// REF_DELTA (7) a 20-byte base id. .idx v2: ff744f63, 2, 256-entry fan-out, sorted ids,
// CRC32 of each entry's raw bytes, 31-bit offsets (+64-bit table), pack checksum, own checksum.
// .rev: "RIDX", 1, hash id 1, index positions in pack order, pack checksum, own checksum.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hashObject } from "./odb.ts";
import type { ObjectDB, ObjType } from "./odb.ts";

const TYPES: (ObjType | null)[] = [null, "commit", "tree", "blob", "tag"];

interface Entry {
  offset: number;
  end: number;
  type: number; // raw type number (1-4, 6, 7)
  baseOffset?: number;
  baseOid?: string;
  data: Buffer; // inflated payload (delta for 6/7)
  oid?: string;
  objType?: ObjType;
  body?: Buffer;
}

export function applyDelta(base: Buffer, d: Buffer): Buffer {
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
  const out = Buffer.alloc(varint());
  let o = 0;
  while (p < d.length) {
    const op = d[p++];
    if (op & 0x80) {
      let off = 0, n = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += d[p++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) n |= d[p++] << (8 * i);
      if (n === 0) n = 0x10000;
      base.copy(out, o, off, off + n);
      o += n;
    } else {
      d.copy(out, o, p, p + op);
      o += op;
      p += op;
    }
  }
  return out;
}

// Parse every entry and resolve deltas (bases from this pack or, for thin packs, the odb).
export function parsePack(pack: Buffer, odb: ObjectDB | null): Entry[] {
  if (pack.toString("latin1", 0, 4) !== "PACK") throw new Error("not a pack file");
  const count = pack.readUInt32BE(8);
  const want = createHash("sha1").update(pack.subarray(0, pack.length - 20)).digest();
  if (!want.equals(pack.subarray(pack.length - 20))) throw new Error("pack checksum mismatch");
  const entries: Entry[] = [];
  let p = 12;
  for (let i = 0; i < count; i++) {
    const offset = p;
    let c = pack[p++];
    const type = (c >> 4) & 7;
    while (c & 0x80) c = pack[p++];
    const e: Entry = { offset, end: 0, type, data: Buffer.alloc(0) };
    if (type === 6) {
      c = pack[p++];
      let rel = c & 0x7f;
      while (c & 0x80) {
        c = pack[p++];
        rel = (rel + 1) * 128 + (c & 0x7f);
      }
      e.baseOffset = offset - rel;
    } else if (type === 7) {
      e.baseOid = pack.toString("hex", p, p + 20);
      p += 20;
    }
    const r = inflateSync(pack.subarray(p, pack.length - 20), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    e.data = r.buffer;
    p += r.engine.bytesWritten;
    e.end = p;
    entries.push(e);
  }
  const byOffset = new Map(entries.map((e) => [e.offset, e]));
  const byOid = new Map<string, Entry>();
  const finish = (e: Entry, t: ObjType, body: Buffer) => {
    e.objType = t;
    e.body = body;
    e.oid = hashObject(t, body).oid;
    byOid.set(e.oid, e);
  };
  for (const e of entries) if (e.type >= 1 && e.type <= 4) finish(e, TYPES[e.type]!, e.data);
  let pending = entries.filter((e) => !e.oid);
  while (pending.length) {
    const before = pending.length;
    for (const e of pending) {
      let base: { type: ObjType; body: Buffer } | null = null;
      if (e.baseOffset !== undefined) {
        const b = byOffset.get(e.baseOffset);
        if (b?.oid) base = { type: b.objType!, body: b.body! };
      } else if (e.baseOid) {
        const b = byOid.get(e.baseOid);
        if (b) base = { type: b.objType!, body: b.body! };
        else if (odb) {
          const o = odb.read(e.baseOid);
          if (o) base = o;
        }
      }
      if (base) finish(e, base.type, applyDelta(base.body, e.data));
    }
    pending = pending.filter((e) => !e.oid);
    if (pending.length === before) throw new Error(`pack has ${pending.length} unresolvable delta(s)`);
  }
  return entries;
}

// Store a pack with its .idx and .rev, named after the pack trailer. Returns the pack name.
export function storePack(objectsDir: string, pack: Buffer, entries: Entry[]): string {
  const checksum = pack.subarray(pack.length - 20);
  const name = `pack-${checksum.toString("hex")}`;
  const dir = join(objectsDir, "pack");
  mkdirSync(dir, { recursive: true });
  const sorted = [...entries].sort((a, b) => (a.oid! < b.oid! ? -1 : a.oid! > b.oid! ? 1 : 0));
  const n = sorted.length;
  const fan = Buffer.alloc(1024);
  for (let b = 0, k = 0; b < 256; b++) {
    while (k < n && parseInt(sorted[k].oid!.slice(0, 2), 16) <= b) k++;
    fan.writeUInt32BE(k, b * 4);
  }
  const ids = Buffer.concat(sorted.map((e) => Buffer.from(e.oid!, "hex")));
  const crcs = Buffer.alloc(4 * n), offs = Buffer.alloc(4 * n);
  const big: Buffer[] = [];
  sorted.forEach((e, i) => {
    crcs.writeUInt32BE(crc32(pack.subarray(e.offset, e.end)) >>> 0, i * 4);
    if (e.offset < 0x80000000) offs.writeUInt32BE(e.offset, i * 4);
    else {
      offs.writeUInt32BE((0x80000000 | big.length) >>> 0, i * 4);
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(e.offset));
      big.push(b);
    }
  });
  const head = Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]);
  const idxBody = Buffer.concat([head, fan, ids, crcs, offs, ...big, checksum]);
  const idx = Buffer.concat([idxBody, createHash("sha1").update(idxBody).digest()]);
  const pos = new Map(sorted.map((e, i) => [e.offset, i]));
  const rev = Buffer.alloc(12 + 4 * n);
  rev.write("RIDX", 0, "latin1");
  rev.writeUInt32BE(1, 4);
  rev.writeUInt32BE(1, 8);
  [...entries].sort((a, b) => a.offset - b.offset).forEach((e, i) => rev.writeUInt32BE(pos.get(e.offset)!, 12 + 4 * i));
  const revBody = Buffer.concat([rev, checksum]);
  const revFile = Buffer.concat([revBody, createHash("sha1").update(revBody).digest()]);
  if (!existsSync(join(dir, name + ".pack"))) {
    writeFileSync(join(dir, name + ".pack"), pack, { mode: 0o444 });
    writeFileSync(join(dir, name + ".rev"), revFile, { mode: 0o444 });
    writeFileSync(join(dir, name + ".idx"), idx, { mode: 0o444 });
  }
  return name;
}

// Every object reachable from `include` (commits, trees, blobs, tags) that is not reachable
// from `exclude`. Missing objects on the exclude side are skipped.
export function enumerateObjects(odb: ObjectDB, include: string[], exclude: string[]): string[] {
  const hidden = new Set<string>();
  const walk = (start: string[], into: Set<string>, stopAt: Set<string> | null, order: string[] | null) => {
    const st = [...start];
    while (st.length) {
      const oid = st.pop()!;
      if (into.has(oid) || stopAt?.has(oid)) continue;
      const o = odb.read(oid);
      if (!o) continue;
      into.add(oid);
      order?.push(oid);
      if (o.type === "commit") {
        const s = o.body.toString("utf8");
        const tree = s.match(/^tree ([0-9a-f]{40})/m)![1];
        st.push(tree);
        for (const m of s.slice(0, s.indexOf("\n\n")).matchAll(/^parent ([0-9a-f]{40})/gm)) st.push(m[1]);
      } else if (o.type === "tree") {
        let p = 0;
        while (p < o.body.length) {
          const sp = o.body.indexOf(0x20, p), nul = o.body.indexOf(0, sp);
          const mode = o.body.toString("latin1", p, sp);
          if (mode !== "160000") st.push(o.body.toString("hex", nul + 1, nul + 21));
          p = nul + 21;
        }
      } else if (o.type === "tag") {
        const m = o.body.toString("utf8").match(/^object ([0-9a-f]{40})/);
        if (m) st.push(m[1]);
      }
    }
  };
  walk(exclude, hidden, null, null);
  const seen = new Set<string>(), order: string[] = [];
  walk(include, seen, hidden, order);
  return order;
}

// Build a pack (no deltas) from object ids present in the odb.
export function writePack(odb: ObjectDB, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(oids.length, 8);
  parts.push(head);
  for (const oid of oids) {
    const o = odb.read(oid)!;
    const t = TYPES.indexOf(o.type);
    let size = o.body.length;
    const hdr: number[] = [(t << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      hdr[hdr.length - 1] |= 0x80;
      hdr.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Buffer.from(hdr), deflateSync(o.body, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
