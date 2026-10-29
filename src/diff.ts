// Line diff, unified patch output, diffstat and summary.
// Evidence (rea-evidence/findings/04-refs-porcelain.md §8): diff builtin 0x14003f850;
//  header strings "diff --git %s %s", "index %s..%s %06o", "new file mode %06o",
//  "deleted file mode %06o", "--- %s", "+++ %s", "/dev/null", default context 3,
//  "\ No newline at end of file", "Binary files %s and %s differ".
// Observed (fixtures diff-*, merge-ff, commit-*):
//  hunk header "@@ -a[,b] +c[,d] @@[ func]" (",1" omitted; empty side prints the line
//  before it with ",0"); func = nearest earlier line of the old file starting with a letter,
//  '_' or '$'; changes closer than 2*context share a hunk; ambiguous change groups end at
//  the lowest position (diff-move-lines); diffstat " <name> | <n> <+++-->" and
//  " N file(s) changed, X insertion(s)(+), Y deletion(s)(-)"; " create mode", " delete mode".
// The algorithm is Myers' O(ND) greedy LCS followed by group sliding.
import type { Repo } from "./repo.ts";

export interface Side {
  path: string;
  oid: string;
  mode: string; // "100644" etc.
  data?: Buffer; // filled lazily
}
export interface FilePair {
  a: Side | null; // old (null = added)
  b: Side | null; // new (null = deleted)
  rename?: boolean;
}

const ZERO = "0".repeat(40);

export function splitLines(buf: Buffer): string[] {
  const s = buf.toString("latin1");
  const out: string[] = [];
  let p = 0;
  while (p < s.length) {
    const nl = s.indexOf("\n", p);
    if (nl < 0) {
      out.push(s.slice(p));
      break;
    }
    out.push(s.slice(p, nl + 1));
    p = nl + 1;
  }
  return out;
}

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

// Returns per-line change flags for a and b.
export function diffLines(a: string[], b: string[]): { ca: boolean[]; cb: boolean[] } {
  const ca = new Array<boolean>(a.length).fill(false);
  const cb = new Array<boolean>(b.length).fill(false);
  // intern lines to ints
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const A = a.map(id), B = b.map(id);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a0 = A.slice(pre, A.length - suf), b0 = B.slice(pre, B.length - suf);
  const n = a0.length, m = b0.length;
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) ca[pre + i] = true;
    for (let j = 0; j < m; j++) cb[pre + j] = true;
  } else {
    const max = n + m, off = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a0[x] === b0[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
    }
    // backtrack
    // trace[d] holds V as it was before step d; walk back from (n, m) one edit per step.
    let x = n, y = m;
    for (let d = trace.length - 1; d > 0; d--) {
      const vv = trace[d];
      const k = x - y;
      const down = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]);
      const pk = down ? k + 1 : k - 1;
      const px = vv[off + pk], py = px - pk;
      const sx = down ? px : px + 1; // start of this step's snake
      while (x > sx) {
        x--;
        y--;
      }
      if (down) cb[pre + py] = true;
      else ca[pre + px] = true;
      x = px;
      y = py;
    }
  }
  compact(A, ca);
  compact(B, cb);
  return { ca, cb };
}

// Slide each run of changed lines up as far as possible and then down as far as possible,
// merging with neighbouring runs; the run ends at its lowest position.
function compact(L: number[], ch: boolean[]): void {
  const n = L.length;
  let s = 0;
  while (s < n) {
    if (!ch[s]) {
      s++;
      continue;
    }
    let e = s;
    while (e < n && ch[e]) e++;
    let prevEnd = -1;
    for (;;) {
      // up
      while (s > 0 && !ch[s - 1] && L[s - 1] === L[e - 1]) {
        ch[--s] = true;
        ch[--e] = false;
        while (s > 0 && ch[s - 1]) s--;
      }
      // down
      while (e < n && !ch[e] && L[s] === L[e]) {
        ch[s++] = false;
        ch[e++] = true;
        while (e < n && ch[e]) e++;
      }
      if (e === prevEnd) break;
      prevEnd = e;
    }
    s = e;
  }
}

