// Phase 2: run every scenario against the real git and store golden fixtures.
// Usage: node harness/capture-fixtures.mjs [gitExe] [fixturesDir] [scenarioNameFilter]
// Work happens under %TEMP%\git-rea-fx\<scenario>\repo; nothing else is touched.
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { scenarios as main } from "./scenarios.mjs";
import { holdout } from "./scenarios-holdout.mjs";
import { net } from "./scenarios-net.mjs";
const scenarios = [...main, ...holdout, ...net];
import { runScenario, copyRawGitDir, BASE_EPOCH, TZ } from "./runner.mjs";

const gitExe = process.argv[2] ?? "C:/Program Files/Git/mingw64/bin/git.exe";
const outDir = resolve(process.argv[3] ?? "fixtures");
const filter = process.argv[4];
const tmpRoot = join(tmpdir(), "git-rea-fx");

mkdirSync(outDir, { recursive: true });
const index = [];
for (const sc of scenarios) {
  if (filter && !sc.name.includes(filter)) continue;
  const root = join(tmpRoot, sc.name, "repo");
  const res = runScenario(sc, [gitExe], root);
  const dir = join(outDir, sc.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(res, null, 2) + "\n");
  const hasGit = copyRawGitDir(root, join(dir, "dotgit"));
  index.push({ name: sc.name, covers: sc.covers, steps: res.steps.filter((s) => s.git).map((s) => ({ argv: s.git.join(" "), exit: s.exit })), raw_git_dir: hasGit });
  console.log(`${sc.name.padEnd(28)} ${res.steps.filter((s) => s.git).map((s) => s.exit).join(",")}`);
}
const ver = spawnSync(gitExe, ["--version"], { encoding: "utf8" }).stdout.trim();
writeFileSync(
  join(outDir, "index.json"),
  JSON.stringify({
    captured_with: { exe: gitExe, version: ver, sha256: createHash("sha256").update(readFileSync(gitExe)).digest("hex") },
    pinned: { base_epoch: BASE_EPOCH, step_seconds: 60, tz: TZ, author: "A U Thor <author@example.com>", committer: "C O Mitter <committer@example.com>", GIT_CONFIG_NOSYSTEM: 1 },
    scenarios: index,
  }, null, 2) + "\n",
);
console.log(`${index.length} scenarios -> ${outDir}`);
