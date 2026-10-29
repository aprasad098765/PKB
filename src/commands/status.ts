// git status
// Evidence: rea-evidence/findings/03-index-status.md §6 (cmd_status 0x14002fbf0, option bits
//  0x09: RUN_SETUP | NEED_WORK_TREE; -s/--short, -b/--branch, --porcelain[=v1]);
//  exit status always 0 (fixtures status-*). Printers live in ../wtstatus.ts.
import type { Repo } from "../repo.ts";
import { parseOptions, usageError } from "../options.ts";
import { collectStatus, printLong, printShort } from "../wtstatus.ts";
import { out } from "../output.ts";

export function cmdStatus(argv: string[], repo: Repo): number {
  const p = parseOptions("status", argv, [
    { short: "s", long: "short", key: "short" },
    { short: "b", long: "branch", key: "branch" },
    { long: "porcelain", arg: "optional", key: "porcelain" },
    { long: "long", key: "long" },
    { short: "u", long: "untracked-files", arg: "optional", key: "untracked" },
  ]);
  if (p.opts.porcelain && p.opts.porcelain !== true && p.opts.porcelain !== "v1" && p.opts.porcelain !== "1") usageError("status", `unsupported porcelain version '${p.opts.porcelain}'`);
  const showUntracked = p.opts.untracked === undefined || (p.opts.untracked !== "no" && p.opts.untracked !== false);
  const st = collectStatus(repo, undefined, { untracked: showUntracked });
  if (p.opts.porcelain) out(printShort(repo, st, { branch: !!p.opts.branch, porcelain: true }));
  else if (p.opts.short && !p.opts.long) out(printShort(repo, st, { branch: !!p.opts.branch, porcelain: false }));
  else out(printLong(repo, st, false));
  return 0;
}
