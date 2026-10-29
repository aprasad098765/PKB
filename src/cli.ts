#!/usr/bin/env node
// Entry point and builtin dispatcher.
// Evidence (rea-evidence/findings/01-dispatcher.md, rea-evidence/cmd-table.json):
//  §A cmd_main FUN_140002f80 → handle_options FUN_1400019d0 (global options -C, -c,
//     --git-dir, --work-tree, --bare, -p/-P/--no-pager, --version, --help).
//  §B builtin table @0x14032e000 {name, fn, option}: option bits RUN_SETUP 0x01,
//     RUN_SETUP_GENTLY 0x02, USE_PAGER 0x04, NEED_WORK_TREE 0x08, NO_PARSEOPT 0x20;
//     run_builtin FUN_140001480 returns the builtin's result as the exit status.
//  §C NEED_WORK_TREE without one: "this operation must be run in a work tree" (128).
//  §F unknown command FUN_14019f280: "git: '%s' is not a git command. See 'git --help'." (1),
//     with "The most similar command is" suggestions (fixture cli-unknown-command).
//  Bare `git` prints the common-command help to stdout and exits 1 (fixture cli-no-args).
import { chdirSync } from "./util.ts";
import { err, out, flush, GitExit, die } from "./output.ts";
import { discover, requireRepo } from "./repo.ts";
import type { Globals, Repo } from "./repo.ts";
import { NAME, VERSION, HELP as PKB_HELP } from "./brand.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdHashObject } from "./commands/hash-object.ts";
import { cmdCatFile } from "./commands/cat-file.ts";
import { cmdAdd } from "./commands/add.ts";
import { cmdWriteTree } from "./commands/write-tree.ts";
import { cmdCommit } from "./commands/commit.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdLog } from "./commands/log.ts";
import { cmdDiff } from "./commands/diff.ts";
import { cmdBranch } from "./commands/branch.ts";
import { cmdCheckout, cmdSwitch } from "./commands/checkout.ts";
import { cmdMerge } from "./commands/merge.ts";
import { cmdClone } from "./commands/clone.ts";
import { cmdFetch } from "./commands/fetch.ts";
import { cmdPush } from "./commands/push.ts";
import { cmdRemote } from "./commands/remote.ts";
import { cmdPull } from "./commands/pull.ts";
import { shutdownTransports } from "./net/transport.ts";

export const GIT_VERSION = VERSION;


const RUN_SETUP = 0x01, RUN_SETUP_GENTLY = 0x02, NEED_WORK_TREE = 0x08;

type Handler = (args: string[], repo: Repo | null, g: Globals) => number | Promise<number>;
// name -> [handler, option bits as decoded from the builtin table]
const BUILTINS: Record<string, [Handler, number]> = {
  "add": [cmdAdd as Handler, 0x09],
  "branch": [cmdBranch as Handler, 0x11],
  "cat-file": [cmdCatFile as Handler, 0x01],
  "checkout": [cmdCheckout as Handler, 0x09],
  "commit": [cmdCommit as Handler, 0x09],
  "diff": [cmdDiff, 0x20],
  "hash-object": [cmdHashObject, 0x00],
  "init": [cmdInit, 0x00],
  "log": [cmdLog as Handler, 0x01],
  "merge": [cmdMerge as Handler, 0x09],
  "status": [cmdStatus as Handler, 0x09],
  "switch": [cmdSwitch as Handler, 0x09],
  "version": [() => (out(`${NAME} version ${GIT_VERSION}\n`), 0), 0x00],
  "write-tree": [cmdWriteTree as Handler, 0x01],
  // network commands (bits as in the builtin table: clone 0x00, fetch/push/remote RUN_SETUP)
  "clone": [cmdClone as Handler, 0x00],
  "fetch": [cmdFetch as Handler, 0x01],
  "push": [cmdPush as Handler, 0x01],
  "remote": [cmdRemote as Handler, 0x01],
  "pull": [cmdPull as Handler, 0x09],
  "help": [() => (out(PKB_HELP), 0), 0x00],
};

function allCommandNames(): string[] {
  return Object.keys(BUILTINS);
}

// Weighted Damerau-Levenshtein (swap, substitution, insertion, deletion).
function editDistance(a: string, b: string, w = 0, s = 2, ins = 1, del = 4): number {
  const r0 = new Array(b.length + 1).fill(0), r1 = r0.map((_, j) => j * ins);
  let prev2 = r0, prev = r1;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i * del;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : s);
      if (i > 1 && j > 1 && a[i - 2] === b[j - 1] && a[i - 1] === b[j - 2]) cur[j] = Math.min(cur[j], prev2[j - 2] + w);
      cur[j] = Math.min(cur[j], prev[j] + del, cur[j - 1] + ins);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

function unknownCommand(cmd: string): number {
  err(`${NAME}: '${cmd}' is not a ${NAME} command. See '${NAME} --help'.\n`);
  const names = [...new Set(allCommandNames())];
  const scored = names.map((n) => ({ n, d: n.startsWith(cmd) ? 0 : editDistance(cmd, n) + 1 })).sort((x, y) => x.d - y.d || (x.n < y.n ? -1 : 1));
  const best = scored[0]?.d ?? 99;
  if (best < 7) {
    const sims = scored.filter((x) => x.d === best).map((x) => x.n);
    err(`\nThe most similar command${sims.length > 1 ? "s are" : " is"}\n${sims.map((n) => `\t${n}\n`).join("")}`);
  }
  return 1;
}

export function main(argv: string[]): number | Promise<number> {
  const g: Globals = { configOverrides: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) break;
    if (a === "-C") {
      const dir = argv[++i];
      if (dir === undefined) die("no directory given for '-C' option");
      if (dir) chdirSync(dir);
    } else if (a === "-c") g.configOverrides.push(argv[++i] ?? "");
    else if (a.startsWith("--pkb-dir=")) g.gitDir = a.slice(10);
    else if (a === "--pkb-dir") g.gitDir = argv[++i];
    else if (a.startsWith("--work-tree=")) g.workTree = a.slice(12);
    else if (a === "--work-tree") g.workTree = argv[++i];
    else if (a === "--bare") g.bare = true;
    else if (["-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--no-optional-locks", "--no-advice", "--literal-pathspecs"].includes(a)) continue;
    else if (a === "--version" || a === "-v") return BUILTINS.version[0]([], null, g);
    else if (a === "--help" || a === "-h") return out(PKB_HELP), 0;
    else {
      err(`unknown option: ${a}\n`);
      err(PKB_HELP.slice(0, PKB_HELP.indexOf("\n\n") + 1));
      return 129;
    }
  }
  const cmd = argv[i];
  const args = argv.slice(i + 1);
  if (cmd === undefined) {
    out(PKB_HELP);
    return 1;
  }
  const b = BUILTINS[cmd];
  if (!b) return unknownCommand(cmd);
  const [fn, bits] = b;
  let repo: Repo | null = null;
  if (args.length === 1 && args[0] === "-h") {
    return fn(args, null, g);
  }
  if (bits & RUN_SETUP) repo = requireRepo(g);
  else if (bits & RUN_SETUP_GENTLY) repo = discover(g);
  if (bits & NEED_WORK_TREE && repo && repo.bare) die("this operation must be run in a work tree");
  return fn(args, repo, g);
}

async function run(): Promise<void> {
  let code = 0;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof GitExit) code = e.code;
    else {
      err(`fatal: ${(e as Error).stack ?? e}\n`);
      code = 128;
    }
  }
  shutdownTransports();
  flush();
  process.exitCode = code;
}

run();
