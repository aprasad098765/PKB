// git diff
// Evidence (rea-evidence/findings/04-refs-porcelain.md §8): cmd_diff 0x14003f850 with option
//  bits 0x20 (NO_PARSEOPT: does its own setup and argument parsing, and outside a repository
//  falls back to --no-index); modes: index↔work tree, --cached/--staged (HEAD↔index),
//  <commit> (commit↔work tree), <a> <b> / a..b (tree↔tree); --exit-code / --quiet.
// Observed (fixtures diff-*, cli-not-a-repo, usage-texts): "error: invalid option: %s" +
//  usage (129) for unknown options; outside a repo the --no-index usage is printed;
//  paths are always repo-relative; renames detected by default (exact renames here).
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { discover } from "../repo.ts";
import type { Globals, Repo } from "../repo.ts";
import { Index } from "../dircache.ts";
import { head } from "../refs.ts";
import { resolveRev, peel } from "../revparse.ts";
import { parseCommit } from "../objects.ts";
import { flattenTree, entryClean, readWorkFile, modeForFile } from "../worktree.ts";
import { hashObject } from "../odb.ts";
import { treePairs, detectRenames, patchFor, statLines, shortStat, quotePath, unifiedHunks } from "../diff.ts";
import type { FilePair } from "../diff.ts";
import { USAGE, DIFF_NO_INDEX_USAGE } from "../usage-text.ts";
import { err, out, GitExit } from "../output.ts";
import { makePathspecs, matchPathspec } from "../util.ts";
import { ambiguous } from "./log.ts";

interface DiffOpts {
  ctx: number;
  cached: boolean;
  exitCode: boolean;
  quiet: boolean;
  noIndex: boolean;
  format: "patch" | "stat" | "name-only" | "name-status" | "shortstat";
  args: string[];
  paths: string[] | null;
}

function parseDiffArgs(argv: string[], inRepo: boolean): DiffOpts {
  const o: DiffOpts = { ctx: 3, cached: false, exitCode: false, quiet: false, noIndex: false, format: "patch", args: [], paths: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let m: RegExpMatchArray | null;
    if (a === "--") {
      o.paths = argv.slice(i + 1);
      break;
    } else if (a === "--cached" || a === "--staged") {
      if (!inRepo) bad("--cached", false);
      o.cached = true;
    } else if ((m = a.match(/^-U(\d+)$/)) || (m = a.match(/^--unified=(\d+)$/))) o.ctx = Number(m[1]);
    else if (a === "-U" || a === "--unified") o.ctx = Number(argv[++i]);
    else if (a === "--exit-code") o.exitCode = true;
    else if (a === "--quiet") o.quiet = o.exitCode = true;
    else if (a === "--no-index") o.noIndex = true;
    else if (a === "-p" || a === "-u" || a === "--patch") o.format = "patch";
    else if (a === "--stat") o.format = "stat";
    else if (a === "--shortstat") o.format = "shortstat";
    else if (a === "--name-only") o.format = "name-only";
    else if (a === "--name-status") o.format = "name-status";
    else if (a === "--no-color" || a === "--no-ext-diff" || a === "--no-renames" || a === "-M") continue;
    else if (a.startsWith("-") && a !== "-") bad(a, inRepo);
    else o.args.push(a);
  }
  return o;
}

function bad(a: string, inRepo: boolean): never {
  if (inRepo) {
    err(`error: invalid option: ${a}\n`);
    err(USAGE.diff);
  } else {
    err(`error: unknown option \`${a.replace(/^--?/, "")}'\n`);
    err(DIFF_NO_INDEX_USAGE);
  }
  throw new GitExit(129);
}

function emit(repo: Repo | null, pairs: FilePair[], o: DiffOpts): number {
  if (o.quiet) return pairs.length ? 1 : 0;
  const stats = [];
  for (const p of pairs) {
    if (o.format === "name-only") out(quotePath((p.b ?? p.a)!.path) + "\n");
    else if (o.format === "name-status") out(`${p.rename ? "R100" : !p.a ? "A" : !p.b ? "D" : "M"}\t${p.rename ? quotePath(p.a!.path) + "\t" : ""}${quotePath((p.b ?? p.a)!.path)}\n`);
    else {
      const r = patchFor(repo!, p, o.ctx);
      if (o.format === "patch") out(r.text);
      stats.push(r.stat);
    }
  }
  if (o.format === "stat" && stats.length) out(statLines(stats) + shortStat(stats));
  if (o.format === "shortstat" && stats.length) out(shortStat(stats));
  return o.exitCode && pairs.length ? 1 : 0;
}