interface Change {
  i1: number; n1: number; i2: number; n2: number;
}

function changes(ca: boolean[], cb: boolean[]): Change[] {
  const out: Change[] = [];
  let i = 0, j = 0;
  while (i < ca.length || j < cb.length) {
    if ((i < ca.length && ca[i]) || (j < cb.length && cb[j])) {
      const c: Change = { i1: i, n1: 0, i2: j, n2: 0 };
      while (i < ca.length && ca[i]) { i++; c.n1++; }
      while (j < cb.length && cb[j]) { j++; c.n2++; }
      out.push(c);
    } else {
      i++;
      j++;
    }
  }
  return out;
}

function funcName(a: string[], before: number): string {
  for (let i = before - 1; i >= 0; i--) {
    const l = a[i];
    if (/^[A-Za-z_$]/.test(l)) {
      let s = l.replace(/[\r\n]+$/, "");
      if (s.length > 80) s = s.slice(0, 80);
      return s.replace(/\s+$/, "");
    }
  }
  return "";
}

const range = (start: number, count: number) => (count === 1 ? `${start + 1}` : count === 0 ? `${start},0` : `${start + 1},${count}`);

// Unified hunks for two buffers (latin1 strings in, latin1 string out).
export function unifiedHunks(abuf: Buffer, bbuf: Buffer, ctx: number): { text: string; ins: number; del: number } {
  const a = splitLines(abuf), b = splitLines(bbuf);
  const { ca, cb } = diffLines(a, b);
  const ch = changes(ca, cb);
  let ins = 0, del = 0;
  for (const c of ch) {
    ins += c.n2;
    del += c.n1;
  }
  let text = "";
  let k = 0;
  const line = (prefix: string, l: string) => {
    text += prefix + l;
    if (!l.endsWith("\n")) text += "\n\\ No newline at end of file\n";
  };
  while (k < ch.length) {
    let last = k;
    while (last + 1 < ch.length && ch[last + 1].i1 - (ch[last].i1 + ch[last].n1) <= 2 * ctx) last++;
    const first = ch[k], lc = ch[last];
    const s1 = Math.max(0, first.i1 - ctx);
    const e1 = Math.min(a.length, lc.i1 + lc.n1 + ctx);
    const s2 = first.i2 - (first.i1 - s1);
    const e2 = lc.i2 + lc.n2 + (e1 - (lc.i1 + lc.n1));
    const fn = funcName(a, s1);
    text += `@@ -${range(s1, e1 - s1)} +${range(s2, e2 - s2)} @@${fn ? " " + fn : ""}\n`;
    let i = s1;
    for (let c = k; c <= last; c++) {
      const cc = ch[c];
      for (; i < cc.i1; i++) line(" ", a[i]);
      for (let x = 0; x < cc.n1; x++) line("-", a[cc.i1 + x]);
      for (let x = 0; x < cc.n2; x++) line("+", b[cc.i2 + x]);
      i = cc.i1 + cc.n1;
    }
    for (; i < e1; i++) line(" ", a[i]);
    k = last + 1;
  }
  return { text, ins, del };
}

// C-style quoting used for paths with special characters (core.quotePath=true).
// Short status also quotes names containing a space (fixture ho-unicode-paths).
export function quotePath(p: string, quoteSpace = false): string {
  const bytes = Buffer.from(p, "utf8");
  let needs = false, s = "";
  for (const c of bytes) {
    if (quoteSpace && c === 0x20) needs = true;
    if (c === 0x22 || c === 0x5c) { needs = true; s += "\\" + String.fromCharCode(c); }
    else if (c === 0x09) { needs = true; s += "\\t"; }
    else if (c === 0x0a) { needs = true; s += "\\n"; }
    else if (c < 0x20 || c >= 0x7f) { needs = true; s += "\\" + c.toString(8).padStart(3, "0"); }
    else s += String.fromCharCode(c);
  }
  return needs ? `"${s}"` : p;
}
const qp = (prefix: string, p: string) => {
  const q = quotePath(p);
  return q.startsWith('"') ? `"${prefix}${q.slice(1)}` : prefix + p;
};

