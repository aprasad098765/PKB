// parse-options compatible argument parsing.
// Evidence: rea-evidence/findings/01-dispatcher.md §D (usage_with_options exits 129);
// observed messages (fixtures init-bad-option, usage-texts): "error: unknown option `%s'"
// for long options, "error: unknown switch `%c'" for short ones, followed by the command's
// usage block on stderr; "-h" prints the usage block on stdout and exits 129.
import { USAGE, USAGE_ERR } from "./usage-text.ts";
import { err, out, GitExit } from "./output.ts";

export interface OptSpec {
  short?: string;
  long?: string;
  arg?: "required" | "optional" | "none";
  key: string;
  multi?: boolean;
  negatable?: boolean;
  num?: boolean; // -<n> numeric shorthand (log -3)
}

export interface Parsed {
  opts: Record<string, any>;
  args: string[];
  dashdash: number; // index into args where "--" appeared, or -1
}

export function usageError(cmd: string, msg: string | null): never {
  if (msg) err(`error: ${msg}\n`);
  const u = USAGE_ERR[cmd] ?? USAGE[cmd];
  if (u) err(u);
  else err(`usage: pkb ${cmd} [<options>]\n\n`);
  throw new GitExit(129);
}

export function parseOptions(cmd: string, argv: string[], specs: OptSpec[], opts: { stopAtNonOption?: boolean; keepUnknownDash?: boolean } = {}): Parsed {
  const res: Parsed = { opts: {}, args: [], dashdash: -1 };
  const set = (s: OptSpec, v: any) => {
    if (s.multi) (res.opts[s.key] ??= []).push(v);
    else res.opts[s.key] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      res.dashdash = res.args.length;
      res.args.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" && argv.length === 1) {
      out(USAGE[cmd] ?? `usage: pkb ${cmd}\n`);
      throw new GitExit(129);
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      let name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      let neg = false;
      let s = specs.find((x) => x.long === name);
      if (!s && name.startsWith("no-")) {
        s = specs.find((x) => x.long === name.slice(3) && (x.negatable ?? x.arg !== "required"));
        neg = !!s;
      }
      if (!s) {
        // unique prefix abbreviation
        const c = specs.filter((x) => x.long?.startsWith(name));
        if (c.length === 1) s = c[0];
      }
      if (!s) {
        if (opts.keepUnknownDash) {
          res.args.push(a);
          continue;
        }
        usageError(cmd, `unknown option \`${name}'`);
      }
      if (neg) set(s, s.arg === "required" ? null : false);
      else if (!s.arg || s.arg === "none") {
        if (eq >= 0) usageError(cmd, `option \`${name}' takes no value`);
        set(s, true);
      } else if (eq >= 0) set(s, a.slice(eq + 1));
      else if (s.arg === "optional") set(s, true);
      else {
        if (i + 1 >= argv.length) usageError(cmd, `option \`${name}' requires a value`);
        set(s, argv[++i]);
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (/^-\d+$/.test(a)) {
        const s = specs.find((x) => x.num);
        if (s) {
          set(s, a.slice(1));
          continue;
        }
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const s = specs.find((x) => x.short === c);
        if (!s) {
          if (opts.keepUnknownDash) {
            res.args.push(a);
            break;
          }
          usageError(cmd, `unknown switch \`${c}'`);
        }
        if (!s.arg || s.arg === "none") {
          set(s, true);
          continue;
        }
        const rest = a.slice(j + 1);
        if (rest) set(s, rest);
        else if (s.arg === "optional") set(s, true);
        else {
          if (i + 1 >= argv.length) usageError(cmd, `switch \`${c}' requires a value`);
          set(s, argv[++i]);
        }
        break;
      }
      continue;
    }
    res.args.push(a);
    if (opts.stopAtNonOption) {
      res.args.push(...argv.slice(i + 1));
      break;
    }
  }
  return res;
}
