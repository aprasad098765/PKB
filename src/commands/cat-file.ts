// git cat-file
// Evidence (rea-evidence/findings/02-objects.md §6): cmd_cat_file 0x14001a690, RUN_SETUP;
//  -t prints "%s\n", -s prints "%I64u\n", -e exits 0/1 silently, -p pretty-prints
//  (trees as "%06o %s %s\t%s"), "<type> <object>" prints the raw body.
// Observed (fixtures cat-file, cat-file-missing-full-hex): "Not a valid object name %s",
//  "git cat-file: could not get object info" (-t/-s on a missing full hex),
//  "git cat-file %s: bad file" (type mismatch), usage + 129 with no arguments.
import type { Repo } from "../repo.ts";
import { parseOptions, usageError } from "../options.ts";
import { resolveRev, peel } from "../revparse.ts";
import { parseTree, isTreeMode } from "../objects.ts";
import { die, err, out, exit } from "../output.ts";
import { OBJ_TYPES } from "../odb.ts";
import type { ObjType } from "../odb.ts";

export function cmdCatFile(argv: string[], repo: Repo): number {
  const p = parseOptions("cat-file", argv, [
    { short: "t", key: "t" },
    { short: "s", key: "s" },
    { short: "e", key: "e" },
    { short: "p", key: "p" },
  ]);
  const mode = p.opts.t ? "t" : p.opts.s ? "s" : p.opts.e ? "e" : p.opts.p ? "p" : null;
  let type: string | null = null, name: string;
  if (mode) {
    if (p.args.length === 0) {
      // observed (fixture ho-errors): "fatal: <object> required with '-t'" + blank line + usage, 129
      err(`fatal: <object> required with '-${mode}'\n\n`);
      usageError("cat-file", null);
    }
    if (p.args.length !== 1) usageError("cat-file", null);
    name = p.args[0];
  } else {
    if (p.args.length !== 2) usageError("cat-file", null);
    [type, name] = p.args;
    if (!OBJ_TYPES.includes(type as ObjType)) die(`invalid object type "${type}"`);
  }
  const oid = resolveRev(repo, name);
  if (!oid) {
    if (mode === "e") exit(1);
    die(`Not a valid object name ${name}`);
  }
  const obj = repo.odb.read(oid);
  if (!obj) {
    if (mode === "e") exit(1);
    if (mode === "t" || mode === "s") die("pkb cat-file: could not get object info");
    die(`Not a valid object name ${name}`);
  }
  switch (mode) {
    case "e":
      return 0;
    case "t":
      out(obj.type + "\n");
      return 0;
    case "s":
      out(obj.body.length + "\n");
      return 0;
    case "p":
      if (obj.type === "tree") {
        for (const e of parseTree(obj.body)) {
          const t = isTreeMode(e.mode) ? "tree" : e.mode === "160000" ? "commit" : "blob";
          out(`${e.mode.padStart(6, "0")} ${t} ${e.oid}\t${e.name}\n`);
        }
      } else out(obj.body);
      return 0;
  }
  // "<type> <object>": peel to the requested type, raw body
  const want = peel(repo, oid, type!);
  if (!want) die(`pkb cat-file ${name}: bad file`);
  out(repo.odb.read(want)!.body);
  return 0;
}