function noIndexDiff(o: DiffOpts): number {
  const [a, b] = o.args;
  const ra = readFileSync(resolve(a)), rb = readFileSync(resolve(b));
  if (ra.equals(rb)) return 0;
  const u = unifiedHunks(ra, rb, o.ctx);
  const ha = hashObject("blob", ra).oid.slice(0, 7), hb = hashObject("blob", rb).oid.slice(0, 7);
  if (!o.quiet) out(Buffer.concat([Buffer.from(`diff --git a/${a} b/${b}\nindex ${ha}..${hb} 100644\n--- a/${a}\n+++ b/${b}\n`), Buffer.from(u.text, "latin1")]));
  return 1;
}

export function cmdDiff(argv: string[], _r: Repo | null, g: Globals): number {
  if (argv.length === 1 && argv[0] === "-h") {
    err(USAGE.diff);
    return 129;
  }
  const repo = discover(g);
  const o = parseDiffArgs(argv, !!repo);
  if (!repo || o.noIndex) {
    if (o.args.length !== 2) {
      err(DIFF_NO_INDEX_USAGE);
      return 129;
    }
    return noIndexDiff(o);
  }
  // split revisions from paths
  const revs: string[] = [];
  let paths = o.paths ?? [];
  for (let i = 0; i < o.args.length; i++) {
    const a = o.args[i];
    const parts = a.includes("..") ? a.split(/\.\.\.?/) : [a];
    const ok = parts.every((x) => resolveRev(repo, x || "HEAD"));
    if (ok) {
      if (parts.length === 2) revs.push(parts[0] || "HEAD", parts[1] || "HEAD");
      else revs.push(a);
      continue;
    }
    if (o.paths === null && repo.workTree && existsSync(join(repo.workTree, repo.prefix, a))) {
      paths = o.args.slice(i);
      break;
    }
    ambiguous(a);
  }
  const specs = makePathspecs(repo.prefix, paths);
  const inSpec = (p: string) => !specs.length || specs.some((s) => matchPathspec(s, p));
  const treeOf = (rev: string) => peel(repo, resolveRev(repo, rev)!, "tree");
  const idxMap = (ix: Index) => new Map(ix.entries.map((e) => [e.path, { oid: e.oid, mode: e.mode.toString(8).padStart(6, "0") }]));
  let pairs: FilePair[];
  if (revs.length >= 2) {
    pairs = detectRenames(treePairs(flattenTree(repo, treeOf(revs[0])), flattenTree(repo, treeOf(revs[revs.length - 1]))));
  } else if (o.cached) {
    const base = revs[0] ? treeOf(revs[0]) : head(repo).oid ? parseCommit(repo.odb.read(head(repo).oid!)!.body).tree : null;
    pairs = detectRenames(treePairs(flattenTree(repo, base), idxMap(Index.read(repo.path("index")))));
  } else {
    repo.wt();
    const ix = Index.read(repo.path("index"));
    // work-tree side keyed by path; content loaded lazily
    const work = new Map<string, { oid: string; mode: string; data?: Buffer }>();
    const workSide = (path: string) => {
      const full = join(repo.wt(), path);
      if (!existsSync(full) || lstatSync(full).isDirectory()) return null;
      const data = readWorkFile(repo, path);
      return { oid: hashObject("blob", data).oid, mode: modeForFile(repo, path, ix.find(path)?.mode).toString(8), data };
    };
    if (revs.length === 1) {
      const t = flattenTree(repo, treeOf(revs[0]));
      for (const e of ix.entries) {
        const w = workSide(e.path);
        if (w) work.set(e.path, w);
      }
      pairs = treePairs(t, work);
      for (const p of pairs) if (p.b) p.b.data = work.get(p.b.path)!.data;
      pairs = detectRenames(pairs);
    } else {
      pairs = [];
      for (const e of ix.entries) {
        const st = entryClean(repo, ix, e);
        if (st === "clean") continue;
        const a = { path: e.path, oid: e.oid, mode: e.mode.toString(8) };
        const w = st === "deleted" ? null : workSide(e.path);
        if (w && w.oid === e.oid && w.mode === a.mode) continue;
        pairs.push({ a, b: w ? { path: e.path, oid: w.oid, mode: w.mode, data: w.data } : null });
      }
    }
  }
  pairs = pairs.filter((p) => inSpec((p.b ?? p.a)!.path) || (p.a && inSpec(p.a.path)));
  return emit(repo, pairs, o);
}