export interface StatLine {
  name: string;
  ins: number;
  del: number;
  binary?: { a: number; b: number };
}

export function loadData(repo: Repo, s: Side): Buffer {
  if (!s.data) {
    const o = s.oid === ZERO ? null : repo.odb.read(s.oid);
    s.data = o ? o.body : Buffer.alloc(0);
  }
  return s.data;
}

// Pair up exact renames (identical blob) among added/deleted files.
export function detectRenames(pairs: FilePair[]): FilePair[] {
  const dels = pairs.filter((p) => p.a && !p.b);
  const used = new Set<FilePair>();
  const out: FilePair[] = [];
  for (const p of pairs) {
    if (!p.a && p.b) {
      const src = dels.find((d) => !used.has(d) && d.a!.oid === p.b!.oid && d.a!.oid !== ZERO);
      if (src) {
        used.add(src);
        out.push({ a: src.a, b: p.b, rename: true });
        continue;
      }
    }
    out.push(p);
  }
  return out.filter((p) => !used.has(p)).sort((x, y) => Buffer.compare(Buffer.from((x.b ?? x.a)!.path), Buffer.from((y.b ?? y.a)!.path)));
}

// Full patch text for one pair, plus its stat line.
export function patchFor(repo: Repo, p: FilePair, ctx: number): { text: Buffer; stat: StatLine } {
  const aPath = (p.a ?? p.b)!.path, bPath = (p.b ?? p.a)!.path;
  let h = `diff --git ${qp("a/", aPath)} ${qp("b/", bPath)}\n`;
  const am = p.a?.mode, bm = p.b?.mode;
  if (!p.a) h += `new file mode ${bm}\n`;
  else if (!p.b) h += `deleted file mode ${am}\n`;
  else if (am !== bm) h += `old mode ${am}\nnew mode ${bm}\n`;
  if (p.rename) h += `similarity index 100%\nrename from ${quotePath(aPath)}\nrename to ${quotePath(bPath)}\n`;
  const name = p.rename ? renameDisplay(aPath, bPath) : quotePath(bPath);
  const stat: StatLine = { name, ins: 0, del: 0 };
  const aOid = p.a?.oid ?? ZERO, bOid = p.b?.oid ?? ZERO;
  if (aOid === bOid && !p.rename) return { text: Buffer.from(h, "utf8"), stat };
  if (p.rename && aOid === bOid) return { text: Buffer.from(h, "utf8"), stat };
  const ad = p.a ? loadData(repo, p.a) : Buffer.alloc(0);
  const bd = p.b ? loadData(repo, p.b) : Buffer.alloc(0);
  const ab = (o: string) => (o === ZERO ? "0000000" : repo.odb.abbrev(o));
  h += `index ${ab(aOid)}..${ab(bOid)}${p.a && p.b && am === bm ? " " + am : ""}\n`;
  const aName = p.a ? qp("a/", aPath) : "/dev/null";
  const bName = p.b ? qp("b/", bPath) : "/dev/null";
  if (isBinary(ad) || isBinary(bd)) {
    h += `Binary files ${aName} and ${bName} differ\n`;
    stat.binary = { a: ad.length, b: bd.length };
    return { text: Buffer.from(h, "utf8"), stat };
  }
  const u = unifiedHunks(ad, bd, ctx);
  stat.ins = u.ins;
  stat.del = u.del;
  const head = Buffer.from(h + `--- ${aName}\n+++ ${bName}\n`, "utf8");
  return { text: Buffer.concat([head, Buffer.from(u.text, "latin1")]), stat };
}

