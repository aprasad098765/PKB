// Remotes, refspecs, upstream tracking and ahead/behind reporting.
// Observed (fixtures net-*): clone writes [remote "origin"] url + fetch
// "+refs/heads/*:refs/remotes/origin/*" and [branch "<b>"] remote/merge; status prints
// "Your branch is up to date with 'origin/master'." / "is ahead of ... by N commit(s)." /
// "is behind ... by N commit(s), and can be fast-forwarded." / "... have diverged,\nand have
// A and B different commits each, respectively." with their hints; short status shows
// "## master...origin/master [ahead 1, behind 1]"; branch -vv shows "[origin/master: ahead 1]".
// URLs are shown without credentials; fetch output and FETCH_HEAD also drop a ".git" suffix.
import type { Repo } from "./repo.ts";
import { resolveRef } from "./refs.ts";
import { parseCommit } from "./objects.ts";
import { configSet } from "./config.ts";
import { NAME } from "./brand.ts";

export interface Refspec {
  force: boolean;
  src: string;
  dst: string | null;
}

export function parseRefspec(s: string): Refspec {
  const force = s.startsWith("+");
  if (force) s = s.slice(1);
  const c = s.indexOf(":");
  return c < 0 ? { force, src: s, dst: null } : { force, src: s.slice(0, c), dst: s.slice(c + 1) };
}

// Map `ref` through a (possibly globbed) refspec; null when it does not match.
export function mapRef(spec: Refspec, ref: string): string | null {
  if (!spec.dst) return null;
  const star = spec.src.indexOf("*");
  if (star < 0) return ref === spec.src ? spec.dst : null;
  const pre = spec.src.slice(0, star), post = spec.src.slice(star + 1);
  if (!ref.startsWith(pre) || !ref.endsWith(post) || ref.length < pre.length + post.length) return null;
  return spec.dst.replace("*", ref.slice(pre.length, ref.length - post.length));
}

export function remoteNames(repo: Repo): string[] {
  const out = new Set<string>();
  for (const k of repo.config.map.keys()) {
    const m = k.match(/^remote\.(.+)\.url$/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

export function fetchSpecs(repo: Repo, remote: string): Refspec[] {
  const v = repo.config.map.get(`remote.${remote}.fetch`);
  return (v ?? []).map(parseRefspec);
}

export function addRemote(repo: Repo, name: string, url: string): void {
  const f = repo.path("config");
  configSet(f, repo.config, `remote.${name}.url`, url);
  configSet(f, repo.config, `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`);
}

export function setUpstream(repo: Repo, branch: string, remote: string, mergeRef: string): void {
  const f = repo.path("config");
  configSet(f, repo.config, `branch.${branch}.remote`, remote);
  configSet(f, repo.config, `branch.${branch}.merge`, mergeRef);
}

export interface Upstream {
  remote: string;
  merge: string; // refs/heads/x on the remote
  tracking: string; // local ref, e.g. refs/remotes/origin/x
  short: string; // origin/x
}

export function upstreamOf(repo: Repo, branch: string): Upstream | null {
  const remote = repo.config.get(`branch.${branch}.remote`);
  const merge = repo.config.get(`branch.${branch}.merge`);
  if (!remote || !merge) return null;
  let tracking: string | null = remote === "." ? merge : null;
  for (const s of remote === "." ? [] : fetchSpecs(repo, remote)) {
    tracking = mapRef(s, merge);
    if (tracking) break;
  }
  if (!tracking) return null;
  return { remote, merge, tracking, short: tracking.replace(/^refs\/(remotes|heads)\//, "") };
}

// Tracking ref for a remote branch name ("side" -> refs/remotes/origin/side) if exactly one remote has it.
export function uniqueRemoteBranch(repo: Repo, name: string): { remote: string; ref: string } | null {
  const hits: { remote: string; ref: string }[] = [];
  for (const r of remoteNames(repo)) {
    for (const s of fetchSpecs(repo, r)) {
      const local = mapRef(s, `refs/heads/${name}`);
      if (local && resolveRef(repo, local)?.oid) hits.push({ remote: r, ref: local });
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

// For a tracking ref "refs/remotes/<r>/<b>": the remote and its branch, via the fetch refspecs.
export function remoteOfTrackingRef(repo: Repo, ref: string): { remote: string; merge: string } | null {
  for (const r of remoteNames(repo)) {
    for (const s of fetchSpecs(repo, r)) {
      if (!s.dst) continue;
      const inv = mapRef({ force: s.force, src: s.dst, dst: s.src }, ref);
      if (inv) return { remote: r, merge: inv };
    }
  }
  return null;
}

function ancestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const st = [tip];
  while (st.length) {
    const o = st.pop()!;
    if (seen.has(o)) continue;
    const obj = repo.odb.read(o);
    if (!obj) continue;
    seen.add(o);
    st.push(...parseCommit(obj.body).parents);
  }
  return seen;
}

export function aheadBehind(repo: Repo, ours: string, theirs: string): { ahead: number; behind: number } {
  const a = ancestors(repo, ours), b = ancestors(repo, theirs);
  let ahead = 0, behind = 0;
  for (const o of a) if (!b.has(o)) ahead++;
  for (const o of b) if (!a.has(o)) behind++;
  return { ahead, behind };
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

// Long tracking paragraph (status / checkout). `hints` adds the "(use ...)" lines.
export function trackingLong(repo: Repo, branch: string, headOid: string | null, hints = true): string | null {
  const up = upstreamOf(repo, branch);
  if (!up) return null;
  const t = resolveRef(repo, up.tracking)?.oid;
  if (!t) {
    return `Your branch is based on '${up.short}', but the upstream is gone.\n` + (hints ? `  (use "${NAME} branch --unset-upstream" to fixup)\n` : "");
  }
  if (!headOid) return null;
  const { ahead, behind } = aheadBehind(repo, headOid, t);
  if (!ahead && !behind) return `Your branch is up to date with '${up.short}'.\n`;
  if (ahead && !behind) return `Your branch is ahead of '${up.short}' by ${commits(ahead)}.\n` + (hints ? `  (use "${NAME} push" to publish your local commits)\n` : "");
  if (!ahead && behind) return `Your branch is behind '${up.short}' by ${commits(behind)}, and can be fast-forwarded.\n` + (hints ? `  (use "${NAME} pull" to update your local branch)\n` : "");
  return `Your branch and '${up.short}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n` + (hints ? `  (use "${NAME} pull" if you want to integrate the remote branch with yours)\n` : "");
}

// "origin/master [ahead 1, behind 2]" pieces for short status / branch -vv.
export function trackingShort(repo: Repo, branch: string, headOid: string | null): { name: string; detail: string } | null {
  const up = upstreamOf(repo, branch);
  if (!up) return null;
  const t = resolveRef(repo, up.tracking)?.oid;
  if (!t) return { name: up.short, detail: "gone" };
  if (!headOid) return { name: up.short, detail: "" };
  const { ahead, behind } = aheadBehind(repo, headOid, t);
  const parts = [ahead ? `ahead ${ahead}` : "", behind ? `behind ${behind}` : ""].filter(Boolean);
  return { name: up.short, detail: parts.join(", ") };
}

// URL helpers
export function anonymize(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}
export function fetchDisplayUrl(url: string): string {
  return anonymize(url).replace(/\/+$/, "").replace(/\.git$/, "");
}
