// pkb fetch (also the object-transfer core of clone)
// Observed against git-http-backend (fixture net-fetch):
//  - output on stderr: "From <url without .git>" then one line per updated ref:
//    "   a..b  master     -> origin/master", " * [new branch]      new        -> origin/new",
//    " + a...b master     -> origin/master  (forced update)", " * branch            side       -> FETCH_HEAD";
//    the summary column is 17 wide and the name column at least 10;
//  - reflog "<fetch argv>: fast-forward" / "storing head" / "forced-update";
//  - FETCH_HEAD "<oid>\t[not-for-merge]\tbranch '<b>' of <url>";
//  - fewer than 100 received objects are stored loose, larger packs are kept with .idx/.rev.
import { writeFileSync } from "node:fs";
import type { Repo } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { head, listRefs, resolveRef, updateRef, deleteRef, shortRef } from "../refs.ts";
import { parseCommit } from "../objects.ts";
import { parsePack, storePack } from "../pack.ts";
import { openTransport } from "../net/transport.ts";
import type { Advert, Transport } from "../net/transport.ts";
import { remoteNames, fetchSpecs, mapRef, upstreamOf, fetchDisplayUrl, parseRefspec } from "../remote.ts";
import type { Refspec } from "../remote.ts";
import { isAncestor } from "./branch.ts";
import { die, err } from "../output.ts";

export const UNPACK_LIMIT = 100;

// Local commits to offer as "have": every ref tip, then ancestors newest-first (bounded).
export function localHaves(repo: Repo, limit = 256): string[] {
  const tips = [...listRefs(repo, "refs/"), ...(head(repo).oid ? [{ name: "HEAD", oid: head(repo).oid! }] : [])].map((r) => r.oid);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...new Set(tips)];
  while (queue.length && out.length < limit) {
    const o = queue.shift()!;
    if (seen.has(o)) continue;
    seen.add(o);
    const obj = repo.odb.read(o);
    if (!obj || obj.type !== "commit") continue;
    out.push(o);
    queue.push(...parseCommit(obj.body).parents);
  }
  return out;
}

// Download whatever `wants` the odb lacks; keep the pack or explode it into loose objects.
export async function receiveObjects(repo: Repo, t: Transport, wants: string[], keep: boolean): Promise<void> {
  const need = [...new Set(wants)].filter((w) => !repo.odb.has(w));
  if (!need.length) return;
  const pack = await t.fetchPack(need, localHaves(repo));
  if (pack.length < 32) return;
  const entries = parsePack(pack, repo.odb);
  if (keep || entries.length >= UNPACK_LIMIT) {
    storePack(repo.odb.dir, pack, entries);
    repo.odb.reloadPacks();
  } else for (const e of entries) repo.odb.write(e.objType!, e.body!);
}

interface Mapping {
  src: string; // remote ref
  oid: string;
  dst: string | null; // local ref, null = FETCH_HEAD only
  force: boolean;
  forMerge: boolean;
  noFetchHead?: boolean; // opportunistic tracking update for a command-line branch
}

