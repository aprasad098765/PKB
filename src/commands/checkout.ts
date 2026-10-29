// git checkout / git switch
// Evidence (rea-evidence/findings/04-refs-porcelain.md §5): cmd_checkout 0x140024090 and
//  cmd_switch 0x1400243b0 (both RUN_SETUP | NEED_WORK_TREE); branch switch = two-way tree
//  merge of HEAD→target over index and work tree; reflog "checkout: moving from %s to %s";
//  messages "Switched to branch '%s'", "Switched to a new branch '%s'", "Already on '%s'".
// Observed (fixtures checkout-*, switch-branches, detached-head):
//  - local-change / untracked-overwrite refusals with their exact paragraphs (exit 1);
//  - carried local changes listed on stdout as "M\t<path>";
//  - "error: pathspec '%s' did not match any file(s) known to git" (exit 1);
//  - path checkout prints "Updated %d path(s) from the index";
//  - detaching: checkout prints the "Note: switching to" advice, switch requires --detach
//    ("a branch is expected, got commit '%s'"), "HEAD is now at %h %s",
//    "Previous HEAD position was %h %s", and the "leaving N commit(s) behind" warning;
//  - "invalid reference: %s" (switch, 128).
import { existsSync, readFileSync } from "node:fs";
import type { Repo } from "../repo.ts";
import { Index } from "../dircache.ts";
import { parseOptions } from "../options.ts";
import { head, setHeadSymref, setHeadDetached, resolveRef, appendReflog, listRefs, shortRef } from "../refs.ts";
import { resolveCommit, peel } from "../revparse.ts";
import { parseCommit, subjectOf } from "../objects.ts";
import { flattenTree, entryClean, checkoutFile, removeWorkFile, writeTree, indexEntryFromTree } from "../worktree.ts";
import type { FlatEntry } from "../worktree.ts";
import { Excludes } from "../ignore.ts";
import { createBranch } from "./branch.ts";
import { trackingLong, uniqueRemoteBranch } from "../remote.ts";

// "checkout <name>" with no local branch <name> and no commit of that name, but exactly one
// remote-tracking branch <remote>/<name>: create <name> from it with upstream (git's DWIM).
function remoteBranchFor(repo: Repo, name: string): { start: string; oid: string } | null {
  if (resolveRef(repo, `refs/heads/${name}`)?.oid || resolveCommit(repo, name)) return null;
  const rb = uniqueRemoteBranch(repo, name);
  return rb ? { start: rb.ref, oid: resolveRef(repo, rb.ref)!.oid! } : null; // full ref: reflog says "Created from refs/remotes/origin/x"
}
import { die, err, out, exit, hint } from "../output.ts";
import { makePathspecs, matchPathspec } from "../util.ts";

const same = (a?: FlatEntry, b?: { oid: string; mode: number }) => !!a && !!b && a.oid === b.oid && parseInt(a.mode, 8) === b.mode;

