// git log
// Evidence (rea-evidence/findings/04-refs-porcelain.md §7): cmd_log 0x140079af0 (RUN_SETUP);
//  default "medium" format: "commit %s", "Merge: %s %s", "Author: %s <%s>", "Date:   %s",
//  blank line, message indented by 4 spaces; --oneline "%h %s"; commits ordered by date.
// Observed (fixtures log-*): no decorations when stdout is not a terminal; unborn branch →
//  "your current branch '%s' does not have any commits yet" (128); unknown revision →
//  the "ambiguous argument" fatal with its two-line hint.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { head, shortRef } from "../refs.ts";
import { resolveCommit } from "../revparse.ts";
import { parseCommit, parseIdent, subjectOf } from "../objects.ts";
import type { Commit } from "../objects.ts";
import { formatDefaultDate } from "../ident.ts";
import { die, err, out, GitExit } from "../output.ts";
import { makePathspecs, matchPathspec } from "../util.ts";
import { flattenTree } from "../worktree.ts";

export function ambiguous(arg: string): never {
  die(`ambiguous argument '${arg}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'pkb <command> [<revision>...] -- [<file>...]'`);
}

function formatCustom(repo: Repo, fmt: string, oid: string, c: Commit): string {
  const a = parseIdent(c.author), cm = parseIdent(c.committer);
  const body = c.message.split("\n\n").slice(1).join("\n\n");
  return fmt.replace(/%(H|h|T|t|P|p|an|ae|ad|at|cn|ce|cd|ct|s|b|B|n|%)/g, (_, k) => {
    switch (k) {
      case "H": return oid;
      case "h": return repo.odb.abbrev(oid);
      case "T": return c.tree;
      case "t": return repo.odb.abbrev(c.tree);
      case "P": return c.parents.join(" ");
      case "p": return c.parents.map((x) => repo.odb.abbrev(x)).join(" ");
      case "an": return a.name;
      case "ae": return a.email;
      case "ad": return formatDefaultDate(a.time, a.tz);
      case "at": return String(a.time);
      case "cn": return cm.name;
      case "ce": return cm.email;
      case "cd": return formatDefaultDate(cm.time, cm.tz);
      case "ct": return String(cm.time);
      case "s": return subjectOf(c.message);
      case "b": return body;
      case "B": return c.message;
      case "n": return "\n";
      default: return "%";
    }
  });
}

