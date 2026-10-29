// Repository discovery and the Repo handle.
// Evidence (rea-evidence/findings/01-dispatcher.md):
//  §H setup_git_directory (FUN_140282bf0): GIT_DIR / --git-dir first; otherwise walk
//     upward from cwd testing "<dir>/.git" (directory, or a file holding "gitdir: <path>")
//     and then "<dir>" itself as a bare repo; GIT_CEILING_DIRECTORIES stops the walk.
//  §E not-a-repo message "not a git repository (or any of the parent directories): .git"
//     from FUN_140284380, exit 128. Fixtures: cli-not-a-repo, repo-discovery-subdir,
//     repo-git-dir-env, cli-worktree-required.
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, delimiter, isAbsolute } from "node:path";
import { Config } from "./config.ts";
import { ObjectDB } from "./odb.ts";
import { die } from "./output.ts";
import { env, REPO_DIR, GITDIR_FILE_KEY } from "./brand.ts";

export const toSlash = (p: string) => p.replace(/\\/g, "/");

export function isGitDir(d: string): boolean {
  try {
    return existsSync(join(d, "HEAD")) && statSync(join(d, "objects")).isDirectory() && statSync(join(d, "refs")).isDirectory();
  } catch {
    return false;
  }
}

function realdir(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export interface Globals {
  gitDir?: string;
  workTree?: string;
  configOverrides: string[];
  bare?: boolean;
}

export class Repo {
  gitDir: string;
  workTree: string | null;
  prefix: string; // cwd relative to work tree, "" or "dir/sub/"
  config: Config;
  odb: ObjectDB;

  constructor(gitDir: string, workTree: string | null, prefix: string, config: Config) {
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.prefix = prefix;
    this.config = config;
    this.odb = new ObjectDB(env("OBJECT_DIRECTORY") ?? join(gitDir, "objects"));
  }

  get bare(): boolean {
    return this.workTree === null;
  }

  wt(): string {
    if (this.workTree === null) die("this operation must be run in a work tree");
    return this.workTree;
  }

  path(...p: string[]): string {
    return join(this.gitDir, ...p);
  }
}

function findRepo(cwd: string): { gitDir: string; top: string | null } | null {
  const ceilings = (env("CEILING_DIRECTORIES") ?? "").split(delimiter).filter(Boolean).map((c) => realdir(c).toLowerCase());
  let d = cwd;
  for (;;) {
    const dotgit = join(d, REPO_DIR);
    if (existsSync(dotgit)) {
      const st = statSync(dotgit);
      if (st.isDirectory() && isGitDir(dotgit)) return { gitDir: dotgit, top: d };
      if (st.isFile()) {
        const m = readFileSync(dotgit, "utf8").match(new RegExp(`^${GITDIR_FILE_KEY}: (.*?)\\r?\\n?$`, "m"));
        if (m) {
          const gd = isAbsolute(m[1]) ? m[1] : resolve(d, m[1]);
          if (isGitDir(gd)) return { gitDir: realdir(gd), top: d };
        }
      }
    }
    if (isGitDir(d)) return { gitDir: d, top: null };
    const parent = dirname(d);
    if (parent === d || ceilings.includes(parent.toLowerCase())) return null;
    d = parent;
  }
}

function prefixOf(top: string, cwd: string): string {
  const rel = toSlash(relative(top, cwd));
  if (!rel) return "";
  if (rel.startsWith("..")) return "";
  return rel + "/";
}

// Returns null when not inside a repository (gentle setup).
export function discover(g: Globals): Repo | null {
  const cwd = realdir(process.cwd());
  const envGitDir = g.gitDir ?? env("DIR");
  let gitDir: string;
  let top: string | null;
  if (envGitDir) {
    gitDir = realdir(resolve(cwd, envGitDir));
    if (!isGitDir(gitDir)) die(`not a pkb repository: '${envGitDir}'`);
    top = cwd;
  } else {
    const f = findRepo(cwd);
    if (!f) return null;
    gitDir = f.gitDir;
    top = f.top;
  }
  const config = Config.load(gitDir, g.configOverrides);
  const wtOverride = g.workTree ?? env("WORK_TREE") ?? config.get("core.worktree");
  if (wtOverride) top = realdir(resolve(envGitDir ? cwd : gitDir, wtOverride));
  else if (config.bool("core.bare", false) || g.bare) top = null;
  else if (top === null && !envGitDir) top = null;
  return new Repo(gitDir, top, top ? prefixOf(top, cwd) : "", config);
}

export function requireRepo(g: Globals): Repo {
  const r = discover(g);
  if (!r) die("not a pkb repository (or any of the parent directories): .pkb");
  return r;
}
