// git commit
// Evidence (rea-evidence/findings/04-refs-porcelain.md §3): cmd_commit 0x14002ff50
//  (RUN_SETUP | NEED_WORK_TREE): builds the tree from the index (cache-tree), writes the
//  commit object (commit_tree 0x140138f90, see 02-objects.md §5), updates HEAD with reflog
//  "commit (initial): %s" / "commit: %s" / "commit (amend): %s", prints
//  "[%s%s %h] %s" with " (root-commit)", then " Author: " when author != committer and
//  the shortstat + create/delete-mode summary.
// Observed (fixtures commit-*): nothing to commit → long status on stdout ("Initial commit"
//  wording) and exit 1; "Aborting commit due to empty commit message." exit 1; -m cleanup is
//  whitespace mode (trailing spaces / repeated blank lines removed, '#' lines kept); the index
//  is written with a valid TREE even when the commit is aborted.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Repo } from "../repo.ts";
import { Index } from "../dircache.ts";
import { parseOptions } from "../options.ts";
import { makeEntry, entryClean, writeTree, flattenTree } from "../worktree.ts";
import { head, updateRef, shortRef } from "../refs.ts";
import { parseCommit, serializeCommit, parseIdent, subjectOf } from "../objects.ts";
import { ident, formatDefaultDate } from "../ident.ts";
import { collectStatus, printLong } from "../wtstatus.ts";
import { treePairs, detectRenames, patchFor, shortStat, summaryLines } from "../diff.ts";
import { die, err, out, exit } from "../output.ts";

export function cleanupMessage(msg: string, mode: "whitespace" | "strip" | "verbatim"): string {
  if (mode === "verbatim") return msg;
  let lines = msg.split("\n").map((l) => l.replace(/[ \t\r\f\v]+$/, ""));
  if (mode === "strip") lines = lines.filter((l) => !l.startsWith("#"));
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.length ? out.join("\n") + "\n" : "";
}

function runEditor(repo: Repo, file: string): void {
  const editor = process.env.PKB_EDITOR ?? repo.config.get("core.editor") ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  const r = spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    err(`error: There was a problem with the editor '${editor}'.\nPlease supply the message using either -m or -F option.\n`);
    exit(1);
  }
}

