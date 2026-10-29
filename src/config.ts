// Config file parsing (INI dialect) and lookup.
// Evidence: rea-evidence/findings/04-refs-porcelain.md §1 (init writes [core]
// repositoryformatversion/filemode/bare/logallrefupdates/symlinks/ignorecase);
// 01-dispatcher.md §H (config consulted during setup: core.bare, core.worktree,
// safe.directory). Sources read: GIT_CONFIG_GLOBAL or ~/.gitconfig and
// $XDG_CONFIG_HOME/git/config, then <gitdir>/config, then -c overrides.
// The system config is NOT read (see README "Known differences").
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { XDG_DIR, CONFIG_FILE } from "./brand.ts";

export type ConfigMap = Map<string, string[]>;

export function parseConfig(text: string, into: ConfigMap = new Map()): ConfigMap {
  let section = "";
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/);
    if (sec) {
      section = sec[1].toLowerCase() + (sec[2] !== undefined ? "." + sec[2].replace(/\\(.)/g, "$1") : "");
      line = sec[3].trim();
      if (!line) continue;
    }
    const kv = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
    if (!kv) continue;
    const key = `${section}.${kv[1].toLowerCase()}`;
    const value = kv[2] === undefined ? "true" : unquote(kv[2]);
    (into.get(key) ?? into.set(key, []).get(key)!).push(value);
  }
  return into;
}

function unquote(v: string): string {
  let out = "", q = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"') q = !q;
    else if (c === "\\" && i + 1 < v.length) {
      const n = v[++i];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
    } else if (!q && (c === "#" || c === ";")) break;
    else out += c;
  }
  return q ? out : out.replace(/\s+$/, "");
}

export class Config {
  map: ConfigMap = new Map();

  static load(gitDir: string | null, overrides: string[]): Config {
    const c = new Config();
    const env = process.env;
    const home = env.HOME ?? homedir();
    const xdg = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, XDG_DIR, "config") : join(home, ".config", XDG_DIR, "config");
    const files = env.PKB_CONFIG_GLOBAL !== undefined ? [env.PKB_CONFIG_GLOBAL] : [xdg, join(home, CONFIG_FILE)];
    if (gitDir) files.push(join(gitDir, "config"));
    for (const f of files) if (f && existsSync(f)) parseConfig(readFileSync(f, "utf8"), c.map);
    for (const o of overrides) {
      const eq = o.indexOf("=");
      const k = (eq < 0 ? o : o.slice(0, eq));
      const dot = k.lastIndexOf(".");
      const first = k.indexOf(".");
      const key = (k.slice(0, first).toLowerCase() + k.slice(first, dot) + k.slice(dot).toLowerCase());
      (c.map.get(key) ?? c.map.set(key, []).get(key)!).push(eq < 0 ? "true" : o.slice(eq + 1));
    }
    return c;
  }

  get(key: string): string | undefined {
    const v = this.map.get(normKey(key));
    return v ? v[v.length - 1] : undefined;
  }

  bool(key: string, dflt: boolean): boolean {
    const v = this.get(key);
    if (v === undefined) return dflt;
    return ["true", "yes", "on", "1"].includes(v.toLowerCase()) || (/^\d+$/.test(v) && v !== "0");
  }

  int(key: string, dflt: number): number {
    const v = this.get(key);
    return v === undefined || !/^-?\d+$/.test(v) ? dflt : Number(v);
  }
}

function normKey(k: string): string {
  const first = k.indexOf("."), last = k.lastIndexOf(".");
  return k.slice(0, first).toLowerCase() + k.slice(first, last) + k.slice(last).toLowerCase();
}

// ---- writing <repo>/config -------------------------------------------------------------
// Layout observed in fixtures/net-*: '[remote "origin"]' headers, keys as "\t<key> = <value>",
// new keys appended to the end of their section, new sections appended to the file.
function sectionHeader(section: string, sub: string | null): string {
  return sub === null ? `[${section}]` : `[${section} "${sub.replace(/["\\]/g, "\\$&")}"]`;
}

function splitKey(key: string): { section: string; sub: string | null; name: string } {
  const first = key.indexOf("."), last = key.lastIndexOf(".");
  return { section: key.slice(0, first).toLowerCase(), sub: first === last ? null : key.slice(first + 1, last), name: key.slice(last + 1) };
}

