// git branch
// Evidence (rea-evidence/findings/04-refs-porcelain.md §4): cmd_branch 0x140014c00 (option
//  0x11); list markers "* " / "  ", "Deleted branch %s (was %s).", create via
//  create_branch with reflog "branch: Created from %s".
// Observed (fixtures branch-*, detached-head): "a branch named '%s' already exists",
//  "not a valid object name: '%s'", "'%s' is not a valid branch name" + advice refSyntax,
//  "branch '%s' not found" (error, 1), "the branch '%s' is not fully merged" + advice
//  forceDeleteBranch, "cannot delete branch '%s' used by worktree at '%s'",
//  "* (HEAD detached at %s)", -v columns "%-*s %s %s".
import type { Repo } from "../repo.ts";
import { toSlash } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { head, listRefs, updateRef, deleteRef, validRefName, resolveRef, detachedFrom, shortRef, readRefRaw, setHeadSymref } from "../refs.ts";
import { resolveCommit, dwimRef } from "../revparse.ts";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ident } from "../ident.ts";
import { ZERO_OID as ZERO } from "../odb.ts";
import { setUpstream, remoteOfTrackingRef, trackingShort } from "../remote.ts";
import { configRemoveSection, configRenameSection } from "../config.ts";
import { parseCommit, subjectOf } from "../objects.ts";
import { die, err, out, hint, GitExit } from "../output.ts";

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length) {
    const o = stack.pop()!;
    if (o === anc) return true;
    if (seen.has(o)) continue;
    seen.add(o);
    const obj = repo.odb.read(o);
    if (obj) stack.push(...parseCommit(obj.body).parents);
  }
  return false;
}

export function createBranch(repo: Repo, name: string, start: string | undefined, force = false, logName?: string): string {
  if (!validRefName(name) || name === "HEAD") {
    err(`fatal: '${name}' is not a valid branch name\n`);
    hint(["See `man pkb check-ref-format`"], repo.config.bool("advice.refsyntax", true) ? "refSyntax" : undefined);
    throw new GitExit(128);
  }
  const ref = `refs/heads/${name}`;
  if (!force && resolveRef(repo, ref)?.oid) die(`a branch named '${name}' already exists`);
  const startName = start ?? "HEAD";
  const oid = resolveCommit(repo, startName);
  if (!oid) {
    const h = head(repo);
    die(`not a valid object name: '${start ?? (h.symref ? shortRef(h.symref) : "HEAD")}'`);
  }
  updateRef(repo, ref, oid, `branch: Created from ${logName ?? startName}`);
  // starting from a remote-tracking branch sets it as upstream (branch.autoSetupMerge=true);
  // message observed in fixture net-checkout-remote-branch
  const startRef = start ? dwimRef(repo, start)?.ref : undefined;
  if (startRef?.startsWith("refs/remotes/") && repo.config.get("branch.autosetupmerge") !== "false") {
    const tr = remoteOfTrackingRef(repo, startRef);
    if (tr) {
      setUpstream(repo, name, tr.remote, tr.merge);
      out(`branch '${name}' set up to track '${startRef.slice(13)}'.\n`);
    }
  }
  return oid;
}

