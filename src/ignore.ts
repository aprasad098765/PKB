// Exclude rules: core.excludesFile, $GIT_DIR/info/exclude, per-directory .gitignore.
// Evidence: rea-evidence/findings/03-index-status.md §5 (add consults the exclude list and
// reports "The following paths are ignored by one of your .gitignore files:" + advice
// addIgnoredFile; fixture add-ignored); §6 status hides ignored paths (fixture add-ignored).
// Pattern semantics (negation, trailing '/', anchoring when a '/' is present, '**')
// implemented from the documented gitignore format; later/deeper rules win.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "./repo.ts";
import { XDG_DIR, IGNORE_FILE } from "./brand.ts";

interface Rule {
  base: string; // directory of the .gitignore ("" for root-level sources)
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
}

export function globToRegex(glob: string, icase: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atStart && atEnd) {
          if (i + 2 === glob.length) re += ".*";
          else re += "(?:.*/)?";
          i += 2;
          continue;
        }
        i++;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let cls = glob.slice(i + 1, end);
        if (cls[0] === "!") cls = "^" + cls.slice(1);
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, icase ? "i" : "");
}

function parseRules(text: string, base: string, icase: boolean): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ base, re: globToRegex(line, icase), negate, dirOnly, anchored });
  }
  return rules;
}

export class Excludes {
  private repo: Repo;
  private icase: boolean;
  private global: Rule[] = [];
  private perDir = new Map<string, Rule[]>();

  constructor(repo: Repo) {
    this.repo = repo;
    this.icase = repo.config.bool("core.ignorecase", false);
    const env = process.env;
    const xdg = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, XDG_DIR, "ignore") : env.HOME ? join(env.HOME, ".config", XDG_DIR, "ignore") : null;
    const ex = repo.config.get("core.excludesfile")?.replace(/^~(?=\/)/, env.HOME ?? "") ?? xdg;
    for (const f of [ex, repo.path("info", "exclude")]) {
      if (f && existsSync(f)) this.global.push(...parseRules(readFileSync(f, "utf8"), "", this.icase));
    }
  }

  private rulesFor(dir: string): Rule[] {
    let r = this.perDir.get(dir);
    if (!r) {
      const f = join(this.repo.wt(), dir, IGNORE_FILE);
      r = existsSync(f) ? parseRules(readFileSync(f, "utf8"), dir, this.icase) : [];
      this.perDir.set(dir, r);
    }
    return r;
  }

  private matchOne(path: string, isDir: boolean): boolean | null {
    const slash = path.lastIndexOf("/");
    const dirs: string[] = [""];
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
    const all = [...this.global, ...dirs.flatMap((d) => this.rulesFor(d))];
    let result: boolean | null = null;
    for (const r of all) {
      if (r.dirOnly && !isDir) continue;
      const rel = r.base ? (path.startsWith(r.base + "/") ? path.slice(r.base.length + 1) : null) : path;
      if (rel === null) continue;
      const subject = r.anchored ? rel : path.slice(slash + 1);
      if (r.re.test(subject)) result = !r.negate;
    }
    return result;
  }

  // A path is ignored if it, or any parent directory, is excluded.
  isIgnored(path: string, isDir: boolean): boolean {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (this.matchOne(parts.slice(0, i).join("/"), true)) return true;
    }
    return this.matchOne(path, isDir) === true;
  }
}
