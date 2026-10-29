// Author/committer identity and dates.
// Evidence: rea-evidence/findings/04-refs-porcelain.md §3 (commit uses fmt_ident with
// GIT_AUTHOR_* / GIT_COMMITTER_* env, falling back to user.name/user.email config);
// §7 log date format "%.3s %.3s %d %02d:%02d:%02d %d %+05d" rendered in the
// author's own zone — fixture log-history ("Wed Nov 15 03:52:20 2023 +0530").
import { die, err, GitExit } from "./output.ts";
import { userInfo, hostname } from "node:os";
import type { Config } from "./config.ts";

export function tzToMinutes(tz: string): number {
  const sign = tz[0] === "-" ? -1 : 1;
  return sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
}

function localTz(epoch: number): string {
  const off = -new Date(epoch * 1000).getTimezoneOffset();
  const a = Math.abs(off);
  return `${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}

// Accepts "<epoch> <tz>", "@<epoch> [<tz>]", ISO-8601 "YYYY-MM-DD[T ]HH:MM[:SS] [tz]" and RFC 2822.
export function parseDate(s: string): { time: number; tz: string } | null {
  s = s.trim();
  let m = s.match(/^@?(\d+)(?:\s+([+-]\d{4}))?$/);
  if (m) {
    const t = Number(m[1]);
    return { time: t, tz: m[2] ?? localTz(t) };
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const tz = m[7] === undefined ? null : m[7] === "Z" ? "+0000" : m[7].replace(":", "");
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
    if (tz) return { time: utc - tzToMinutes(tz) * 60, tz };
    const local = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime() / 1000;
    return { time: local, tz: localTz(local) };
  }
  const d = Date.parse(s);
  if (!isNaN(d)) {
    const tzm = s.match(/([+-]\d{4})\s*$/);
    const t = Math.floor(d / 1000);
    return { time: t, tz: tzm ? tzm[1] : localTz(t) };
  }
  return null;
}

// lenient: reflog entries never fail for lack of an identity; like git they fall back to the
// login name and "<user>@<host>" (only commits insist on a configured identity).
export function ident(kind: "author" | "committer", config: Config, lenient = false): string {
  const K = kind.toUpperCase();
  const env = process.env;
  let name = env[`PKB_${K}_NAME`] ?? config.get(`${kind}.name`) ?? config.get("user.name");
  let email = env[`PKB_${K}_EMAIL`] ?? config.get(`${kind}.email`) ?? config.get("user.email") ?? env.EMAIL;
  if (lenient) {
    const login = (() => { try { return userInfo().username; } catch { return "unknown"; } })();
    name ||= login;
    email ||= `${login}@${hostname()}`;
  }
  if (!name || !email) {
    err("Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n" +
      '  pkb config --global user.email "you@example.com"\n  pkb config --global user.name "Your Name"\n\n' +
      "to set your account's default identity.\nOmit --global to set the identity only in this repository.\n\n");
    if (!email) die("unable to auto-detect email address");
    die("empty ident name not allowed");
  }
  const dateStr = env[`PKB_${K}_DATE`];
  let when: { time: number; tz: string };
  if (dateStr) {
    const p = parseDate(dateStr);
    if (!p) die(`invalid date format: ${dateStr}`);
    when = p;
  } else {
    const t = Math.floor(Date.now() / 1000);
    when = { time: t, tz: localTz(t) };
  }
  return `${name} <${email}> ${when.time} ${when.tz}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDefaultDate(time: number, tz: string): string {
  const d = new Date((time + tzToMinutes(tz) * 60) * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()} ${tz}`;
}

export { GitExit };
