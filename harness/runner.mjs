// Runs one scenario against a git implementation and snapshots the result.
// Shared by Phase 2 (golden capture with the real git) and Phase 4 (parity).
//
// Determinism: every step gets its own pinned author/committer date
// (BASE_EPOCH + 60*stepIndex, +0530), identity, empty global config and no
// system config, so object ids and reflogs are reproducible across runs.
// Paths under the scenario root are rewritten to <ROOT> in captured output.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync, cpSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const REAL_GIT = "C:/Program Files/Git/mingw64/bin/git.exe";
export const NET_TOKEN = "s3cret-token";
const SERVER = join(import.meta.dirname, "http-server.mjs");
const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");

// Network scenarios (scenario.net): a local smart-HTTP server (real git-http-backend) serves
// bare repos from <base>/srv; {seed:[...]} steps run the real git in <base>/seed as "another
// collaborator"; {srv:[...]} steps run the real git in <base>/srv. In arguments, {URL} becomes
// http://127.0.0.1:<port> and {AUTH} the same URL carrying the push token as credentials.
export function startServer(srvDir, name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const port = 17000 + (h % 2000);
  const log = join(srvDir, "..", "server.log");
  writeFileSync(log, "");
  const fd = openSync(log, "a");
  const child = spawn(process.execPath, [SERVER, srvDir, String(port), NET_TOKEN], { stdio: ["ignore", fd, fd], windowsHide: true });
  const until = Date.now() + 10000;
  while (!readFileSync(log, "utf8").includes("listening")) {
    if (Date.now() > until) throw new Error("test server did not start");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return { port, stop: () => { try { process.kill(child.pid); } catch {} closeSync(fd); } };
}

export const BASE_EPOCH = 1700000000;
export const TZ = "+0530";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function scenarioEnv(root, stepIndex) {
  const date = `${BASE_EPOCH + 60 * stepIndex} ${TZ}`;
  const home = join(root, "..", "home");
  mkdirSync(home, { recursive: true });
  const globalCfg = join(home, ".gitconfig");
  if (!existsSync(globalCfg)) writeFileSync(globalCfg, "");
  const env = {};
  // Keep only what Windows needs to start a process; drop any GIT_* from the caller.
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "PATH", "Path", "PATHEXT", "COMSPEC", "TEMP", "TMP"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "C O Mitter",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    GIT_COMMITTER_DATE: date,
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "false",
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
  });
  return env;
}

function normalizer(root) {
  const fwd = root.replace(/\\/g, "/");
  const variants = [...new Set([root, fwd, fwd.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)])];
  return (s) => {
    for (const v of variants) {
      const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      s = s.replace(re, "<ROOT>");
    }
    return s;
  };
}

