// Tree and commit object encoding.
// Evidence (rea-evidence/findings/02-objects.md):
//  §4 tree entries "%o %.*s%c" + raw 20-byte hash (so directories serialize as "40000");
//     entries ordered by name with directories compared as if suffixed by '/'
//     (fsck tree-order check 0x14018f260). Fixture: tree-ordering, write-tree-nested.
//  §5 commit_tree 0x140138f90: "tree", "parent"*, "author", "committer",
//     optional "encoding" (only when not UTF-8), blank line, message.
//  cat-file -p tree format "%06o %s %s\t%s" — fixture cat-file.

export interface TreeEntry {
  mode: string; // octal, as stored ("100644", "40000", ...)
  name: string;
  oid: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let p = 0;
  while (p < body.length) {
    const sp = body.indexOf(0x20, p);
    const nul = body.indexOf(0, sp);
    out.push({ mode: body.toString("latin1", p, sp), name: body.toString("utf8", sp + 1, nul), oid: body.toString("hex", nul + 1, nul + 21) });
    p = nul + 21;
  }
  return out;
}

const sortKey = (e: TreeEntry) => Buffer.from(isTreeMode(e.mode) ? e.name + "/" : e.name, "utf8");

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode.replace(/^0+/, "")} ${e.name}\0`, "utf8"), Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string; // "Name <email> epoch tz"
  committer: string;
  encoding?: string;
  message: string;
  extraHeaders: string[];
}

export function parseCommit(body: Buffer): Commit {
  const s = body.toString("utf8");
  const split = s.indexOf("\n\n");
  const head = split < 0 ? s : s.slice(0, split);
  const message = split < 0 ? "" : s.slice(split + 2);
  const c: Commit = { tree: "", parents: [], author: "", committer: "", message, extraHeaders: [] };
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    const k = line.slice(0, sp), v = line.slice(sp + 1);
    if (k === "tree") c.tree = v;
    else if (k === "parent") c.parents.push(v);
    else if (k === "author") c.author = v;
    else if (k === "committer") c.committer = v;
    else if (k === "encoding") c.encoding = v;
    else c.extraHeaders.push(line);
  }
  return c;
}

export function serializeCommit(c: Commit): Buffer {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n`;
  if (c.encoding && c.encoding.toLowerCase() !== "utf-8") s += `encoding ${c.encoding}\n`;
  return Buffer.from(s + "\n" + c.message, "utf8");
}

// "Name <email> 1700000000 +0530" -> parts
export function parseIdent(id: string): { name: string; email: string; time: number; tz: string } {
  const m = id.match(/^(.*?) <(.*)> (-?\d+) ([+-]\d{4})$/);
  if (!m) return { name: id, email: "", time: 0, tz: "+0000" };
  return { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] };
}

// Subject = first paragraph joined with spaces (log --oneline, commit summary, reflog).
export function subjectOf(message: string): string {
  const lines = message.replace(/^\n+/, "").split("\n");
  const para: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") break;
    para.push(l.trimEnd());
  }
  return para.join(" ");
}
