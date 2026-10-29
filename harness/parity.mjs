// Phase 4: run every scenario against the reimplementation and diff it with the golden
// fixture captured from the real git: stdout, stderr, exit code per step, and the resulting
// .git + work tree (file set, refs/logs/config text, inflated objects, parsed index).
// Then runs the real `git fsck --full` on each repository the reimplementation produced.
// Usage: node harness/parity.mjs [filter] [--verbose]
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { scenarios as main } from "./scenarios.mjs";
import { holdout } from "./scenarios-holdout.mjs";
import { net } from "./scenarios-net.mjs";
const scenarios = [...main, ...holdout, ...net];
import { runScenario } from "./runner.mjs";
import { rebrand, HELP, NAME, VERSION } from "../src/brand.ts";

// pkb is a rebranded git: the expectation for each step is the real-git fixture passed
// through rebrand(). Two outputs are pkb's own by design (its help lists only pkb's
// commands; its version is pkb's), and pkb does not copy git's sample hooks into new repos.
const OWN_OUTPUT = {
  "": { stdout: HELP },
  "--version": { stdout: `${NAME} version ${VERSION}\n` },
  "version": { stdout: `${NAME} version ${VERSION}\n` },
};
function expectFor(fx) {
  const steps = fx.steps.map((s) => {
    if (!s.git) return s;
    const t = { ...s, stdout: rebrand(s.stdout), stderr: rebrand(s.stderr) };
    // over ssh the server's own stderr (real git-upload-pack) is relayed verbatim: keep its wording
    if (s.git.some((a) => a.includes("{SSH}") || a.includes("{SCP}"))) {
      const server = s.stderr.split("\n").filter((l) => /does not appear to be a git repository$/.test(l) && /'<BASE>/.test(l));
      for (const l of server) t.stderr = t.stderr.replace(rebrand(l), l);
    }
    return Object.assign(t, OWN_OUTPUT[s.git.join(" ")] ?? {});
  });
  const snapshot = fx.snapshot
    .filter((f) => !/(^|\/)(\.git\/)?hooks\//.test(f.path))
    .map((f) => {
      const g = { ...f, path: rebrand(f.path) };
      // repository files (".git/..." or, in a bare repo, the top level) are rebranded; work-tree files are data
      if (g.text !== undefined && (/(^|\/)\.git\//.test(f.path) || /^(info|logs|refs)\/|^(HEAD|config|description)$/.test(f.path))) g.text = rebrand(g.text);
      if (g.index) g.index = { ...g.index, entries: g.index.entries.map((e) => ({ ...e, path: rebrand(e.path) })) };
      return g;
    });
  return { ...fx, steps, snapshot };
}

const REAL_GIT = "C:/Program Files/Git/mingw64/bin/git.exe";
const ROOT = resolve(import.meta.dirname, "..");
const IMPL = [process.execPath, join(ROOT, "src", "cli.ts")];
const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith("--"));
const verbose = args.includes("--verbose");

function parseTreeExt(hex) {
  const buf = Buffer.from(hex, "hex");
  let p = 0;
  const nodes = new Map();
  const read = (prefix) => {
    const nul = buf.indexOf(0, p);
    const name = buf.toString("utf8", p, nul);
    p = nul + 1;
    const nl = buf.indexOf(10, p);
    const [cnt, sub] = buf.toString("latin1", p, nl).split(" ").map(Number);
    p = nl + 1;
    let oid = null;
    if (cnt >= 0) { oid = buf.toString("hex", p, p + 20); p += 20; }
    const path = prefix + name;
    nodes.set(path, { cnt, sub, oid });
    for (let i = 0; i < sub; i++) read(path + (path || name ? "/" : ""));
  };
  if (buf.length) read("");
  return nodes;
}

// Compare TREE extensions leniently: same node paths, and every node valid on both sides
// carries the same tree oid (validity itself depends on racy timestamps in the real git).
function treeExtDiff(a, b) {
  const ta = a ? parseTreeExt(a.data_hex) : null, tb = b ? parseTreeExt(b.data_hex) : null;
  if (!ta && !tb) return null;
  if (!ta || !tb) return `TREE extension ${ta ? "missing in impl" : "unexpected in impl"}`;
  for (const [k, v] of ta) {
    const w = tb.get(k);
    if (!w) return `TREE node '${k}' missing`;
    if (v.oid && w.oid && v.oid !== w.oid) return `TREE node '${k}' oid ${v.oid} vs ${w.oid}`;
  }
  for (const k of tb.keys()) if (!ta.has(k)) return `TREE node '${k}' unexpected`;
  return null;
}

function compareSnapshots(want, got) {
  const diffs = [];
  const W = new Map(want.map((f) => [f.path, f])), G = new Map(got.map((f) => [f.path, f]));
  let objBytesSame = 0, objTotal = 0;
  for (const [p, w] of W) {
    const g = G.get(p);
    if (!g) { diffs.push(`missing ${p}`); continue; }
    if (w.dir) continue;
    if (w.object) {
      objTotal++;
      if (w.sha256 === g.sha256) objBytesSame++;
      if (JSON.stringify(w.object.content) !== JSON.stringify(g.object?.content) || w.object.header !== g.object?.header) diffs.push(`object ${p} differs`);
      continue;
    }
    if (w.index) {
      const wi = w.index, gi = g.index;
      if (!gi || gi.error) { diffs.push(`index unreadable`); continue; }
      if (wi.version !== gi.version) diffs.push(`index version ${wi.version} vs ${gi.version}`);
      const strip = (e) => ({ mode: e.mode, oid: e.oid, stage: e.stage, path: e.path, size: e.size });
      if (JSON.stringify(wi.entries.map(strip)) !== JSON.stringify(gi.entries.map(strip))) diffs.push(`index entries differ`);
      const t = treeExtDiff(wi.extensions.find((e) => e.sig === "TREE"), gi.extensions.find((e) => e.sig === "TREE"));
      if (t) diffs.push(`index ${t}`);
      if (!gi.trailer_ok) diffs.push("index checksum invalid");
      continue;
    }
    if (w.text !== undefined) {
      if (w.text !== g.text) diffs.push(`content ${p} differs`);
    } else if (w.sha256 !== g.sha256) diffs.push(`bytes ${p} differ`);
  }
  for (const p of G.keys()) if (!W.has(p)) diffs.push(`unexpected ${p}`);
  return { diffs, objBytesSame, objTotal };
}

// Real `git fsck` on every repository pkb produced: <root>/.pkb, <root>/<dir>/.pkb (clones,
// "init sub") and a bare <root>.
function fsck(root) {
  const subs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name, ".pkb"));
  const dirs = [join(root, ".pkb"), ...subs, root].filter((d) => existsSync(join(d, "HEAD")) && existsSync(join(d, "objects")));
  if (!dirs.length) return null;
  const res = dirs.map((d) => spawnSync(REAL_GIT, ["--git-dir", d, "fsck", "--full", "--strict", "--no-dangling"], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }));
  const bad = res.find((r) => r.status !== 0);
  return { exit: bad ? bad.status : 0, repos: dirs.length, output: bad ? (bad.stdout + bad.stderr).trim() : "" };
}