// Step kinds: {git:[...], cwd?, stdin?} | {write:path, content} | {rm:path} | {mkdir:path}
// opts.brand: run pkb instead of git; arguments and written paths go through rebrand()
// (".gitignore" -> ".pkbignore", "--git-dir=.git" -> "--pkb-dir=.pkb") and GIT_* variables
// are passed as PKB_*.
export function runScenario(scenario, gitCmd, root, opts = {}) {
  const map = opts.brand ?? ((x) => x);
  rmSync(dirname(root), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  root = realpathSync.native(root);
  const base = dirname(root);
  let server = null;
  let subst = (a) => a;
  let norm = normalizer(root);
  if (scenario.net) {
    for (const d of ["srv", "seed"]) mkdirSync(join(base, d), { recursive: true });
    server = startServer(join(base, "srv"), scenario.name);
    const host = `127.0.0.1:${server.port}`;
    subst = (a) => a.replaceAll("{URL}", `http://${host}`).replaceAll("{AUTH}", `http://pkb:${NET_TOKEN}@${host}`).replaceAll("{SSH}", "ssh://localhost").replaceAll("{SCP}", "localhost:");
    const n0 = norm;
    norm = (s) => n0(s).replaceAll(`pkb:${NET_TOKEN}@`, "<CRED>@").replaceAll(host, "<HOST>").split(base.replace(/\\/g, "/")).join("<BASE>").split(base).join("<BASE>");
  }
  const steps = [];
  try {
  scenario.steps.forEach((step, i) => {
    if (step.seed || step.srv) {
      const cwd = join(base, step.seed ? "seed" : "srv", step.cwd ?? ".");
      mkdirSync(cwd, { recursive: true });
      const r = spawnSync(REAL_GIT, (step.seed ?? step.srv).map(subst), { cwd, env: scenarioEnv(join(base, "seed"), i), input: "", windowsHide: true });
      steps.push({ [step.seed ? "seed" : "srv"]: step.seed ?? step.srv, exit: r.status });
      return;
    }
    if (step.seedWrite !== undefined) {
      const p = join(base, "seed", step.seedWrite);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.content);
      steps.push({ seedWrite: step.seedWrite });
      return;
    }
    if (step.write !== undefined) {
      const p = join(root, map(step.write));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.content);
      steps.push({ write: step.write });
    } else if (step.rm !== undefined) {
      rmSync(join(root, map(step.rm)), { recursive: true, force: true });
      steps.push({ rm: step.rm });
    } else if (step.mkdir !== undefined) {
      mkdirSync(join(root, step.mkdir), { recursive: true });
      steps.push({ mkdir: step.mkdir });
    } else if (step.git) {
      const cwd = join(root, step.cwd ?? ".");
      mkdirSync(cwd, { recursive: true });
      const env = scenarioEnv(root, i);
      // ssh remotes go through harness/fake-ssh.mjs, which runs the real git service locally
      if (scenario.net) Object.assign(env, { GIT_SSH_COMMAND: `"${process.execPath}" "${FAKE_SSH}"`, GIT_SSH_VARIANT: "ssh", FAKE_SSH_ROOT: join(base, "srv") });
      if (opts.brand) for (const k of Object.keys(env)) if (k.startsWith("GIT_")) { env["PKB_" + k.slice(4)] = env[k]; delete env[k]; }
      const r = spawnSync(gitCmd[0], [...gitCmd.slice(1), ...step.git.map(map).map(subst)], {
        cwd,
        env,
        input: Buffer.from(step.stdin ?? "", "utf8"),
        
        windowsHide: true,
      });
      if (r.error) throw r.error;
      steps.push({
        git: step.git,
        cwd: step.cwd ?? ".",
        stdout: norm(r.stdout.toString("utf8")),
        stderr: norm(r.stderr.toString("utf8")),
        exit: r.status,
      });
    } else throw new Error(`bad step in ${scenario.name}: ${JSON.stringify(step)}`);
  });
  } finally {
    server?.stop();
  }
  const result = { name: scenario.name, covers: scenario.covers, steps, snapshot: snapshot(root, norm) };
  // server-side state: refs and HEAD of every bare repo (objects are the server's business)
  if (scenario.net) result.remote = snapshot(join(base, "srv"), norm).filter((f) => /\.git\/(HEAD|packed-refs|refs\/.+)$/.test(f.path) && !f.dir);
  return result;
}

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ path: relative(base, p).split(sep).join("/") + "/", dir: true });
      walk(p, base, out);
    } else out.push({ path: relative(base, p).split(sep).join("/"), dir: false });
  }
  return out;
}