// branch -m/-M (rename) and -c/-C (copy). Observed (fixture branch-rename-copy):
//  - the branch's reflog moves (or is duplicated) and gains "Branch: renamed|copied <old> to <new>"
//    (old oid -> same oid); renaming the checked-out branch adds two HEAD entries
//    (oid -> zero, zero -> oid) with the same message, even when old and new are equal;
//  - on an unborn branch only HEAD is repointed;
//  - errors: "no branch named '%s'", "a branch named '%s' already exists",
//    "cannot force update the branch '%s' used by worktree at '%s'", invalid-name advice.
function moveBranch(repo: Repo, args: string[], force: boolean, copy: boolean): number {
  const h = head(repo);
  const cur = h.symref?.startsWith("refs/heads/") ? h.symref.slice(11) : null;
  if (args.length === 0 || args.length > 2) die(`branch name required`);
  const [oldName, newName] = args.length === 1 ? [cur, args[0]] : args;
  if (!oldName) die(`cannot ${copy ? "copy" : "rename"} the current branch while not on any`);
  if (!validRefName(newName) || newName === "HEAD") {
    err(`fatal: '${newName}' is not a valid branch name\n`);
    hint(["See `man pkb check-ref-format`"], repo.config.bool("advice.refsyntax", true) ? "refSyntax" : undefined);
    throw new GitExit(128);
  }
  const oldRef = `refs/heads/${oldName}`, newRef = `refs/heads/${newName}`;
  const oid = resolveRef(repo, oldRef)?.oid ?? null;
  const unborn = !oid && h.symref === oldRef;
  if (!oid && !unborn) die(`no branch named '${oldName}'`);
  if (newRef !== oldRef && resolveRef(repo, newRef)?.oid) {
    if (!force) die(`a branch named '${newName}' already exists`);
    if (h.symref === newRef) die(`cannot force update the branch '${newName}' used by worktree at '${toSlash(repo.workTree ?? repo.gitDir)}'`);
  }
  if (unborn) {
    if (copy) die(`no branch named '${oldName}'`);
    setHeadSymref(repo, newRef);
    configRenameSection(repo.path("config"), repo.config, "branch", oldName, newName, false);
    return 0;
  }
  const msg = `Branch: ${copy ? "copied" : "renamed"} ${oldRef} to ${newRef}`;
  const who = ident("committer", repo.config, true);
  const entry = (a: string, b: string) => `${a} ${b} ${who}\t${msg}\n`;
  const oldLog = existsSync(repo.path("logs", oldRef)) ? readFileSync(repo.path("logs", oldRef), "utf8") : "";
  if (!copy && oldRef !== newRef) deleteRef(repo, oldRef);
  mkdirSync(dirname(repo.path(newRef)), { recursive: true });
  writeFileSync(repo.path(newRef), `${oid}\n`);
  mkdirSync(dirname(repo.path("logs", newRef)), { recursive: true });
  writeFileSync(repo.path("logs", newRef), oldLog + entry(oid!, oid!));
  if (oldRef !== newRef) configRenameSection(repo.path("config"), repo.config, "branch", oldName, newName, copy);
  if (!copy && h.symref === oldRef) {
    setHeadSymref(repo, newRef);
    // the second entry starts from zero only when the name actually changed
    appendFileSync(repo.path("logs", "HEAD"), entry(oid!, ZERO) + entry(oldRef === newRef ? oid! : ZERO, oid!));
  }
  return 0;
}

// Symbolic refs such as refs/remotes/origin/HEAD (listRefs only returns direct refs).
function remoteSymrefs(repo: Repo): { name: string; target: string }[] {
  const out: { name: string; target: string }[] = [];
  const dir = repo.path("refs", "remotes");
  if (!existsSync(dir)) return out;
  for (const r of readdirSync(dir)) {
    const raw = readRefRaw(repo, `refs/remotes/${r}/HEAD`);
    if (raw?.startsWith("ref: ")) out.push({ name: `refs/remotes/${r}/HEAD`, target: raw.slice(5).trim() });
  }
  return out;
}

