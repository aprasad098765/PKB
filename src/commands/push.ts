// pkb push
// Observed against git-http-backend (fixtures net-push*):
//  - stderr "To <url without credentials>" then per ref:
//    "   a..b  master -> master", " * [new branch]      feat -> feat",
//    " + a...b master -> master (forced update)", " - [deleted]         feat",
//    " ! [rejected]        master -> master (fetch first|non-fast-forward)";
//  - "Everything up-to-date" when nothing changes; "error: failed to push some refs to '%s'"
//    with the fetch-first / non-fast-forward hint paragraphs; "error: src refspec %s does not
//    match any"; "error: unable to delete '%s': remote ref does not exist";
//  - after success the remote-tracking ref moves with reflog "update by push";
//    -u writes branch.<b>.remote/merge and prints "branch '%s' set up to track '%s'.".
import type { Repo } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { head, resolveRef, updateRef, deleteRef, shortRef, listRefs } from "../refs.ts";
import { resolveRev } from "../revparse.ts";
import { openTransport } from "../net/transport.ts";
import type { RefUpdate } from "../net/transport.ts";
import { enumerateObjects, writePack } from "../pack.ts";
import { remoteNames, fetchSpecs, mapRef, setUpstream, upstreamOf, anonymize, parseRefspec } from "../remote.ts";
import { isAncestor } from "./branch.ts";
import { die, err, out } from "../output.ts";
import { NAME } from "../brand.ts";

const ZERO = "0".repeat(40);

const HINT_FETCH_FIRST = [
  "Updates were rejected because the remote contains work that you do not",
  "have locally. This is usually caused by another repository pushing to",
  "the same ref. If you want to integrate the remote changes, use",
  `'${NAME} pull' before pushing again.`,
  `See the 'Note about fast-forwards' in '${NAME} push --help' for details.`,
];
const HINT_NON_FF = [
  "Updates were rejected because the tip of your current branch is behind",
  "its remote counterpart. If you want to integrate the remote changes,",
  `use '${NAME} pull' before pushing again.`,
  `See the 'Note about fast-forwards' in '${NAME} push --help' for details.`,
];

interface Plan {
  src: string | null; // local ref or rev as written (null for delete)
  srcRef: string | null; // full local ref when src is a branch/tag
  dst: string; // remote ref
  newOid: string;
  force: boolean;
}

function localRef(repo: Repo, name: string): string | null {
  for (const c of [name, `refs/${name}`, `refs/heads/${name}`, `refs/tags/${name}`]) {
    if (c.startsWith("refs/") && resolveRef(repo, c)?.oid) return c;
  }
  return null;
}