export function renameDisplay(a: string, b: string): string {
  // common directory prefix / suffix collapse: "dir/{a => b}/x"
  let pfx = 0;
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) if (a[i] === "/") pfx = i + 1;
  let sfx = 0;
  for (let i = 0; i < Math.min(a.length, b.length) - pfx && a[a.length - 1 - i] === b[b.length - 1 - i]; i++) if (a[a.length - 1 - i] === "/") sfx = i;
  if (pfx === 0 && sfx === 0) return `${a} => ${b}`;
  return `${a.slice(0, pfx)}{${a.slice(pfx, a.length - sfx)} => ${b.slice(pfx, b.length - sfx)}}${a.slice(a.length - sfx)}`;
}

export function statLines(stats: StatLine[], width = 80): string {
  if (!stats.length) return "";
  const nameW = Math.max(...stats.map((s) => s.name.length));
  const maxChange = Math.max(...stats.map((s) => s.ins + s.del));
  const numW = Math.max(String(maxChange).length, stats.some((s) => s.binary) ? 3 : 0);
  let name = nameW;
  let graph = width - (name + numW + 6);
  if (graph < 6) {
    graph = 6;
    name = width - numW - 12;
  }
  graph = Math.min(graph, 40 + Math.max(0, 0));
  const scale = (n: number) => (maxChange <= graph ? n : n === 0 ? 0 : 1 + Math.floor((n * (graph - 1)) / maxChange));
  let out = "";
  for (const s of stats) {
    let nm = s.name;
    if (nm.length > name) nm = "..." + nm.slice(nm.length - name + 3);
    nm = nm.padEnd(name);
    if (s.binary) {
      out += ` ${nm} | Bin ${s.binary.a} -> ${s.binary.b} bytes\n`;
      continue;
    }
    const total = s.ins + s.del;
    let add = s.ins, del = s.del;
    if (maxChange > graph) {
      const t = scale(total);
      add = scale(s.ins);
      del = t - add;
      if (del < 0) del = 0;
    }
    out += ` ${nm} | ${String(total).padStart(numW)}${total || add || del ? " " : ""}${"+".repeat(add)}${"-".repeat(del)}\n`;
  }
  return out;
}

export function shortStat(stats: StatLine[]): string {
  const files = stats.length;
  const ins = stats.reduce((a, s) => a + s.ins, 0), del = stats.reduce((a, s) => a + s.del, 0);
  let s = ` ${files} file${files === 1 ? "" : "s"} changed`;
  if (ins || !del) s += `, ${ins} insertion${ins === 1 ? "" : "s"}(+)`;
  if (del || !ins) s += `, ${del} deletion${del === 1 ? "" : "s"}(-)`;
  return s + "\n";
}

export function summaryLines(pairs: FilePair[]): string {
  let s = "";
  for (const p of pairs) {
    if (p.rename) s += ` rename ${renameDisplay(p.a!.path, p.b!.path)} (100%)\n`;
    else if (!p.a) s += ` create mode ${p.b!.mode} ${quotePath(p.b!.path)}\n`;
    else if (!p.b) s += ` delete mode ${p.a.mode} ${quotePath(p.a.path)}\n`;
    else if (p.a.mode !== p.b.mode) s += ` mode change ${p.a.mode} => ${p.b.mode} ${quotePath(p.b.path)}\n`;
  }
  return s;
}

// Compare two flat path maps and return the changed pairs (sorted by path).
export function treePairs(a: Map<string, { oid: string; mode: string }>, b: Map<string, { oid: string; mode: string }>): FilePair[] {
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  const out: FilePair[] = [];
  for (const p of paths) {
    const x = a.get(p), y = b.get(p);
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    if (x && y && (x.mode === "120000") !== (y.mode === "120000")) {
      out.push({ a: { path: p, ...x }, b: null }, { a: null, b: { path: p, ...y } });
      continue;
    }
    out.push({ a: x ? { path: p, ...x } : null, b: y ? { path: p, ...y } : null });
  }
  return out;
}