export function cmdBranch(argv: string[], repo: Repo): number {
  const p = parseOptions("branch", argv, [
    { short: "d", long: "delete", key: "delete" },
    { short: "D", key: "forceDelete" },
    { short: "f", long: "force", key: "force" },
    { short: "l", long: "list", key: "list" },
    { short: "v", long: "verbose", key: "verbose", multi: true },
    { long: "show-current", key: "showCurrent" },
    { short: "q", long: "quiet", key: "quiet" },
    { short: "r", long: "remotes", key: "remotes" },
    { short: "a", long: "all", key: "all" },
    { short: "u", long: "set-upstream-to", arg: "required", key: "setUpstream" },
    { long: "unset-upstream", key: "unsetUpstream" },
    { short: "m", long: "move", key: "move" },
    { short: "M", key: "forceMove" },
    { short: "c", long: "copy", key: "copy" },
    { short: "C", key: "forceCopy" },
  ]);
  if (p.opts.move || p.opts.forceMove) return moveBranch(repo, p.args, !!p.opts.forceMove || !!p.opts.force, false);
  if (p.opts.copy || p.opts.forceCopy) return moveBranch(repo, p.args, !!p.opts.forceCopy || !!p.opts.force, true);
  const h = head(repo);
  const verbose = (p.opts.verbose as unknown[] | undefined)?.length ?? 0;
  if (p.opts.showCurrent) {
    if (h.symref) out(shortRef(h.symref) + "\n");
    return 0;
  }
  if (p.opts.setUpstream || p.opts.unsetUpstream) {
    const b = p.args[0] ?? (h.symref ? shortRef(h.symref) : null);
    if (!b) die("could not set upstream of HEAD when it does not point to any branch.");
    if (p.opts.unsetUpstream) {
      configRemoveSection(repo.path("config"), repo.config, "branch", b);
      return 0;
    }
    const up = dwimRef(repo, p.opts.setUpstream as string);
    const tr = up?.ref.startsWith("refs/remotes/") ? remoteOfTrackingRef(repo, up.ref) : null;
    if (!tr) die(`the requested upstream branch '${p.opts.setUpstream}' does not exist`);
    setUpstream(repo, b, tr.remote, tr.merge);
    out(`branch '${b}' set up to track '${up!.ref.slice(13)}'.\n`);
    return 0;
  }
  if (p.opts.delete || p.opts.forceDelete) {
    const force = !!p.opts.forceDelete || (p.opts.delete && p.opts.force);
    if (!p.args.length) die("branch name required");
    let rc = 0;
    for (const name of p.args) {
      const ref = `refs/heads/${name}`;
      if (h.symref === ref) {
        err(`error: cannot delete branch '${name}' used by worktree at '${toSlash(repo.workTree ?? repo.gitDir)}'\n`);
        rc = 1;
        continue;
      }
      const r = resolveRef(repo, ref);
      if (!r?.oid) {
        err(`error: branch '${name}' not found\n`);
        rc = 1;
        continue;
      }
      if (!force && h.oid && !isAncestor(repo, r.oid, h.oid)) {
        err(`error: the branch '${name}' is not fully merged\n`);
        hint([`If you are sure you want to delete it, run 'pkb branch -D ${name}'`], repo.config.bool("advice.forcedeletebranch", true) ? "forceDeleteBranch" : undefined);
        rc = 1;
        continue;
      }
      deleteRef(repo, ref);
      configRemoveSection(repo.path("config"), repo.config, "branch", name);
      if (!p.opts.quiet) out(`Deleted branch ${name} (was ${repo.odb.abbrev(r.oid)}).\n`);
    }
    return rc;
  }
  if (p.args.length && !p.opts.list) {
    if (p.args.length > 2) die("too many arguments for a create operation"); // unverified wording
    // with no start point the reflog names the current branch (fixture branch-ops: "Created from master")
    createBranch(repo, p.args[0], p.args[1], !!p.opts.force, p.args[1] ?? (h.symref ? shortRef(h.symref) : "HEAD"));
    return 0;
  }
  // list (observed in fixtures net-clone-basic / net-push: "-a" shows "remotes/origin/HEAD ->
  // origin/master", "-vv" adds "[origin/master: ahead 1]")
  const rows: { name: string; current: boolean; oid: string; branch?: string; target?: string }[] = [];
  if (!p.opts.remotes) {
    if (!h.symref && h.oid) {
      const d = detachedFrom(repo, h.oid);
      rows.push({ name: `(HEAD detached ${d.word} ${d.name ?? repo.odb.abbrev(d.oid)})`, current: true, oid: h.oid });
    }
    for (const r of listRefs(repo, "refs/heads/")) rows.push({ name: r.name.slice(11), current: h.symref === r.name, oid: r.oid, branch: r.name.slice(11) });
  }
  if (p.opts.remotes || p.opts.all) {
    const pre = p.opts.all ? "remotes/" : "";
    const remote = [
      ...remoteSymrefs(repo).map((s) => ({ name: s.name, oid: resolveRef(repo, s.name)?.oid ?? "", target: s.target })),
      ...listRefs(repo, "refs/remotes/").map((r) => ({ ...r, target: undefined as string | undefined })),
    ].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const r of remote) rows.push({ name: pre + r.name.slice(13), current: false, oid: r.oid, target: r.target?.slice(13) });
  }
  const w = Math.max(0, ...rows.filter((r) => !r.target).map((r) => r.name.length));
  for (const r of rows) {
    const mark = r.current ? "* " : "  ";
    if (r.target) {
      out(`${mark}${r.name} -> ${r.target}\n`);
      continue;
    }
    if (verbose) {
      const c = parseCommit(repo.odb.read(r.oid)!.body);
      let track = "";
      const tr = r.branch ? trackingShort(repo, r.branch, r.oid) : null;
      if (tr && verbose > 1) track = `[${tr.name}${tr.detail ? `: ${tr.detail}` : ""}] `;
      else if (tr?.detail) track = `[${tr.detail}] `;
      out(`${mark}${r.name.padEnd(w)} ${repo.odb.abbrev(r.oid)} ${track}${subjectOf(c.message)}\n`);
    } else out(`${mark}${r.name}\n`);
  }
  return 0;
}