function quoteValue(v: string): string {
  return /^\s|\s$|[#;"\\]/.test(v) ? `"${v.replace(/["\\]/g, "\\$&")}"` : v;
}

// Line range of a section: [headerIndex, endIndexExclusive], or null.
function findSection(lines: string[], section: string, sub: string | null): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (m && m[1].toLowerCase() === section && (m[2] === undefined ? null : m[2].replace(/\\(.)/g, "$1")) === sub) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
      return [i, j];
    }
  }
  return null;
}

export function configSet(file: string, cfg: Config, key: string, value: string): void {
  const { section, sub, name } = splitKey(key);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const entry = `\t${name} = ${quoteValue(value)}`;
  const sec = findSection(lines, section, sub);
  if (!sec) lines.push(sectionHeader(section, sub), entry);
  else {
    const k = lines.slice(sec[0] + 1, sec[1]).findIndex((l) => l.trim().split(/\s*=/)[0].toLowerCase() === name.toLowerCase());
    if (k >= 0) lines[sec[0] + 1 + k] = entry;
    else {
      let end = sec[1];
      while (end > sec[0] + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, entry);
    }
  }
  writeFileSync(file, lines.join("\n") + "\n");
  cfg.map.set(normKey(key), [value]);
}

// Remove every value of `key`; a section left empty disappears (fixture config-cmd).
// Returns false when the key was not set.
export function configUnset(file: string, cfg: Config | null, key: string): boolean {
  if (!existsSync(file)) return false;
  const { section, sub, name } = splitKey(key);
  const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  const sec = findSection(lines, section, sub);
  if (!sec) return false;
  const keep: string[] = [];
  let removed = false;
  for (let i = sec[0] + 1; i < sec[1]; i++) {
    if (lines[i].trim().split(/\s*=/)[0].toLowerCase() === name.toLowerCase()) removed = true;
    else keep.push(lines[i]);
  }
  if (!removed) return false;
  const rest = keep.filter((l) => l.trim() && !/^\s*[#;]/.test(l));
  lines.splice(sec[0], sec[1] - sec[0], ...(rest.length ? [lines[sec[0]], ...keep] : []));
  writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
  cfg?.map.delete(normKey(key));
  return true;
}

// Entries of one config file in file order, keys normalised like "git config --list".
export function configEntries(file: string): [string, string][] {
  if (!existsSync(file)) return [];
  const out: [string, string][] = [];
  const m = new Map<string, string[]>();
  let section = "";
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    m.clear();
    let line = raw.trim();
    const sec = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/);
    if (sec) {
      section = sec[1].toLowerCase() + (sec[2] !== undefined ? "." + sec[2].replace(/\\(.)/g, "$1") : "");
      line = sec[3].trim();
    }
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    parseConfig(`[x]\n${line}`, m);
    for (const [k, v] of m) out.push([`${section}.${k.slice(2)}`, v[v.length - 1]]);
  }
  return out;
}

// Rename (or copy) a whole [section "sub"] block, e.g. branch settings on "branch -m/-c".
export function configRenameSection(file: string, cfg: Config, section: string, from: string, to: string, copy: boolean): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  const sec = findSection(lines, section.toLowerCase(), from);
  if (!sec) return;
  const body = lines.slice(sec[0] + 1, sec[1]);
  const block = [sectionHeader(section.toLowerCase(), to), ...body];
  if (copy) lines.push(...block);
  else lines.splice(sec[0], sec[1] - sec[0], ...block);
  writeFileSync(file, lines.join("\n") + "\n");
  const pre = `${section.toLowerCase()}.${from}.`;
  for (const [k, v] of [...cfg.map]) {
    if (!k.startsWith(pre)) continue;
    cfg.map.set(`${section.toLowerCase()}.${to}.${k.slice(pre.length)}`, v);
    if (!copy) cfg.map.delete(k);
  }
}

export function configRemoveSection(file: string, cfg: Config, section: string, sub: string): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  const sec = findSection(lines, section.toLowerCase(), sub);
  if (!sec) return;
  lines.splice(sec[0], sec[1] - sec[0]);
  writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
  const prefix = `${section.toLowerCase()}.${sub}.`;
  for (const k of [...cfg.map.keys()]) if (k.startsWith(prefix)) cfg.map.delete(k);
}