function dwimRemote(adv: Advert, name: string): string | null {
  const names = new Set(adv.refs.map((r) => r.name));
  for (const c of [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`]) if (names.has(c)) return c;
  return null;
}

const shortName = (r: string) => (r === "FETCH_HEAD" ? r : r.replace(/^refs\/(heads|tags|remotes)\//, ""));

export interface FetchResult {
  code: number;
  adv: Advert;
}

export async function fetchFrom(repo: Repo, remote: string | null, url: string, args: string[], opts: { quiet: boolean; prune: boolean; reflog: string }): Promise<FetchResult> {
  // FETCH_HEAD is emptied before connecting: a failed fetch leaves it empty (net-pull-refused)
  writeFileSync(repo.path("FETCH_HEAD"), "");
  const t = openTransport(url, repo.config);
  const adv = await t.discover("upload");
  const advOid = new Map(adv.refs.map((r) => [r.name, r.oid]));
  const maps: Mapping[] = [];
  const cur = head(repo).symref;
  const up = cur ? upstreamOf(repo, shortRef(cur)) : null;
  const configured: Refspec[] = remote ? fetchSpecs(repo, remote) : [];
  if (!args.length && !remote) args = ["HEAD"]; // "fetch <url>" with no refspec fetches the remote HEAD
  if (!args.length) {
    for (const r of adv.refs) {
      for (const s of configured) {
        const dst = mapRef(s, r.name);
        if (dst) maps.push({ src: r.name, oid: r.oid, dst, force: s.force, forMerge: !!up && up.remote === remote && up.merge === r.name });
      }
    }
  } else {
    for (const a of args) {
      const s = parseRefspec(a);
      const src = dwimRemote(adv, s.src);
      if (!src) die(`couldn't find remote ref ${s.src}`);
      let dst: string | null = s.dst ? (s.dst.startsWith("refs/") ? s.dst : `refs/heads/${s.dst}`) : null;
      let force = s.force;
      if (!dst && remote) {
        // opportunistic remote-tracking update for named remotes
        for (const c of configured) {
          const m = mapRef(c, src);
          if (m) { dst = m; force = c.force; break; }
        }
      }
      // observed (net-pull): " * branch side -> FETCH_HEAD" plus the "side -> origin/side" update
      if (s.dst) maps.push({ src, oid: advOid.get(src)!, dst, force, forMerge: true });
      else {
        maps.push({ src, oid: advOid.get(src)!, dst: null, force, forMerge: true });
        if (dst) maps.push({ src, oid: advOid.get(src)!, dst, force, forMerge: false, noFetchHead: true });
      }
    }
  }
  // tags pointing into what we fetch follow along (named remotes, default refspecs)
  const autoTags = !args.length && !!remote;
  await receiveObjects(repo, t, maps.map((m) => m.oid), false);
  if (autoTags) {
    const tagWants: Mapping[] = [];
    for (const r of adv.refs) {
      if (!r.name.startsWith("refs/tags/") || resolveRef(repo, r.name)?.oid) continue;
      const peeled = adv.peeled.get(r.name) ?? r.oid;
      if (repo.odb.has(peeled)) tagWants.push({ src: r.name, oid: r.oid, dst: r.name, force: false, forMerge: false });
    }
    await receiveObjects(repo, t, tagWants.map((m) => m.oid), false);
    maps.push(...tagWants);
  }

  // update refs
  const width = Math.max(10, ...maps.map((m) => shortName(m.src).length));
  const lines: string[] = [];
  let code = 0;
  const row = (flag: string, summary: string, src: string, dst: string, suffix = "") =>
    lines.push(` ${flag} ${summary.padEnd(17)} ${shortName(src).padEnd(width)} -> ${shortName(dst)}${suffix}`);
  for (const m of maps) {
    if (!m.dst) {
      row("*", m.src.startsWith("refs/tags/") ? "tag" : "branch", m.src, "FETCH_HEAD");
      continue;
    }
    const old = resolveRef(repo, m.dst)?.oid ?? null;
    if (old === m.oid) continue;
    const ab = (o: string) => repo.odb.abbrev(o);
    if (!old) {
      const kind = m.src.startsWith("refs/tags/") ? "tag" : m.src.startsWith("refs/heads/") ? "branch" : "ref";
      updateRef(repo, m.dst, m.oid, `${opts.reflog}: storing ${kind === "tag" ? "tag" : "head"}`);
      row("*", `[new ${kind}]`, m.src, m.dst);
    } else if (isAncestor(repo, old, m.oid)) {
      updateRef(repo, m.dst, m.oid, `${opts.reflog}: fast-forward`);
      row(" ", `${ab(old)}..${ab(m.oid)}`, m.src, m.dst);
    } else if (m.force) {
      updateRef(repo, m.dst, m.oid, `${opts.reflog}: forced-update`);
      row("+", `${ab(old)}...${ab(m.oid)}`, m.src, m.dst, "  (forced update)");
    } else {
      row("!", "[rejected]", m.src, m.dst, "  (non-fast-forward)");
      code = 1;
    }
  }
  if (opts.prune && remote) {
    const live = new Set(maps.map((m) => m.dst));
    for (const s of configured) {
      const ns = s.dst?.replace(/\*.*$/, "");
      if (!ns) continue;
      for (const r of listRefs(repo, ns)) {
        if (live.has(r.name)) continue;
        deleteRef(repo, r.name);
        lines.push(` - ${"[deleted]".padEnd(17)} ${"(none)".padEnd(width)} -> ${shortName(r.name)}`);
      }
    }
  }
  const shown = fetchDisplayUrl(url);
  if (lines.length && !opts.quiet) err(`From ${shown}\n${lines.join("\n")}\n`);
  // FETCH_HEAD: entries to merge first
  const fh = [...maps.filter((m) => m.forMerge), ...maps.filter((m) => !m.forMerge && !m.noFetchHead)]
    .map((m) => `${m.oid}\t${m.forMerge ? "" : "not-for-merge"}\t${m.src.startsWith("refs/tags/") ? "tag" : "branch"} '${shortName(m.src)}' of ${shown}\n`);
  writeFileSync(repo.path("FETCH_HEAD"), fh.join(""));
  await t.close?.();
  return { code, adv };
}

export async function cmdFetch(argv: string[], repo: Repo): Promise<number> {
  const p = parseOptions("fetch", argv, [
    { short: "q", long: "quiet", key: "quiet" },
    { short: "p", long: "prune", key: "prune" },
    { short: "v", long: "verbose", key: "verbose" },
    { long: "all", key: "all" },
  ]);
  const reflog = ["fetch", ...argv].join(" ");
  if (p.opts.all) {
    let rc = 0;
    for (const r of remoteNames(repo)) rc |= (await fetchFrom(repo, r, repo.config.get(`remote.${r}.url`)!, [], { quiet: !!p.opts.quiet, prune: !!p.opts.prune, reflog })).code;
    return rc;
  }
  let target = p.args[0];
  if (target === undefined) {
    const cur = head(repo).symref;
    target = (cur && repo.config.get(`branch.${shortRef(cur)}.remote`)) || (remoteNames(repo).includes("origin") ? "origin" : remoteNames(repo)[0]);
    if (!target) die("No remote repository specified.  Please, specify either a URL or a\nremote name from which new revisions should be fetched.");
  }
  const named = remoteNames(repo).includes(target);
  const url = named ? repo.config.get(`remote.${target}.url`)! : target;
  const r = await fetchFrom(repo, named ? target : null, url, p.args.slice(1), { quiet: !!p.opts.quiet, prune: !!p.opts.prune, reflog });
  return r.code;
}
