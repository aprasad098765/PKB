// Process output and exit handling.
// Evidence: rea-evidence/findings/01-dispatcher.md §D — die() (FUN_1402c4300) writes
// "fatal: " + message to stderr and exits 128; usage_with_options (FUN_1402c45d0)
// exits 129; error() prefixes "error: " and returns -1 (callers map to exit 1).
// Fixtures: cli-not-a-repo, add-unmatched, init-bad-option.
import { writeSync } from "node:fs";

let outBuf: (string | Buffer)[] = [];
let errBuf: string[] = [];

export class GitExit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function out(s: string | Buffer): void {
  outBuf.push(s);
}
export function err(s: string): void {
  errBuf.push(s);
}

export function die(msg: string): never {
  err(`fatal: ${msg}\n`);
  throw new GitExit(128);
}
export function error(msg: string): void {
  err(`error: ${msg}\n`);
}
export function warning(msg: string): void {
  err(`warning: ${msg}\n`);
}
export function hint(lines: string[], adviceKey?: string): void {
  for (const l of lines) err(l === "" ? "hint:\n" : `hint: ${l}\n`);
  if (adviceKey) err(`hint: Disable this message with "pkb config set advice.${adviceKey} false"\n`);
}
export function exit(code: number): never {
  throw new GitExit(code);
}

function writeAll(fd: number, parts: (string | Buffer)[]): void {
  const buf = Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : p)));
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e: any) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EPIPE") return;
      throw e;
    }
  }
}

export function flush(): void {
  if (outBuf.length) writeAll(1, outBuf);
  if (errBuf.length) writeAll(2, errBuf);
  outBuf = [];
  errBuf = [];
}
