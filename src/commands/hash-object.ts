// git hash-object
// Evidence (rea-evidence/findings/02-objects.md §6): cmd_hash_object 0x14006c780, option
//  bits 0x00 (does its own gentle setup; -w needs a repository); options -t, -w, --stdin,
//  --stdin-paths, --literally; prints "<oid>\n" per input.
// Observed: "could not open '%s' for reading: %s" and 'invalid object type "%s"' (fatal),
//  -w outside a repo → not-a-repo fatal (fixtures hash-object, hash-object-outside-repo).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { discover } from "../repo.ts";
import type { Globals } from "../repo.ts";
import { hashObject, OBJ_TYPES } from "../odb.ts";
import type { ObjType } from "../odb.ts";
import { parseOptions } from "../options.ts";
import { die, err, out } from "../output.ts";

export function cmdHashObject(argv: string[], _r: unknown, g: Globals): number {
  const p = parseOptions("hash-object", argv, [
    { short: "t", arg: "required", key: "type" },
    { short: "w", key: "write" },
    { long: "stdin", key: "stdin" },
    { long: "stdin-paths", key: "stdinPaths" },
    { long: "literally", key: "literally" },
    { long: "no-filters", key: "noFilters" },
    { long: "path", arg: "required", key: "path" },
  ]);
  const type = (p.opts.type ?? "blob") as string;
  if (!OBJ_TYPES.includes(type as ObjType) && !p.opts.literally) die(`invalid object type "${type}"`);
  const repo = p.opts.write ? discover(g) : discover(g);
  if (p.opts.write && !repo) die("not a pkb repository (or any of the parent directories): .pkb");
  const emit = (data: Buffer) => {
    // Without --literally, commits are checked like fsck does (fixture ho-plumbing).
    if (type === "commit" && !p.opts.literally && !/^tree [0-9a-f]{40}\n/.test(data.toString("latin1"))) {
      err("error: object fails fsck: missingTree: invalid format - expected 'tree' line\n");
      die("refusing to create malformed object");
    }
    const oid = p.opts.write ? repo!.odb.write(type as ObjType, data) : hashObject(type, data).oid;
    out(oid + "\n");
  };
  if (p.opts.stdin) emit(readFileSync(0));
  const files = [...p.args];
  if (p.opts.stdinPaths) files.push(...readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean));
  for (const f of files) {
    let data: Buffer;
    try {
      data = readFileSync(resolve(f));
    } catch (e: any) {
      die(`could not open '${f}' for reading: ${e.code === "ENOENT" ? "No such file or directory" : e.message}`);
    }
    emit(data);
  }
  return 0;
}
