// Decodes git.exe's builtin command table from the on-disk PE image.
// Evidence: REA read_bytes ev_c81e4bd2... (table @0x14032e000) and
// ev_827fba99... (name pool @0x140346700); xrefs ev_e1719a74... shows the
// "hash-object" string (0x1403469e8) is referenced only from .data 0x14032e528.
// Entry layout observed: {char *name; int (*fn)(); uint32 option; uint32 pad} = 24 bytes.
import { readFileSync, writeFileSync } from "node:fs";

const [exe, out] = process.argv.slice(2);
const buf = readFileSync(exe);
const pe = buf.readUInt32LE(0x3c);
const nsec = buf.readUInt16LE(pe + 6);
const optSize = buf.readUInt16LE(pe + 20);
const opt = pe + 24;
const imageBase = buf.readBigUInt64LE(opt + 24);
const sections = [];
for (let i = 0; i < nsec; i++) {
  const s = opt + optSize + i * 40;
  sections.push({
    name: buf.toString("latin1", s, s + 8).replace(/\0+$/, ""),
    va: buf.readUInt32LE(s + 12),
    vsize: buf.readUInt32LE(s + 8),
    raw: buf.readUInt32LE(s + 20),
    rawSize: buf.readUInt32LE(s + 16),
  });
}
const off = (va) => {
  const rva = Number(BigInt(va) - imageBase);
  const s = sections.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
  return s ? s.raw + (rva - s.va) : null;
};
const cstr = (va) => {
  const o = off(va);
  if (o == null) return null;
  const e = buf.indexOf(0, o);
  return buf.toString("latin1", o, e);
};

// Walk backwards/forwards from the known hash-object entry until entries stop
// pointing into .rdata name strings followed by .text handlers.
const text = sections.find((s) => s.name === ".text");
const isText = (va) => {
  const rva = Number(va - imageBase);
  return rva >= text.va && rva < text.va + text.vsize;
};
const entryAt = (va) => {
  const o = off(va);
  const name = buf.readBigUInt64LE(o), fn = buf.readBigUInt64LE(o + 8), opt = buf.readUInt32LE(o + 16);
  const s = isText(fn) ? cstr(name) : null;
  return s && /^[a-z][a-z0-9-]*$/.test(s) ? { va: "0x" + va.toString(16), name: s, fn: "0x" + fn.toString(16), option: opt } : null;
};
const anchor = 0x14032e528n;
let start = anchor;
while (entryAt(start - 24n)) start -= 24n;
const rows = [];
for (let va = start; ; va += 24n) {
  const e = entryAt(va);
  if (!e) break;
  rows.push(e);
}
writeFileSync(out, JSON.stringify({ exe, imageBase: "0x" + imageBase.toString(16), tableStart: "0x" + start.toString(16), count: rows.length, rows }, null, 2));
console.log(`table @0x${start.toString(16)}: ${rows.length} entries`);
for (const r of rows) console.log(`${r.va}  ${r.fn}  opt=0x${r.option.toString(16).padStart(2, "0")}  ${r.name}`);
