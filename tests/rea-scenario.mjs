// End-to-end scenario for REA capture_process_scenario, run once with the real git and once
// with pkb, so verify_reconstruction can compare REA Evidence of the two (terminal + exit).
// Prints every command's stdout/stderr/exit, then a digest of the resulting repository state
// that excludes host-specific bytes (index stat data, zlib stream bytes). The real git's text
// goes through rebrand(), so identical output means pkb matches git modulo its name.
// Usage: node tests/rea-scenario.mjs <real|pkb>
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { scenarioEnv, parseIndex } from "../harness/runner.mjs";
import { rebrand } from "../src/brand.ts";

const real = process.argv[2] === "real";
const cmd = real ? ["C:/Program Files/Git/mingw64/bin/git.exe"] : [process.execPath, resolve(import.meta.dirname, "..", "src", "cli.ts")];
const root = join(tmpdir(), "pkb-reacap", real ? "real" : "pkb", "repo");
const repoDir = join(root, real ? ".git" : ".pkb");
const map = real ? rebrand : (x) => x;
rmSync(join(root, ".."), { recursive: true, force: true });
mkdirSync(root, { recursive: true });
let i = 0;
const out = [];
const vcs = (...args) => {
  const env = scenarioEnv(root, i++);
  if (!real) for (const k of Object.keys(env)) if (k.startsWith("GIT_")) { env["PKB_" + k.slice(4)] = env[k]; delete env[k]; }
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], { cwd: root, env, encoding: "utf8" });
  const norm = (s) => map(s.split(root.replace(/\\/g, "/")).join("<ROOT>").split(root).join("<ROOT>"));
  out.push(`$ ${args.join(" ")}  [exit ${r.status}]`, norm(r.stdout).trimEnd(), norm(r.stderr).trimEnd().replace(/^/gm, "! "));
};
const w = (p, c) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); };

vcs("init", "-q");
w("a.txt", "one\ntwo\nthree\n"); w("src/m.c", "int main(void)\n{\n\treturn 0;\n}\n"); w("x.o", "bin\n");
// info/exclude rather than an ignore file, so both runs commit identical trees
writeFileSync(join(repoDir, "info", "exclude"), "*.o\n");
vcs("status", "-s"); vcs("add", "."); vcs("commit", "-m", "initial");
vcs("checkout", "-b", "topic"); w("a.txt", "one\nTWO\nthree\nfour\n"); vcs("diff"); vcs("commit", "-am", "topic work");
vcs("switch", "master"); vcs("merge", "topic"); vcs("log", "--oneline"); vcs("branch", "-v"); vcs("branch", "-d", "topic");
vcs("cat-file", "-p", "HEAD^{tree}"); vcs("status"); vcs("log", "-1");

// repository-state digest (objects by inflated content; refs/logs/HEAD by bytes)
const walk = (d, rel = "") => readdirSync(d).sort().flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), rel + n + "/") : [rel + n]));
for (const f of walk(repoDir)) {
  if (!/^(objects\/[0-9a-f]{2}\/|refs\/|logs\/|HEAD$|ORIG_HEAD$|index$)/.test(f)) continue;
  const buf = readFileSync(join(repoDir, f));
  if (f.startsWith("objects/")) out.push(`${f} inflated-sha1=${createHash("sha1").update(inflateSync(buf)).digest("hex")}`);
  else if (f === "index") { const ix = parseIndex(buf); out.push(`index v${ix.version} ${ix.entries.map((e) => `${e.mode} ${map(e.path)}`).join(", ")}`); }
  else out.push(`${f} sha256=${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
}
process.stdout.write(out.filter((l) => l !== "").join("\n") + "\n");
