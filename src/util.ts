// Small shared helpers: cwd changes, path display relative to the current prefix,
// pathspec matching.
// Evidence: fixture repo-git-dir-env ("fatal: cannot change to '%s': %s" for -C);
// fixtures status-subdir-relative / repo-discovery-subdir (paths shown relative to cwd,
// "../" for paths outside it); rea-evidence/findings/03-index-status.md §5 (pathspec
// "did not match any files" fatal in add).
import { die } from "./output.ts";

export function chdirSync(dir: string): void {
  try {
    process.chdir(dir);
  } catch (e: any) {
    die(`cannot change to '${dir}': ${e.code === "ENOENT" ? "No such file or directory" : e.message}`);
  }
}

// Repo-relative path → path relative to prefix ("dir/sub/").
export function relToPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  const pp = prefix.replace(/\/$/, "").split("/");
  const parts = path.split("/");
  let k = 0;
  while (k < pp.length && k < parts.length - (path.endsWith("/") ? 1 : 0) && pp[k] === parts[k]) k++;
  if (k === pp.length && path.startsWith(prefix)) return path.slice(prefix.length) || "./";
  const up = "../".repeat(pp.length - k);
  return up + parts.slice(k).join("/");
}

// Normalize a user path (relative to prefix) into a repo-relative path; "" means root.
export function normPathspec(prefix: string, p: string): string | null {
  const full = (p.startsWith("/") ? p.slice(1) : prefix + p).replace(/\\/g, "/");
  const out: string[] = [];
  for (const s of full.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join("/");
}

const hasGlob = (s: string) => /[*?[]/.test(s);

export function globMatch(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += "[" + pattern.slice(i + 1, end).replace(/^!/, "^") + "]";
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

export interface Pathspec {
  raw: string;
  path: string; // repo-relative ("" = everything)
  glob: boolean;
}

export function makePathspecs(prefix: string, args: string[]): Pathspec[] {
  return args.map((raw) => {
    const path = normPathspec(prefix, raw);
    if (path === null) die(`'${raw}' is outside repository`);
    return { raw, path, glob: hasGlob(raw) };
  });
}

export function matchPathspec(ps: Pathspec, path: string): boolean {
  if (ps.path === "") return true;
  if (path === ps.path || path.startsWith(ps.path + "/")) return true;
  return ps.glob && globMatch(ps.path, path);
}