// Parse index v2/v3 with stat fields dropped (ctime/mtime/dev/ino/uid/gid are host-specific).
export function parseIndex(buf) {
  if (buf.toString("latin1", 0, 4) !== "DIRC") return { error: "bad signature" };
  const version = buf.readUInt32BE(4), count = buf.readUInt32BE(8);
  let o = 12;
  const entries = [];
  for (let n = 0; n < count; n++) {
    const mode = buf.readUInt32BE(o + 24), size = buf.readUInt32BE(o + 36);
    const oid = buf.toString("hex", o + 40, o + 60), flags = buf.readUInt16BE(o + 60);
    let nameStart = o + 62;
    if (flags & 0x4000) nameStart += 2;
    const nameEnd = buf.indexOf(0, nameStart);
    const path = buf.toString("utf8", nameStart, nameEnd);
    entries.push({ mode: mode.toString(8), size, oid, stage: (flags >> 12) & 3, flags_namelen: flags & 0xfff, path });
    o += ((nameEnd - o + 8) & ~7);
  }
  const extensions = [];
  while (o < buf.length - 20) {
    const sig = buf.toString("latin1", o, o + 4), len = buf.readUInt32BE(o + 4);
    const data = buf.subarray(o + 8, o + 8 + len);
    // EOIE carries an offset that depends on entry bytes only; IEOT likewise. Keep hex for both.
    extensions.push({ sig, len, data_hex: data.toString("hex") });
    o += 8 + len;
  }
  return { version, count, entries, extensions, trailer_ok: sha1(buf.subarray(0, buf.length - 20)) === buf.toString("hex", buf.length - 20) };
}
const sha1 = (b) => createHash("sha1").update(b).digest("hex");

function describeObject(raw) {
  try {
    const inf = inflateSync(raw);
    const nul = inf.indexOf(0);
    const header = inf.toString("latin1", 0, nul);
    const body = inf.subarray(nul + 1);
    const [type] = header.split(" ");
    let content;
    if (type === "tree") {
      content = [];
      let p = 0;
      while (p < body.length) {
        const sp = body.indexOf(0x20, p), z = body.indexOf(0, sp);
        content.push(`${body.toString("latin1", p, sp)} ${body.toString("utf8", sp + 1, z)} ${body.toString("hex", z + 1, z + 21)}`);
        p = z + 21;
      }
    } else content = body.toString("utf8");
    return { header, oid: sha1(inf), content, zlib_header_hex: raw.subarray(0, 2).toString("hex") };
  } catch (e) {
    return { error: String(e) };
  }
}

const TEXT_FILES = /^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|COMMIT_EDITMSG|config|description|packed-refs|info\/exclude|refs\/.*|logs\/.*)$/;

export function snapshot(root, norm = (s) => s) {
  const files = [];
  for (const e of walk(root)) {
    if (e.dir) { files.push({ path: e.path, dir: true }); continue; }
    const buf = readFileSync(join(root, e.path));
    const rec = { path: e.path, size: buf.length, sha256: sha256(buf) };
    const inGit = e.path.match(/^(?:.*\/)?\.(?:git|pkb)\/(.*)$/) ?? (e.path.match(/^(HEAD|config|objects\/.*|refs\/.*|logs\/.*|index|description|info\/.*|COMMIT_EDITMSG|ORIG_HEAD)$/) && [null, e.path]);
    const gp = inGit ? inGit[1] : null;
    if (gp === "index") rec.index = parseIndex(buf);
    else if (gp && /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(gp)) rec.object = describeObject(buf);
    else if (gp && gp.startsWith("hooks/")) { /* template samples: identity by sha256 only */ }
    else if (gp && TEXT_FILES.test(gp)) rec.text = norm(buf.toString("utf8"));
    else if (!gp) rec.text = buf.toString("utf8"); // work-tree file
    files.push(rec);
  }
  return files;
}

export function copyRawGitDir(root, dest) {
  rmSync(dest, { recursive: true, force: true });
  const subs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== ".git" && e.name !== ".pkb");
  const nested = subs.flatMap((e) => [join(root, e.name, ".git"), join(root, e.name, ".pkb")]);
  for (const cand of [join(root, ".git"), join(root, ".pkb"), root, ...nested]) {
    if (existsSync(join(cand, "HEAD")) && statSync(join(cand, "objects")).isDirectory()) {
      cpSync(cand, dest, { recursive: true });
      return true;
    }
  }
  return false;
}
