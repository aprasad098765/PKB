// pkb config: get / set / unset / list, classic and subcommand syntax.
// Observed (fixture config-cmd, git 2.52): builtin option bits 0x12 (repository optional);
//  "pkb config <key>" prints the value or exits 1 silently; "<key> <value>" writes the local
//  file ("fatal: not in a git directory" outside a repository); --global uses the user file;
//  "--list"/"list" prints "section.key=value" (global first, then local); "--unset" of a missing
//  key exits 5; "error: key does not contain a section: %s" exits 1; values with quotes, ';' or
//  '#' are written quoted; unsetting the last key of a section removes the section.
//  Newer syntax: "config get|set|unset|list [--global|--local] ...".
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { Repo, Globals } from "../repo.ts";
import { Config, configSet, configUnset, configEntries } from "../config.ts";
import { CONFIG_FILE, XDG_DIR } from "../brand.ts";
import { die, err, out, GitExit } from "../output.ts";
import { usageError } from "../options.ts";
import { USAGE } from "../usage-text.ts";

export function globalConfigFile(): string {
  const e = process.env;
  if (e.PKB_CONFIG_GLOBAL !== undefined) return e.PKB_CONFIG_GLOBAL;
  const home = e.HOME ?? homedir();
  const xdg = join(e.XDG_CONFIG_HOME ?? join(home, ".config"), XDG_DIR, "config");
  const dot = join(home, CONFIG_FILE);
  return !existsSync(dot) && existsSync(xdg) ? xdg : dot;
}

function checkKey(key: string): void {
  if (!key.includes(".") || key.startsWith(".")) {
    err(`error: key does not contain a section: ${key}\n`);
    throw new GitExit(1);
  }
  if (!/^[A-Za-z][\w-]*(\..+)?\.[A-Za-z][\w-]*$/.test(key)) {
    err(`error: invalid key: ${key}\n`);
    throw new GitExit(1);
  }
}

export function cmdConfig(argv: string[], repo: Repo | null, g: Globals): number {
  type Action = "get" | "set" | "unset" | "list";
  let action: Action | null = null;
  let scope: "global" | "local" | null = null;
  const rest: string[] = [];
  const args = [...argv];
  if (args.length === 1 && args[0] === "-h") {
    out(USAGE.config);
    throw new GitExit(129);
  }
  if (["get", "set", "unset", "list"].includes(args[0])) action = args.shift() as Action;
  for (const a of args) {
    if (a === "--global") scope = "global";
    else if (a === "--local") scope = "local";
    else if (a === "--system") die("the system config is not used by pkb");
    else if (a === "--get") action = "get";
    else if (a === "--unset") action = "unset";
    else if (a === "--list" || a === "-l") action = "list";
    else if (a.startsWith("-") && a !== "-") usageError("config", `unknown option \`${a.replace(/^--?/, "")}'`);
    else rest.push(a);
  }
  if (!action) action = rest.length >= 2 ? "set" : rest.length === 1 ? "get" : null;
  if (!action) usageError("config", null);
  const localFile = repo ? repo.path("config") : null;
  const fileFor = (write: boolean) => {
    if (scope === "global") return globalConfigFile();
    if (!localFile) {
      if (write || scope === "local") die("not in a pkb directory");
      return null;
    }
    return localFile;
  };

  switch (action) {
    case "list": {
      const files = scope === "global" ? [globalConfigFile()] : scope === "local" ? [fileFor(false)!] : [globalConfigFile(), ...(localFile ? [localFile] : [])];
      for (const f of files) for (const [k, v] of configEntries(f)) out(`${k}=${v}\n`);
      if (!scope) for (const o of g.configOverrides) out(`${o.includes("=") ? o : o + "=true"}\n`);
      return 0;
    }
    case "get": {
      const key = rest[0];
      if (!key) usageError("config", null);
      checkKey(key);
      const cfg = scope === "global" ? Config.load(null, []) : scope === "local" ? configFromFile(fileFor(false)!) : (repo?.config ?? Config.load(null, g.configOverrides));
      const v = scope === "global" ? configFromFile(globalConfigFile()).get(key) : cfg.get(key);
      if (v === undefined) return 1;
      out(v + "\n");
      return 0;
    }
    case "set": {
      const [key, value] = rest;
      if (key === undefined || value === undefined) usageError("config", null);
      checkKey(key);
      const file = fileFor(true)!;
      mkdirSync(dirname(file), { recursive: true });
      configSet(file, repo?.config ?? new Config(), key, value);
      return 0;
    }
    case "unset": {
      const key = rest[0];
      if (!key) usageError("config", null);
      checkKey(key);
      return configUnset(fileFor(true)!, repo?.config ?? null, key) ? 0 : 5;
    }
  }
}

function configFromFile(file: string): Config {
  const c = new Config();
  for (const [k, v] of configEntries(file)) (c.map.get(k) ?? c.map.set(k, []).get(k)!).push(v);
  return c;
}
