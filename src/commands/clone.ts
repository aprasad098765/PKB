// pkb clone
// Observed against git-http-backend (fixtures net-clone-*):
//  - "Cloning into '<dir>'..." on stderr (not with -q); directory defaults to the URL's last
//    path component without ".git"; an existing non-empty directory is fatal
//    ("destination path '%s' already exists and is not an empty directory.");
//  - the received pack is kept with .idx/.rev; remote branches and tags go to packed-refs
//    ("# pack-refs with: peeled fully-peeled sorted "); refs/remotes/origin/HEAD is a symref to
//    the remote's HEAD branch; the checked-out branch is a loose ref; reflogs of HEAD, the
//    branch and origin/HEAD read "clone: from <url without credentials>";
//  - config gains [remote "origin"] url/fetch and [branch "<b>"] remote/merge;
//  - empty remote: "warning: You appear to have cloned an empty repository.";
//  - failures (404, -b missing: "Remote branch %s not found in upstream origin") remove the
//    directory that clone created.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parseOptions } from "../options.ts";
import { requireRepo, toSlash } from "../repo.ts";
import type { Globals } from "../repo.ts";
import { cmdInit } from "./init.ts";
import { openTransport, parseSshUrl } from "../net/transport.ts";
import { receiveObjects } from "./fetch.ts";
import { addRemote, setUpstream, anonymize } from "../remote.ts";
import { setHeadSymref, updateRef } from "../refs.ts";
import { ident } from "../ident.ts";
import { parseCommit } from "../objects.ts";
import { Index } from "../dircache.ts";
import { flattenTree, checkoutFile, indexEntryFromTree, writeTree } from "../worktree.ts";
import { die, err, GitExit } from "../output.ts";
import { chdirSync } from "../util.ts";
import { REPO_DIR } from "../brand.ts";

const ZERO = "0".repeat(40);

export function defaultDir(url: string): string {
  let s = url.replace(/[\\/]+$/, "").replace(new RegExp(`/${REPO_DIR.replace(".", "\\.")}$|/\\.git$`), "");
  s = s.replace(/\.git$/, "");
  const parts = s.split(/[\\/:]/);
  return parts[parts.length - 1] || "repo";
}

export async function cmdClone(argv: string[], _r: unknown, g: Globals): Promise<number> {
  const p = parseOptions("clone", argv, [
    { short: "q", long: "quiet", key: "quiet" },
    { short: "b", long: "branch", arg: "required", key: "branch" },
    { short: "o", long: "origin", arg: "required", key: "origin" },
    { short: "n", long: "no-checkout", key: "noCheckout" },
  ]);
  const url = p.args[0];
  if (!url) die("You must specify a repository to clone.");
  const dir = p.args[1] ?? defaultDir(url);
  const full = resolve(dir);
  const existed = existsSync(full);
  if (existed && readdirSync(full).length) die(`destination path '${dir}' already exists and is not an empty directory.`);
  if (!p.opts.quiet) err(`Cloning into '${dir}'...\n`);
  const origin = (p.opts.origin as string) ?? "origin";
  const startCwd = process.cwd();
  // a local source path is resolved before we change directory
  // URLs and ssh "host:path" forms are kept as given; local paths are made absolute with "/"
  const source = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || parseSshUrl(url) ? url : toSlash(resolve(url));
  mkdirSync(full, { recursive: true });
  try {
    chdirSync(full);
    cmdInit(["-q"], null, g);
    const repo = requireRepo({ configOverrides: g.configOverrides });
    addRemote(repo, origin, source);
    const t = openTransport(source, repo.config);
    const adv = await t.discover("upload");
    const heads = adv.refs.filter((r) => r.name.startsWith("refs/heads/"));
    const headSym = adv.symrefs.get("HEAD");
    const headOid = adv.refs.find((r) => r.name === "HEAD")?.oid;
    const remoteHead = headSym ?? heads.find((h) => h.oid === headOid && /\/(main|master)$/.test(h.name))?.name ?? heads.find((h) => h.oid === headOid)?.name;
    const current = (repo.config.get("init.defaultbranch") ?? "master");
    if (!heads.length) {
      await t.close?.();
      err("warning: You appear to have cloned an empty repository.\n");
      setUpstream(repo, current, origin, `refs/heads/${current}`);
      return 0;
    }
    let branch = remoteHead?.replace(/^refs\/heads\//, "") ?? heads[0].name.slice(11);
    if (p.opts.branch) {
      branch = p.opts.branch;
      if (!heads.some((h) => h.name === `refs/heads/${branch}`)) die(`Remote branch ${branch} not found in upstream ${origin}`);
    }
    const refs = adv.refs.filter((r) => r.name.startsWith("refs/heads/") || r.name.startsWith("refs/tags/"));
    if (t.localObjects) cpSync(t.localObjects, repo.odb.dir, { recursive: true, force: false, errorOnExist: false }); // observed: local clones copy loose objects
    else await receiveObjects(repo, t, refs.map((r) => r.oid), true);
    await t.close?.();
    repo.odb.reloadPacks();

    // packed-refs with remote-tracking branches and tags
    const packed = refs
      .map((r) => ({ name: r.name.startsWith("refs/heads/") ? `refs/remotes/${origin}/${r.name.slice(11)}` : r.name, oid: r.oid, peeled: adv.peeled.get(r.name) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    writeFileSync(repo.path("packed-refs"), "# pack-refs with: peeled fully-peeled sorted \n" + packed.map((r) => `${r.oid} ${r.name}\n${r.peeled ? `^${r.peeled}\n` : ""}`).join(""));
    const msg = `clone: from ${anonymize(source)}`;
    if (remoteHead) {
      const sym = `refs/remotes/${origin}/HEAD`;
      mkdirSync(dirname(repo.path(sym)), { recursive: true });
      writeFileSync(repo.path(sym), `ref: refs/remotes/${origin}/${remoteHead.slice(11)}\n`);
      const log = repo.path("logs", sym);
      mkdirSync(dirname(log), { recursive: true });
      appendFileSync(log, `${ZERO} ${heads.find((h) => h.name === remoteHead)!.oid} ${ident("committer", repo.config, true)}\t${msg}\n`);
    }
    const tip = heads.find((h) => h.name === `refs/heads/${branch}`)!.oid;
    setHeadSymref(repo, `refs/heads/${branch}`);
    updateRef(repo, "HEAD", tip, msg);
    setUpstream(repo, branch, origin, `refs/heads/${branch}`);
    if (!p.opts.noCheckout) {
      const ix = new Index(repo.path("index"));
      ix.lock();
      for (const [path, fe] of flattenTree(repo, parseCommit(repo.odb.read(tip)!.body).tree)) {
        checkoutFile(repo, path, fe.oid, fe.mode);
        ix.entries.push(indexEntryFromTree(repo, path, fe));
      }
      ix.sort();
      writeTree(repo, ix, { repair: true });
      ix.commit();
    }
    return 0;
  } catch (e) {
    chdirSync(startCwd);
    if (e instanceof GitExit && e.code !== 0) {
      if (!existed) rmSync(full, { recursive: true, force: true });
      else for (const f of readdirSync(full)) rmSync(join(full, f), { recursive: true, force: true });
    }
    throw e;
  } finally {
    try { process.chdir(startCwd); } catch {}
  }
}