export function cmdLog(argv: string[], repo: Repo): number {
  // revision options are parsed by the revision machinery, not parse-options (fixture ho-errors)
  if (argv[argv.length - 1] === "-n") {
    err("error: -n requires an argument\n");
    throw new GitExit(128);
  }
  const p = parseOptions("log", argv, [
    { long: "oneline", key: "oneline" },
    { short: "n", long: "max-count", arg: "required", key: "n", num: true },
    { long: "pretty", arg: "optional", key: "pretty" },
    { long: "format", arg: "required", key: "format" },
    { long: "reverse", key: "reverse" },
    { long: "no-decorate", key: "noDecorate" },
    { long: "decorate", arg: "optional", key: "decorate" },
    { long: "first-parent", key: "firstParent" },
  ]);
  const max = p.opts.n !== undefined ? Number(p.opts.n) : Infinity;
  let pretty: string = p.opts.oneline ? "oneline" : "medium";
  if (typeof p.opts.pretty === "string") pretty = p.opts.pretty;
  if (p.opts.format) pretty = "tformat:" + p.opts.format;

  const include: string[] = [], exclude: string[] = [];
  const revArgs = p.dashdash >= 0 ? p.args.slice(0, p.dashdash) : p.args;
  let paths = p.dashdash >= 0 ? p.args.slice(p.dashdash) : [];
  for (let i = 0; i < revArgs.length; i++) {
    const a = revArgs[i];
    const range = a.match(/^(.*?)\.\.(.*)$/);
    const add = (spec: string, into: string[]) => {
      const o = resolveCommit(repo, spec || "HEAD");
      if (!o) {
        if (p.dashdash < 0 && repo.workTree && existsSync(join(repo.workTree, repo.prefix, a))) {
          paths = revArgs.slice(i);
          return false;
        }
        ambiguous(a);
      }
      into.push(o);
      return true;
    };
    if (range && !a.includes("...")) {
      if (!add(range[1], exclude)) break;
      add(range[2], include);
    } else if (a.startsWith("^")) add(a.slice(1), exclude);
    else if (!add(a, include)) break;
  }
  if (!include.length) {
    const h = head(repo);
    if (!h.oid) {
      if (h.symref) die(`your current branch '${shortRef(h.symref)}' does not have any commits yet`);
      die("bad default revision 'HEAD'");
    }
    include.push(h.oid);
  }
  const specs = makePathspecs(repo.prefix, paths);

  // exclusion set: everything reachable from excluded commits
  const hidden = new Set<string>();
  const stack = [...exclude];
  while (stack.length) {
    const o = stack.pop()!;
    if (hidden.has(o)) continue;
    hidden.add(o);
    stack.push(...parseCommit(repo.odb.read(o)!.body).parents);
  }
  const commits = new Map<string, Commit>();
  const load = (o: string) => {
    let c = commits.get(o);
    if (!c) commits.set(o, (c = parseCommit(repo.odb.read(o)!.body)));
    return c;
  };
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const o of include) if (!seen.has(o) && !hidden.has(o)) { seen.add(o); queue.push(o); }
  const result: string[] = [];
  const touches = (o: string, c: Commit) => {
    if (!specs.length) return true;
    const mine = flattenTree(repo, c.tree);
    const parent = c.parents[0] ? flattenTree(repo, load(c.parents[0]).tree) : new Map();
    for (const path of new Set([...mine.keys(), ...parent.keys()])) {
      if (!specs.some((s) => matchPathspec(s, path))) continue;
      if (mine.get(path)?.oid !== parent.get(path)?.oid) return true;
    }

    return false;
  };
  while (queue.length && result.length < max) {
    // pick the newest committer date (ties: earliest inserted)
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (parseIdent(load(queue[i]).committer).time > parseIdent(load(queue[bi]).committer).time) bi = i;
    const o = queue.splice(bi, 1)[0];
    const c = load(o);
    if (touches(o, c)) result.push(o);
    const ps = p.opts.firstParent ? c.parents.slice(0, 1) : c.parents;
    for (const par of ps) if (!seen.has(par) && !hidden.has(par)) { seen.add(par); queue.push(par); }
  }
  if (p.opts.reverse) result.reverse();

  let first = true;
  for (const o of result) {
    const c = load(o);
    if (pretty === "oneline") out(`${repo.odb.abbrev(o)} ${subjectOf(c.message)}\n`);
    else if (pretty.startsWith("tformat:") || pretty.startsWith("format:")) {
      const fmt = pretty.slice(pretty.indexOf(":") + 1);
      if (pretty.startsWith("format:") && !first) out("\n");
      out(formatCustom(repo, fmt, o, c) + (pretty.startsWith("tformat:") ? "\n" : ""));
    } else {
      if (!first) out("\n");
      const a = parseIdent(c.author), cm = parseIdent(c.committer);
      let s = `commit ${o}\n`;
      if (c.parents.length > 1) s += `Merge: ${c.parents.map((x) => repo.odb.abbrev(x)).join(" ")}\n`;
      s += `Author: ${a.name} <${a.email}>\n`;
      if (pretty === "full" || pretty === "fuller") s += `Commit: ${cm.name} <${cm.email}>\n`;
      if (pretty === "medium") s += `Date:   ${formatDefaultDate(a.time, a.tz)}\n`;
      const msgLines = c.message.replace(/\n+$/, "").split("\n");
      const shown = pretty === "short" ? [subjectOf(c.message)] : msgLines;
      s += "\n" + shown.map((l) => "    " + l).join("\n") + "\n";
      out(s);
    }
    first = false;
  }
  return 0;
}
