// git init
// Evidence (rea-evidence/findings/04-refs-porcelain.md §1): init_db FUN_1402856d0,
//  create_default_files FUN_140285510, probe helpers FUN_140226970:
//  copies the template directory, creates objects/{info,pack} and refs/{heads,tags},
//  writes HEAD "ref: refs/heads/<branch>\n", config [core] repositoryformatversion=0,
//  filemode (probed), bare, logallrefupdates=true (non-bare), symlinks / ignorecase (probed);
//  messages "Initialized empty Git repository in %s%s\n" / "Reinitialized existing ...";
//  the default-branch advice when init.defaultBranch is unset.
// Fixtures: init-default, init-reinit, init-directory, init-quiet-branch, cli-worktree-required.
import { cpSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { Config } from "../config.ts";
import { isGitDir, toSlash } from "../repo.ts";
import type { Globals } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { err, out, die, hint } from "../output.ts";
import { validRefName } from "../refs.ts";
import { env, REPO_DIR } from "../brand.ts";

const TEMPLATE_CANDIDATES = [
  env("TEMPLATE_DIR"),
];
// Fallback content (observed in fixtures/init-default) when no template directory exists.
const DESCRIPTION = "Unnamed repository; edit this file 'description' to name the repository.\n";
const EXCLUDE = "# pkb ls-files --others --exclude-from=.pkb/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n";

function probeIgnoreCase(gitDir: string): boolean {
  try {
    return existsSync(join(gitDir, "CoNfIg"));
  } catch {
    return false;
  }
}

export function cmdInit(argv: string[], _repo: unknown, g: Globals): number {
  const p = parseOptions("init", argv, [
    { short: "q", long: "quiet", key: "quiet" },
    { long: "bare", key: "bare" },
    { long: "template", arg: "required", key: "template" },
    { short: "b", long: "initial-branch", arg: "required", key: "branch" },
    { long: "object-format", arg: "required", key: "objfmt" },
    { long: "ref-format", arg: "required", key: "reffmt" },
    { long: "shared", arg: "optional", key: "shared" },
    { long: "separate-pkb-dir", arg: "required", key: "sep" },
  ]);
  if (p.opts.objfmt && p.opts.objfmt !== "sha1") die(`unknown hash algorithm '${p.opts.objfmt}'`);
  if (p.opts.reffmt && p.opts.reffmt !== "files") die(`unknown ref storage format '${p.opts.reffmt}'`);
  if (p.args.length > 1) die("too many arguments"); // unverified wording
  const bare = !!(p.opts.bare || g.bare);
  let dir = process.cwd();
  if (p.args[0] !== undefined) {
    dir = resolve(p.args[0]);
    mkdirSync(dir, { recursive: true });
  }
  const gitDirEnv = g.gitDir ?? env("DIR");
  const gitDir = gitDirEnv ? resolve(dir, gitDirEnv) : bare ? dir : join(dir, REPO_DIR);
  const reinit = isGitDir(gitDir);
  const global = Config.load(null, g.configOverrides);
  mkdirSync(gitDir, { recursive: true });

  // templates
  const tdir = p.opts.template ?? global.get("init.templatedir") ?? TEMPLATE_CANDIDATES.find((d) => d && existsSync(d));
  if (tdir && existsSync(tdir)) {
    cpSync(tdir, gitDir, { recursive: true, force: false, errorOnExist: false });
  } else if (!reinit) {
    if (!existsSync(join(gitDir, "description"))) writeFileSync(join(gitDir, "description"), DESCRIPTION);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    if (!existsSync(join(gitDir, "info", "exclude"))) writeFileSync(join(gitDir, "info", "exclude"), EXCLUDE);
  }
  for (const d of ["objects/info", "objects/pack", "refs/heads", "refs/tags"]) mkdirSync(join(gitDir, d), { recursive: true });

  let branch = p.opts.branch as string | undefined;
  if (branch !== undefined && !validRefName(branch)) die(`invalid initial branch name: '${branch}'`);
  if (!existsSync(join(gitDir, "HEAD"))) {
    const dflt = global.get("init.defaultbranch");
    if (branch === undefined && dflt === undefined && !p.opts.quiet) {
      hint([
        "Using 'master' as the name for the initial branch. This default branch name",
        "will change to \"main\" in a future pkb release. To configure the initial branch name",
        "to use in all of your new repositories, which will suppress this warning,",
        "call:",
        "",
        "\tpkb config --global init.defaultBranch <name>",
        "",
        "Names commonly chosen instead of 'master' are 'main', 'trunk' and",
        "'development'. The just-created branch can be renamed via this command:",
        "",
        "\tpkb branch -m <name>",
        "",
      ], global.bool("advice.defaultbranchname", true) ? "defaultBranchName" : undefined);
    }
    writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch ?? dflt ?? "master"}\n`);
  } else if (branch !== undefined && reinit) {
    err(`warning: re-init: ignored --initial-branch=${branch}\n`);
  }

  if (!existsSync(join(gitDir, "config")) || !reinit) {
    const win = process.platform === "win32";
    let cfg = "[core]\n\trepositoryformatversion = 0\n";
    let filemode = !win;
    if (!win) {
      try {
        const f = join(gitDir, "config.probe");
        writeFileSync(f, "", { mode: 0o644 });
        chmodSync(f, 0o755);
        filemode = (statSync(f).mode & 0o100) !== 0;
        rmSync(f);
      } catch {}
    }
    cfg += `\tfilemode = ${filemode}\n\tbare = ${bare}\n`;
    if (!bare) cfg += "\tlogallrefupdates = true\n";
    writeFileSync(join(gitDir, "config"), cfg);
    if (win) cfg += "\tsymlinks = false\n";
    if (probeIgnoreCase(gitDir)) cfg += "\tignorecase = true\n";
    writeFileSync(join(gitDir, "config"), cfg);
  }

  if (!p.opts.quiet) {
    const shown = toSlash(gitDir).replace(/\/$/, "") + "/";
    out(`${reinit ? "Reinitialized existing" : "Initialized empty"} pkb repository in ${shown}\n`);
  }
  return 0;
}