// Two-way switch of index + work tree from tree `from` to tree `to`. Returns false (after
// printing the refusal) when local changes would be lost.
export function switchTrees(repo: Repo, ix: Index, from: string | null, to: string | null, op: "checkout" | "merge", force = false): boolean {
  const H = flattenTree(repo, from), T = flattenTree(repo, to);
  const paths = [...new Set([...H.keys(), ...T.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const local: string[] = [], untracked: string[] = [];
  const work: string[] = [];
  const ex = new Excludes(repo);
  for (const p of paths) {
    const h = H.get(p), t = T.get(p);
    if (h && t && h.oid === t.oid && h.mode === t.mode) continue;
    if (!h && !t) continue;
    work.push(p);
    if (force) continue;
    const e = ix.find(p);
    if (e) {
      if (t && same(t, e)) continue; // index already has the target
      if (!h || !same(h, e)) {
        local.push(p);
        continue;
      }
      const st = entryClean(repo, ix, e);
      if (st !== "clean") local.push(p);
    } else if (h) {
      if (t) local.push(p); // staged deletion of a file the target changes
    } else if (t && existsSync(repo.wt() + "/" + p) && !ex.isIgnored(p, false)) {
      untracked.push(p);
    }
  }
  if (local.length || untracked.length) {
    const tail = op === "checkout" ? "switch branches" : "merge";
    if (local.length) {
      err(`error: Your local changes to the following files would be overwritten by ${op}:\n${local.map((p) => `\t${p}\n`).join("")}Please commit your changes or stash them before you ${tail}.\n`);
    }
    if (untracked.length) {
      err(`error: The following untracked working tree files would be overwritten by ${op}:\n${untracked.map((p) => `\t${p}\n`).join("")}Please move or remove them before you ${tail}.\n`);
    }
    err("Aborting\n");
    return false;
  }
  for (const p of work) {
    const t = T.get(p);
    if (t) {
      checkoutFile(repo, p, t.oid, t.mode);
      ix.set(indexEntryFromTree(repo, p, t));
    } else {
      removeWorkFile(repo, p);
      ix.remove(p);
    }
  }
  writeTree(repo, ix, { repair: true });
  ix.commit();
  return true;
}

function treeOfCommit(repo: Repo, oid: string | null): string | null {
  return oid ? parseCommit(repo.odb.read(oid)!.body).tree : null;
}

// "M\tpath" lines for index/work-tree differences against the new HEAD.
function showLocalChanges(repo: Repo, ix: Index, headTree: string | null): void {
  const H = flattenTree(repo, headTree);
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const e of ix.entries) {
    seen.add(e.path);
    const h = H.get(e.path);
    const st = entryClean(repo, ix, e);
    if (st === "deleted") rows.push(`D\t${e.path}`);
    else if (!h) rows.push(`A\t${e.path}`);
    else if (!same(h, e) || st === "modified") rows.push(`M\t${e.path}`);
  }
  for (const p of H.keys()) if (!seen.has(p)) rows.push(`D\t${p}`);
  rows.sort((a, b) => (a.slice(2) < b.slice(2) ? -1 : 1));
  for (const r of rows) out(r + "\n");
}

const DETACH_ADVICE = (arg: string) =>
  `Note: switching to '${arg}'.\n\n` +
  "You are in 'detached HEAD' state. You can look around, make experimental\n" +
  "changes and commit them, and you can discard any commits you make in this\n" +
  "state without impacting any branches by switching back to a branch.\n\n" +
  "If you want to create a new branch to retain commits you create, you may\n" +
  "do so (now or later) by using -c with the switch command. Example:\n\n" +
  "  pkb switch -c <new-branch-name>\n\n" +
  "Or undo this operation with:\n\n" +
  "  pkb switch -\n\n" +
  "Turn off this advice by setting config variable advice.detachedHead to false\n\n";

function orphanedCommits(repo: Repo, from: string): string[] {
  const reachable = new Set<string>();
  const stack = listRefs(repo, "refs/").map((r) => r.oid);
  while (stack.length) {
    const o = stack.pop()!;
    if (reachable.has(o)) continue;
    reachable.add(o);
    const obj = repo.odb.read(o);
    if (obj?.type === "commit") stack.push(...parseCommit(obj.body).parents);
  }
  const lost: string[] = [];
  const st = [from], seen = new Set<string>();
  while (st.length) {
    const o = st.pop()!;
    if (reachable.has(o) || seen.has(o)) continue;
    seen.add(o);
    lost.push(o);
    st.push(...parseCommit(repo.odb.read(o)!.body).parents);
  }
  return lost;
}

function previousBranch(repo: Repo): string | null {
  const f = repo.path("logs", "HEAD");
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, "utf8").trimEnd().split("\n").reverse();
  for (const l of lines) {
    const m = l.match(/\tcheckout: moving from (.*) to .*$/);
    if (m) return m[1];
  }
  return null;
}

interface SwitchReq {
  op: "checkout" | "switch";
  arg: string; // as typed (for reflog / messages)
  branch: string | null; // target branch short name, or null for detach
  oid: string;
  newBranch: string | null;
  quiet: boolean;
  force: boolean;
}

function doSwitch(repo: Repo, r: SwitchReq): number {
  const h = head(repo);
  const ix = Index.read(repo.path("index"));
  ix.lock();
  if (!switchTrees(repo, ix, treeOfCommit(repo, h.oid), treeOfCommit(repo, r.oid), "checkout", r.force)) {
    ix.rollback();
    return 1;
  }
  const oldDesc = h.symref ? shortRef(h.symref) : h.oid ?? "HEAD";
  if (r.newBranch) createBranch(repo, r.newBranch, r.arg === "HEAD" ? undefined : r.arg, r.force);
  const target = r.newBranch ?? r.branch;
  const msg = `checkout: moving from ${oldDesc} to ${target ?? r.arg}`;
  if (!r.quiet) showLocalChanges(repo, ix, treeOfCommit(repo, r.oid));
  if (!h.symref && h.oid && !r.quiet) {
    const lost = h.oid !== r.oid ? orphanedCommits(repo, h.oid) : [];
    if (lost.length) {
      const n = lost.length;
      const list = lost.slice(0, 4).map((o) => `  ${repo.odb.abbrev(o)} ${subjectOf(parseCommit(repo.odb.read(o)!.body).message)}\n`).join("");
      err(`Warning: you are leaving ${n} commit${n === 1 ? "" : "s"} behind, not connected to\nany of your branches:\n\n${list}${n > 4 ? ` ... and ${n - 4} more.\n` : ""}\n` +
        `If you want to keep ${n === 1 ? "it" : "them"} by creating a new branch, this may be a good time\nto do so with:\n\n pkb branch <new-branch-name> ${repo.odb.abbrev(h.oid)}\n\n`);
    } else if (h.oid !== r.oid || target) {
      err(`Previous HEAD position was ${repo.odb.abbrev(h.oid)} ${subjectOf(parseCommit(repo.odb.read(h.oid)!.body).message)}\n`);
    }
  }
  if (target) {
    const ref = `refs/heads/${target}`;
    setHeadSymref(repo, ref);
    appendReflog(repo, "HEAD", h.oid, r.oid, msg);
    if (!r.quiet) {
      if (r.newBranch) err(`Switched to a new branch '${target}'\n`);
      else if (h.symref === ref) err(`Already on '${target}'\n`);
      else err(`Switched to branch '${target}'\n`);
      // existing branch with an upstream: report how it compares (fixture net-checkout-remote-branch)
      if (!r.newBranch) {
        const tr = trackingLong(repo, target, r.oid);
        if (tr) out(tr);
      }
    }
  } else {
    setHeadDetached(repo, r.oid);
    appendReflog(repo, "HEAD", h.oid, r.oid, msg);
    if (!r.quiet) {
      if (r.op === "checkout" && h.symref && repo.config.bool("advice.detachedhead", true)) err(DETACH_ADVICE(r.arg));
      err(`HEAD is now at ${repo.odb.abbrev(r.oid)} ${subjectOf(parseCommit(repo.odb.read(r.oid)!.body).message)}\n`);
    }
  }
  return 0;
}

// Observed: "Updated N path(s) from the index" appears for `checkout <path>` but not for
// `checkout -- <path>` (fixtures checkout-path-no-dashdash vs checkout-file).
function restorePaths(repo: Repo, source: string | null, args: string[], quiet: boolean): number {
  const ix = Index.read(repo.path("index"));
  const specs = makePathspecs(repo.prefix, args);
  let n = 0;
  if (source) {
    const tree = peel(repo, source, "tree");
    const T = flattenTree(repo, tree);
    ix.lock();
    const hit = new Set<number>();
    for (const [p, t] of T) {
      specs.forEach((s, i) => {
        if (!matchPathspec(s, p)) return;
        hit.add(i);
      });
      if (specs.some((s) => matchPathspec(s, p))) {
        checkoutFile(repo, p, t.oid, t.mode);
        ix.set(indexEntryFromTree(repo, p, t));
        n++;
      }
    }
    const miss = specs.findIndex((_, i) => !hit.has(i));
    if (miss >= 0) {
      ix.rollback();
      err(`error: pathspec '${specs[miss].raw}' did not match any file(s) known to pkb\n`);
      return 1;
    }
    ix.commit();
    if (!quiet) err(`Updated ${n} path${n === 1 ? "" : "s"} from ${repo.odb.abbrev(tree!)}\n`);
    return 0;
  }
  const hit = new Set<number>();
  const todo = ix.entries.filter((e) => {
    let m = false;
    specs.forEach((s, i) => {
      if (matchPathspec(s, e.path)) {
        hit.add(i);
        m = true;
      }
    });
    return m;
  });
  const miss = specs.findIndex((_, i) => !hit.has(i));
  if (miss >= 0) {
    err(`error: pathspec '${specs[miss].raw}' did not match any file(s) known to pkb\n`);
    return 1;
  }
  ix.lock();
  for (const e of todo) {
    if (entryClean(repo, ix, e) !== "clean") checkoutFile(repo, e.path, e.oid, e.mode.toString(8));
    const fresh = indexEntryFromTree(repo, e.path, { oid: e.oid, mode: e.mode.toString(8) });
    fresh.flags = e.flags;
    Object.assign(e, fresh);
    n++;
  }
  ix.commit();
  if (!quiet) err(`Updated ${n} path${n === 1 ? "" : "s"} from the index\n`);
  return 0;
}

export function cmdCheckout(argv: string[], repo: Repo): number {
  const p = parseOptions("checkout", argv, [
    { short: "b", arg: "required", key: "b" },
    { short: "B", arg: "required", key: "B" },
    { short: "q", long: "quiet", key: "quiet" },
    { short: "f", long: "force", key: "force" },
    { long: "detach", key: "detach" },
  ]);
  const quiet = !!p.opts.quiet;
  const before = p.dashdash >= 0 ? p.args.slice(0, p.dashdash) : p.args;
  const after = p.dashdash >= 0 ? p.args.slice(p.dashdash) : [];
  if (p.dashdash >= 0 && after.length) {
    if (before.length > 1) die("only one reference expected"); // unverified wording
    const src = before[0] ? resolveCommit(repo, before[0]) : null;
    if (before[0] && !src) die(`invalid reference: ${before[0]}`);
    return restorePaths(repo, src, after, true);
  }
  const newBranch = (p.opts.b ?? p.opts.B ?? null) as string | null;
  let arg = before[0] ?? (newBranch ? "HEAD" : undefined);
  if (arg === undefined) {
    // bare `git checkout`: reports local changes and succeeds (fixture ho-errors)
    if (!p.opts.quiet) showLocalChanges(repo, Index.read(repo.path("index")), treeOfCommit(repo, head(repo).oid));
    return 0;
  }
  if (arg === "-") arg = previousBranch(repo) ?? die("no previous branch");
  if (before.length > 1 && !newBranch) {
    const src = resolveCommit(repo, arg);
    if (src) return restorePaths(repo, src, before.slice(1), quiet);
  }
  const h = head(repo);
  if (!newBranch && !p.opts.detach) {
    const dwim = remoteBranchFor(repo, arg);
    if (dwim) return doSwitch(repo, { op: "checkout", arg: dwim.start, branch: null, oid: dwim.oid, newBranch: arg, quiet, force: !!p.opts.force });
  }
  const isBranch = !newBranch && !p.opts.detach && resolveRef(repo, `refs/heads/${arg}`)?.oid;
  const oid = arg === "HEAD" && !h.oid && newBranch ? null : resolveCommit(repo, arg);
  if (newBranch) {
    if (resolveRef(repo, `refs/heads/${newBranch}`)?.oid && !p.opts.B) die(`a branch named '${newBranch}' already exists`);
    if (!oid) {
      if (!h.oid && arg === "HEAD") {
        // unborn: just repoint HEAD
        setHeadSymref(repo, `refs/heads/${newBranch}`);
        if (!quiet) err(`Switched to a new branch '${newBranch}'\n`);
        return 0;
      }
      die(`'${arg}' is not a commit and a branch '${newBranch}' cannot be created from it`);
    }
    return doSwitch(repo, { op: "checkout", arg, branch: null, oid, newBranch, quiet, force: !!p.opts.force });
  }
  if (isBranch) return doSwitch(repo, { op: "checkout", arg, branch: arg, oid: oid!, newBranch: null, quiet, force: !!p.opts.force });
  if (oid) return doSwitch(repo, { op: "checkout", arg, branch: null, oid, newBranch: null, quiet, force: !!p.opts.force });
  if (arg === "HEAD" && !h.oid) return 0;
  // not a revision: treat as paths
  return restorePaths(repo, null, before, quiet);
}

export function cmdSwitch(argv: string[], repo: Repo): number {
  const p = parseOptions("switch", argv, [
    { short: "c", long: "create", arg: "required", key: "c" },
    { short: "C", long: "force-create", arg: "required", key: "C" },
    { short: "d", long: "detach", key: "detach" },
    { short: "q", long: "quiet", key: "quiet" },
    { short: "f", long: "force", key: "force" },
    { long: "discard-changes", key: "force" },
  ]);
  const quiet = !!p.opts.quiet;
  const newBranch = (p.opts.c ?? p.opts.C ?? null) as string | null;
  let arg = p.args[0] ?? (newBranch || p.opts.detach ? "HEAD" : undefined);
  if (arg === undefined) die("missing branch or commit argument");
  if (arg === "-") arg = previousBranch(repo) ?? die("no previous branch");
  const h = head(repo);
  if (newBranch) {
    if (resolveRef(repo, `refs/heads/${newBranch}`)?.oid && !p.opts.C) die(`a branch named '${newBranch}' already exists`);
    const oid = resolveCommit(repo, arg);
    if (!oid) {
      if (!h.oid && arg === "HEAD") {
        setHeadSymref(repo, `refs/heads/${newBranch}`);
        if (!quiet) err(`Switched to a new branch '${newBranch}'\n`);
        return 0;
      }
      die(`invalid reference: ${arg}`);
    }
    return doSwitch(repo, { op: "switch", arg, branch: null, oid, newBranch, quiet, force: !!p.opts.force });
  }
  if (!p.opts.detach && resolveRef(repo, `refs/heads/${arg}`)?.oid) {
    return doSwitch(repo, { op: "switch", arg, branch: arg, oid: resolveRef(repo, `refs/heads/${arg}`)!.oid!, newBranch: null, quiet, force: !!p.opts.force });
  }
  const dwim = !p.opts.detach ? remoteBranchFor(repo, arg) : null;
  if (dwim) return doSwitch(repo, { op: "switch", arg: dwim.start, branch: null, oid: dwim.oid, newBranch: arg, quiet, force: !!p.opts.force });
  const oid = resolveCommit(repo, arg);
  if (!oid) die(`invalid reference: ${arg}`);
  if (!p.opts.detach) {
    err(`fatal: a branch is expected, got commit '${arg}'\n`);
    hint(["If you want to detach HEAD at the commit, try again with the --detach option."]);
    exit(128);
  }
  return doSwitch(repo, { op: "switch", arg, branch: null, oid, newBranch: null, quiet, force: !!p.opts.force });
}