const report = { generated: new Date().toISOString(), impl: "node src/cli.ts", scenarios: [] };
let pass = 0, stepsOk = 0, stepsTotal = 0, objSame = 0, objTotal = 0, fsckOk = 0, fsckRun = 0;
for (const sc of scenarios) {
  if (filter && !sc.name.includes(filter)) continue;
  const fx = join(ROOT, "fixtures", sc.name, "result.json");
  if (!existsSync(fx)) continue;
  const want = expectFor(JSON.parse(readFileSync(fx, "utf8")));
  const root = join(tmpdir(), "git-rea-parity", sc.name, "repo");
  const got = runScenario(sc, IMPL, root, { brand: rebrand });
  const stepDiffs = [];
  want.steps.forEach((w, i) => {
    if (!w.git) return;
    stepsTotal++;
    const g = got.steps[i];
    const d = [];
    if (w.exit !== g.exit) d.push(`exit ${w.exit} vs ${g.exit}`);
    if (w.stdout !== g.stdout) d.push("stdout");
    if (w.stderr !== g.stderr) d.push("stderr");
    if (d.length) stepDiffs.push({ step: i, argv: w.git.join(" "), diff: d, want: { stdout: w.stdout, stderr: w.stderr }, got: { stdout: g.stdout, stderr: g.stderr } });
    else stepsOk++;
  });
  const snap = compareSnapshots(want.snapshot, got.snapshot);
  objSame += snap.objBytesSame;
  objTotal += snap.objTotal;
  const fk = fsck(root);
  if (fk) { fsckRun++; if (fk.exit === 0) fsckOk++; }
  const ok = !stepDiffs.length && !snap.diffs.length && (!fk || fk.exit === 0);
  if (ok) pass++;
  report.scenarios.push({ name: sc.name, covers: sc.covers, ok, stepDiffs, snapshotDiffs: snap.diffs, fsck: fk, objectsByteIdentical: `${snap.objBytesSame}/${snap.objTotal}` });
  console.log(`${ok ? "PASS" : "FAIL"} ${sc.name}${ok ? "" : `  steps:${stepDiffs.map((s) => `[${s.argv}: ${s.diff.join(",")}]`).join(" ")} snap:${snap.diffs.slice(0, 4).join("; ")}${fk && fk.exit ? " fsck:" + fk.output.split("\n")[0] : ""}`}`);
  if (verbose && !ok) for (const s of stepDiffs) console.log(`--- ${s.argv}\nWANT out:${JSON.stringify(s.want.stdout)}\n     err:${JSON.stringify(s.want.stderr)}\nGOT  out:${JSON.stringify(s.got.stdout)}\n     err:${JSON.stringify(s.got.stderr)}`);
}
report.summary = { scenarios: report.scenarios.length, passed: pass, steps: `${stepsOk}/${stepsTotal}`, objects_byte_identical: `${objSame}/${objTotal}`, fsck_clean: `${fsckOk}/${fsckRun}` };
writeFileSync(join(ROOT, "tests", "parity-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.summary));
process.exitCode = pass === report.scenarios.length ? 0 : 1;