export async function cmdPush(argv: string[], repo: Repo): Promise<number> {
  const p = parseOptions("push", argv, [
    { short: "u", long: "set-upstream", key: "setUpstream" },
    { short: "f", long: "force", key: "force" },
    { short: "q", long: "quiet", key: "quiet" },
    { short: "d", long: "delete", key: "delete" },
    { long: "tags", key: "tags" },
  ]);
  const h = head(repo);
  const curBranch = h.symref ? shortRef(h.symref) : null;
  let remoteArg = p.args[0];
  if (remoteArg === undefined) {
    remoteArg = (curBranch && (repo.config.get(`branch.${curBranch}.pushremote`) ?? repo.config.get("remote.pushdefault") ?? repo.config.get(`branch.${curBranch}.remote`))) ||
      (remoteNames(repo).includes("origin") ? "origin" : remoteNames(repo).length === 1 ? remoteNames(repo)[0] : "");
    if (!remoteArg) {
      die(`No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    ${NAME} remote add <name> <url>\n\nand then push using the remote name\n\n    ${NAME} push <name>\n`);
    }
  }
  const named = remoteNames(repo).includes(remoteArg);
  const url = named ? (repo.config.get(`remote.${remoteArg}.pushurl`) ?? repo.config.get(`remote.${remoteArg}.url`)!) : remoteArg;
  let specs = p.args.slice(1);

  // default refspec: the current branch (push.default=simple)
  if (!specs.length && !p.opts.tags) {
    if (!curBranch) die(`You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)\nstate now, use\n\n    ${NAME} push ${remoteArg} HEAD:<name-of-remote-branch>\n`);
    const up = upstreamOf(repo, curBranch);
    if (named && !p.opts.setUpstream && (!up || up.remote !== remoteArg)) {
      die(`The current branch ${curBranch} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    ${NAME} push --set-upstream ${remoteArg} ${curBranch}\n\nTo have this happen automatically for branches without a tracking\nupstream, see 'push.autoSetupRemote' in '${NAME} help config'.\n`);
    }
    specs = [up && up.remote === remoteArg ? `refs/heads/${curBranch}:${up.merge}` : `refs/heads/${curBranch}`];
  }

  const t = openTransport(url, repo.config);
  const adv = await t.discover("receive");
  const remoteOid = new Map(adv.refs.map((r) => [r.name, r.oid]));
  const plans: Plan[] = [];
  const errors: string[] = [];
  const addPlan = (spec: string) => {
    const s = parseRefspec(spec);
    if (p.opts.delete) {
      plans.push({ src: null, srcRef: null, dst: s.src.startsWith("refs/") ? s.src : `refs/heads/${s.src}`, newOid: ZERO, force: true });
      return;
    }
    if (s.src === "") {
      const d = s.dst!;
      const dst = d.startsWith("refs/") ? d : remoteOid.has(`refs/tags/${d}`) ? `refs/tags/${d}` : `refs/heads/${d}`;
      plans.push({ src: null, srcRef: null, dst, newOid: ZERO, force: true });
      return;
    }
    const srcRef = s.src === "HEAD" ? h.symref : localRef(repo, s.src);
    const oid = srcRef ? resolveRef(repo, srcRef)!.oid : resolveRev(repo, s.src);
    if (!oid) {
      errors.push(`error: src refspec ${s.src} does not match any\n`);
      return;
    }
    let dst = s.dst ?? srcRef ?? s.src;
    if (!dst.startsWith("refs/")) dst = remoteOid.has(`refs/tags/${dst}`) || srcRef?.startsWith("refs/tags/") ? `refs/tags/${dst}` : `refs/heads/${dst}`;
    plans.push({ src: s.src === "HEAD" ? "HEAD" : s.src.replace(/^refs\/(heads|tags)\//, ""), srcRef, dst, newOid: oid, force: s.force || !!p.opts.force });
  };
  for (const s of specs) addPlan(s);
  if (p.opts.tags) for (const r of listRefs(repo, "refs/tags/")) if (remoteOid.get(r.name) !== r.oid) addPlan(r.name);

  const shown = anonymize(url);
  const lines: string[] = [];
  const cmds: RefUpdate[] = [];
  let rejected: "fetch first" | "non-fast-forward" | null = null;
  const ab = (o: string) => repo.odb.abbrev(o);
  const short = (r: string) => r.replace(/^refs\/(heads|tags)\//, "");
  for (const pl of plans) {
    const old = remoteOid.get(pl.dst) ?? ZERO;
    if (pl.newOid === ZERO) {
      if (old === ZERO) {
        errors.push(`error: unable to delete '${short(pl.dst)}': remote ref does not exist\n`);
        continue;
      }
      cmds.push({ old, new: ZERO, ref: pl.dst });
      lines.push(` - ${"[deleted]".padEnd(17)} ${short(pl.dst)}`);
      continue;
    }
    if (old === pl.newOid) continue;
    if (old !== ZERO && !pl.force) {
      const why = !repo.odb.has(old) ? "fetch first" : !isAncestor(repo, old, pl.newOid) ? "non-fast-forward" : null;
      if (why) {
        lines.push(` ! ${"[rejected]".padEnd(17)} ${pl.src} -> ${short(pl.dst)} (${why})`);
        rejected ??= why;
        continue;
      }
    }
    cmds.push({ old, new: pl.newOid, ref: pl.dst });
    if (old === ZERO) lines.push(` * ${(pl.dst.startsWith("refs/tags/") ? "[new tag]" : "[new branch]").padEnd(17)} ${pl.src} -> ${short(pl.dst)}`);
    else if (isAncestor(repo, old, pl.newOid)) lines.push(`   ${`${ab(old)}..${ab(pl.newOid)}`.padEnd(17)} ${pl.src} -> ${short(pl.dst)}`);
    else lines.push(` + ${`${ab(old)}...${ab(pl.newOid)}`.padEnd(17)} ${pl.src} -> ${short(pl.dst)} (forced update)`);
  }

  let rc = 0;
  if (!cmds.length) await t.close?.(); // nothing to send: end an ssh session cleanly
  if (cmds.length) {
    const tips = cmds.filter((c) => c.new !== ZERO).map((c) => c.new);
    const have = adv.refs.map((r) => r.oid).filter((o) => repo.odb.has(o));
    const pack = tips.length ? writePack(repo.odb, enumerateObjects(repo.odb, tips, have)) : null;
    const rep = await t.sendPack(cmds, pack);
    if (rep.unpack && rep.unpack !== "ok") die(`unpack failed: ${rep.unpack}`);
    for (const c of cmds) {
      const reason = rep.results.get(c.ref);
      if (reason) {
        const i = lines.findIndex((l) => l.includes(`-> ${short(c.ref)}`) || l.endsWith(` ${short(c.ref)}`));
        const pl = plans.find((x) => x.dst === c.ref)!;
        lines[i] = ` ! ${"[remote rejected]".padEnd(17)} ${pl.src ?? "(delete)"} -> ${short(c.ref)} (${reason})`;
        rc = 1;
        continue;
      }
      // keep remote-tracking refs in step
      if (named) {
        for (const s of fetchSpecs(repo, remoteArg)) {
          const tr = mapRef(s, c.ref);
          if (!tr) continue;
          if (c.new === ZERO) deleteRef(repo, tr);
          else updateRef(repo, tr, c.new, "update by push");
        }
      }
    }
  }
  if (p.opts.setUpstream && named) {
    for (const pl of plans) {
      if (!pl.srcRef?.startsWith("refs/heads/") || pl.newOid === ZERO) continue;
      const b = pl.srcRef.slice(11);
      setUpstream(repo, b, remoteArg, pl.dst);
      out(`branch '${b}' set up to track '${remoteArg}/${short(pl.dst)}'.\n`);
    }
  }
  for (const e of errors) err(e);
  if (lines.length && !p.opts.quiet) err(`To ${shown}\n${lines.join("\n")}\n`);
  if (!lines.length && !errors.length && !p.opts.quiet) err("Everything up-to-date\n");
  if (errors.length || rejected || rc) {
    err(`error: failed to push some refs to '${shown}'\n`);
    if (rejected) for (const l of rejected === "fetch first" ? HINT_FETCH_FIRST : HINT_NON_FF) err(`hint: ${l}\n`);
    return 1;
  }
  return 0;
}
