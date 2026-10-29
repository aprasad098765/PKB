// Interoperability in both directions between pkb and the real git, which acts as referee.
// pkb keeps git's on-disk formats inside ".pkb", so the real git is pointed at it with
// GIT_DIR=<repo>/.pkb GIT_WORK_TREE=<repo>; pkb output is compared with real git's after rebrand().
//  A. real git builds a repo (and packs it with gc), pkb reads and extends it.
//  B. pkb builds a repo, the real git reads and extends it.
// Each check prints PASS/FAIL; `git fsck --full --strict` must stay clean throughout.
// Usage: node tests/interop.mjs
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { scenarioEnv, startServer, NET_TOKEN } from "../harness/runner.mjs";
import { rebrand } from "../src/brand.ts";

const REAL = "C:/Program Files/Git/mingw64/bin/git.exe";
const PKB = [process.execPath, resolve(import.meta.dirname, "..", "src", "cli.ts")];
let step = 0, fails = 0;

function run(which, root, args, input) {
  const [cmd, ...pre] = which === "real" ? [REAL] : PKB;
  const env = scenarioEnv(root, step++);
  if (which === "real") Object.assign(env, { GIT_DIR: join(root, ".pkb"), GIT_WORK_TREE: root });
  else for (const k of Object.keys(env)) if (k.startsWith("GIT_")) { env["PKB_" + k.slice(4)] = env[k]; delete env[k]; }
  const r = spawnSync(cmd, [...pre, ...args], { cwd: root, env, input: input ?? "", encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, code: r.status };
}
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : "  " + detail}`);
  if (!cond) fails++;
}
function same(name, root, args) {
  const a = run("real", root, args), b = run("pkb", root, args);
  check(`${name}: ${args.join(" ")}`, rebrand(a.out) === b.out && a.code === b.code, `\nreal: ${JSON.stringify(a.out)} (${a.code})\npkb:  ${JSON.stringify(b.out)} (${b.code}) ${b.err}`);
}
function fsck(name, root) {
  const r = run("real", root, ["fsck", "--full", "--strict", "--no-dangling"]);
  check(`${name}: real git fsck`, r.code === 0, r.out + r.err);
}
function fresh(name) {
  const root = join(tmpdir(), "pkb-interop", name, "repo");
  rmSync(join(root, ".."), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}
const w = (root, p, c) => {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), c);
};

// ---- A: real git → pkb ------------------------------------------------------
{
  const r = fresh("real-to-pkb");
  run("real", r, ["init", "-q"]);
  // real git only hides a directory named ".git"; it must be told to ignore ".pkb"
  w(r, ".pkb/info/exclude", "/.pkb/\n");
  w(r, "a.txt", "one\ntwo\n");
  w(r, "src/x.c", "int x;\n");
  run("real", r, ["add", "."]);
  run("real", r, ["commit", "-q", "-m", "c1"]);
  w(r, "a.txt", "one\ntwo\nthree\n");
  run("real", r, ["commit", "-q", "-am", "c2"]);
  run("real", r, ["branch", "side"]);
  run("real", r, ["gc", "-q"]); // objects and refs now live in a pack + packed-refs
  check("A: repository is packed", run("real", r, ["count-objects", "-v"]).out.includes("in-pack: "));
  same("A", r, ["log"]);
  same("A", r, ["log", "--oneline", "side"]);
  same("A", r, ["cat-file", "-p", "HEAD^{tree}"]);
  same("A", r, ["status"]);
  same("A", r, ["branch", "-v"]);
  same("A", r, ["diff", "HEAD~1", "HEAD"]);
  w(r, "b.txt", "new\n");
  check("A: pkb add", run("pkb", r, ["add", "b.txt"]).code === 0);
  check("A: pkb commit", run("pkb", r, ["commit", "-q", "-m", "pkb commit"]).code === 0);
  check("A: pkb switch", run("pkb", r, ["switch", "-q", "side"]).code === 0);
  check("A: pkb merge ff", run("pkb", r, ["merge", "-q", "master"]).code === 0);
  check("A: pkb refuses to delete the current branch", run("pkb", r, ["branch", "-d", "side"]).code === 1);
  run("pkb", r, ["switch", "-q", "master"]);
  check("A: pkb deletes packed branch", run("pkb", r, ["branch", "-d", "side"]).code === 0);
  same("A", r, ["log", "--oneline"]);
  same("A", r, ["status", "--porcelain"]);
  check("A: real git sees pkb commit", run("real", r, ["log", "-1", "--format=%s"]).out === "pkb commit\n");
  check("A: real git status clean", run("real", r, ["status", "--porcelain"]).out === "");
  check("A: packed-refs no longer lists side", !run("real", r, ["branch"]).out.includes("side"));
  fsck("A", r);
}

// ---- B: pkb → real git ------------------------------------------------------
{
  const r = fresh("pkb-to-real");
  run("pkb", r, ["init", "-q"]);
  w(r, "README", "hello\n");
  w(r, "lib/a.js", "export const a = 1;\n");
  // info/exclude is read by both tools (pkb's ignore file is .pkbignore, git's .gitignore)
  w(r, ".pkb/info/exclude", "/.pkb/\n*.log\n");
  w(r, "debug.log", "x\n");
  run("pkb", r, ["add", "."]);
  run("pkb", r, ["commit", "-q", "-m", "pkb root"]);
  run("pkb", r, ["checkout", "-q", "-b", "feature"]);
  w(r, "lib/a.js", "export const a = 2;\n");
  run("pkb", r, ["commit", "-q", "-am", "pkb change"]);
  run("pkb", r, ["switch", "-q", "master"]);
  run("pkb", r, ["merge", "-q", "feature"]);
  fsck("B", r);
  same("B", r, ["log"]);
  same("B", r, ["status"]);
  same("B", r, ["cat-file", "-p", "HEAD"]);
  check("B: real git sees ignored file as ignored", run("real", r, ["status", "--porcelain", "--ignored"]).out.includes("!! debug.log"));
  check("B: real git index readable (ls-files)", run("real", r, ["ls-files"]).out === "README\nlib/a.js\n");
  check("B: real git diff-index clean", run("real", r, ["diff-index", "--quiet", "HEAD"]).code === 0);
  w(r, "README", "hello again\n");
  check("B: real commit on pkb repo", run("real", r, ["commit", "-q", "-am", "real commit"]).code === 0);
  check("B: real checkout on pkb repo", run("real", r, ["checkout", "-q", "feature"]).code === 0);
  check("B: real reflog readable", run("real", r, ["reflog", "-3", "--format=%gs"]).out.split("\n")[1] === "commit: real commit");
  same("B", r, ["log", "--oneline", "master"]);
  same("B", r, ["diff", "master", "feature"]);
  fsck("B", r);
}

// ---- C: pkb reads every object of a delta-heavy pack made by real git ---------
{
  const r = fresh("pack-deltas");
  run("real", r, ["init", "-q"]);
  w(r, ".pkb/info/exclude", "/.pkb/\n");
  for (let i = 0; i < 30; i++) {
    w(r, "big.txt", Array.from({ length: 200 }, (_, k) => `line ${k} ${k % 7 === i % 7 ? "rev" + i : ""}`).join("\n") + "\n");
    w(r, `d${i % 5}/f.txt`, `file ${i}\n`);
    run("real", r, ["add", "."]);
    run("real", r, ["commit", "-q", "-m", `rev ${i}`]);
  }
  run("real", r, ["gc", "-q", "--aggressive"]);
  const all = run("real", r, ["rev-list", "--objects", "--all"]).out.trim().split("\n").map((l) => l.split(" ")[0]);
  const deltas = run("real", r, ["verify-pack", "-v", join(r, ".pkb", "objects", "pack", "*.idx")]);
  let bad = 0;
  for (const oid of all) {
    const a = run("real", r, ["cat-file", "-p", oid]).out, b = run("pkb", r, ["cat-file", "-p", oid]);
    if (a !== b.out) { bad++; if (bad < 3) console.log(`   mismatch ${oid}: ${b.err.split("\n")[0]}`); }
  }
  check(`C: pkb reads all ${all.length} packed objects identically${deltas.code === 0 ? "" : ""}`, bad === 0, `${bad} mismatches`);
  same("C", r, ["log", "--oneline", "-5"]);
  same("C", r, ["diff", "HEAD~3", "HEAD"]);
}

// ---- D: credentials for push (token env var, wrong token, credential helper) ------------
{
  const base = join(tmpdir(), "pkb-interop", "auth");
  rmSync(base, { recursive: true, force: true });
  const srvDir = join(base, "srv");
  mkdirSync(srvDir, { recursive: true });
  spawnSync(REAL, ["init", "-q", "--bare", join(srvDir, "r.git")]);
  const server = startServer(srvDir, "interop-auth");
  const url = `http://127.0.0.1:${server.port}/r.git`;
  try {
    const r = join(base, "w");
    mkdirSync(r, { recursive: true });
    run("pkb", r, ["init", "-q"]);
    w(r, "a", "a\n");
    run("pkb", r, ["add", "a"]);
    run("pkb", r, ["commit", "-q", "-m", "a"]);
    run("pkb", r, ["remote", "add", "origin", url]);
    const withEnv = (extra, args) => {
      const env = scenarioEnv(r, step++);
      for (const k of Object.keys(env)) if (k.startsWith("GIT_")) { env["PKB_" + k.slice(4)] = env[k]; delete env[k]; }
      const res = spawnSync(PKB[0], [...PKB.slice(1), ...args], { cwd: r, env: { ...env, ...extra }, encoding: "utf8" });
      return { out: res.stdout, err: res.stderr, code: res.status };
    };
    const noCred = withEnv({}, ["push", "-u", "origin", "master"]);
    check("D: push without credentials is refused", noCred.code === 128 && /could not read Username/.test(noCred.err), noCred.err);
    const bad = withEnv({ PKB_TOKEN: "wrong" }, ["push", "-u", "origin", "master"]);
    check("D: wrong PKB_TOKEN reports authentication failure", bad.code === 128 && /Authentication failed for/.test(bad.err), bad.err);
    const good = withEnv({ PKB_TOKEN: NET_TOKEN }, ["push", "-u", "origin", "master"]);
    check("D: PKB_TOKEN authenticates push", good.code === 0 && /\[new branch\]/.test(good.err), good.err);
    // credential helper ("!" shell form, git's helper protocol) supplying the token
    const helper = join(base, "helper.cmd");
    writeFileSync(helper, `@echo username=pkb\r\n@echo password=${NET_TOKEN}\r\n`);
    run("pkb", r, ["checkout", "-q", "-b", "viahelper"]);
    w(r, "b", "b\n");
    run("pkb", r, ["add", "b"]);
    run("pkb", r, ["commit", "-q", "-m", "b"]);
    const viaHelper = withEnv({}, ["-c", `credential.helper=!"${helper}"`, "push", "-u", "origin", "viahelper"]);
    check("D: credential.helper authenticates push", viaHelper.code === 0 && /\[new branch\]/.test(viaHelper.err), viaHelper.err);
    const seen = spawnSync(REAL, ["--git-dir", join(srvDir, "r.git"), "branch"], { encoding: "utf8" }).stdout;
    check("D: server received both branches", /master/.test(seen) && /viahelper/.test(seen), seen);
  } finally {
    server.stop();
  }
}

// ---- E: clone works without a configured identity (reflogs fall back like git's) ----------
{
  const r = fresh("no-identity");
  run("pkb", r, ["init", "-q", "src"]);
  w(r, "src/a", "a\n");
  run("pkb", join(r, "src"), ["add", "a"]);
  run("pkb", join(r, "src"), ["commit", "-q", "-m", "a"]);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(PKB|GIT)_/.test(k)) delete env[k];
  env.HOME = env.USERPROFILE = join(r, "nohome");
  env.PKB_CONFIG_GLOBAL = join(r, "nohome", "none");
  const res = spawnSync(PKB[0], [...PKB.slice(1), "clone", "-q", "src", "dst"], { cwd: r, env, encoding: "utf8" });
  check("E: clone without user.name/user.email", res.status === 0, res.stderr);
}

console.log(fails ? `${fails} interop check(s) failed` : "all interop checks passed");
process.exitCode = fails ? 1 : 0;