export function cmdCommit(argv: string[], repo: Repo): number {
  const p = parseOptions("commit", argv, [
    { short: "m", long: "message", arg: "required", key: "m", multi: true },
    { short: "F", long: "file", arg: "required", key: "F" },
    { short: "a", long: "all", key: "all" },
    { short: "q", long: "quiet", key: "quiet" },
    { short: "v", long: "verbose", key: "verbose" },
    { short: "n", long: "no-verify", key: "noVerify" },
    { long: "allow-empty", key: "allowEmpty" },
    { long: "allow-empty-message", key: "allowEmptyMessage" },
    { long: "amend", key: "amend" },
    { long: "cleanup", arg: "required", key: "cleanup" },
    { long: "author", arg: "required", key: "author" },
    { long: "date", arg: "required", key: "date" },
  ]);
  const ix = Index.read(repo.path("index"));
  ix.lock();
  if (p.opts.all) {
    for (const e of [...ix.entries]) {
      const st = entryClean(repo, ix, e);
      if (st === "modified") ix.set(makeEntry(repo, e.path, true, e));
      else if (st === "deleted") ix.remove(e.path);
    }
  }
  const tree = writeTree(repo, ix);
  ix.commit();

  const h = head(repo);
  let parents: string[] = h.oid ? [h.oid] : [];
  let amended: ReturnType<typeof parseCommit> | null = null;
  if (p.opts.amend) {
    if (!h.oid) die("You have nothing to amend.");
    amended = parseCommit(repo.odb.read(h.oid)!.body);
    parents = amended.parents;
  }
  const parentTree = parents[0] ? parseCommit(repo.odb.read(parents[0])!.body).tree : null;
  const unchanged = parentTree ? parentTree === tree : ix.entries.length === 0;

  // message: with -m/-F it is cleaned and saved to COMMIT_EDITMSG before the
  // nothing-to-commit check (fixtures commit-nothing, commit-empty-message)
  let mode: "whitespace" | "strip" | "verbatim" = "whitespace";
  if (p.opts.cleanup && p.opts.cleanup !== "default") mode = p.opts.cleanup;
  let msg: string | null = null;
  if (p.opts.m || p.opts.F) {
    const raw = p.opts.m ? (p.opts.m as string[]).join("\n\n") : p.opts.F === "-" ? readFileSync(0, "utf8") : readFileSync(p.opts.F, "utf8");
    msg = cleanupMessage(raw, mode);
    writeFileSync(repo.path("COMMIT_EDITMSG"), msg);
  }
  const nothing = unchanged && !p.opts.allowEmpty && !p.opts.amend;
  if (msg === null) {
    // editor template; observed (fixture ho-errors) to be written before the nothing-to-commit
    // check, ending after "# On branch" when there is nothing to commit
    const st = collectStatus(repo, ix);
    const a = parseIdent(amended ? amended.author : ident("author", repo.config, true)), c = parseIdent(ident("committer", repo.config, true));
    let t = (amended?.message ?? "") + "\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n#\n";
    if (a.name !== c.name || a.email !== c.email) t += `# Author:    ${a.name} <${a.email}>\n#\n`;
    const long = printLong(repo, st, true).replace(/\n$/, "").split("\n");
    const shown = nothing ? long.slice(0, 1) : long;
    t += shown.map((l) => (l === "" ? "#" : l.startsWith("\t") ? "#" + l : "# " + l)).join("\n") + "\n";
    writeFileSync(repo.path("COMMIT_EDITMSG"), t);
  }
  if (nothing) {
    out(printLong(repo, collectStatus(repo, ix), true));
    return 1;
  }
  if (msg === null) {
    const f = repo.path("COMMIT_EDITMSG");
    runEditor(repo, f);
    msg = cleanupMessage(readFileSync(f, "utf8"), p.opts.cleanup && p.opts.cleanup !== "default" ? mode : "strip");
  }
  if (!msg && !p.opts.allowEmptyMessage) {
    err("Aborting commit due to empty commit message.\n");
    return 1;
  }

  let author = amended ? amended.author : ident("author", repo.config);
  if (p.opts.author) {
    const m = (p.opts.author as string).match(/^(.*?)\s*<(.*)>$/);
    if (!m) die(`--author '${p.opts.author}' is not 'Name <email>' and matches no existing author`);
    const a = parseIdent(author);
    author = `${m[1]} <${m[2]}> ${a.time} ${a.tz}`;
  }
  const committer = ident("committer", repo.config);
  const oid = repo.odb.write("commit", serializeCommit({ tree, parents, author, committer, message: msg, extraHeaders: [] }));
  const subject = msg.split("\n")[0].trim(); // reflog subject is trimmed (fixture commit-message-cleanup)
  const kind = p.opts.amend ? "commit (amend)" : parents.length ? "commit" : "commit (initial)";
  updateRef(repo, "HEAD", oid, `${kind}: ${subject}`);

  if (!p.opts.quiet) {
    const where = h.symref ? shortRef(h.symref) : "detached HEAD";
    out(`[${where}${parents.length ? "" : " (root-commit)"} ${repo.odb.abbrev(oid)}] ${subjectOf(msg)}\n`);
    const a = parseIdent(author), c = parseIdent(committer);
    if (a.name !== c.name || a.email !== c.email) out(` Author: ${a.name} <${a.email}>\n`);
    if (a.time !== c.time) out(` Date: ${formatDefaultDate(a.time, a.tz)}\n`);
    const pairs = detectRenames(treePairs(flattenTree(repo, parentTree), flattenTree(repo, tree)));
    if (pairs.length) {
      const stats = pairs.map((pp) => patchFor(repo, pp, 3).stat);
      out(shortStat(stats));
      out(summaryLines(pairs));
    }
  }
  return 0;
}
