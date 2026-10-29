// Transports: smart HTTP(S) (the protocol GitHub serves) and local repository paths.
// Smart HTTP v0, as observed against git-http-backend (fixtures net-*):
//  GET  <url>/info/refs?service=git-upload-pack  -> "# service=..." pkt, flush, then
//       "<oid> <ref>\0<capabilities>" and "<oid> <ref>" lines ("^{}" lines carry peeled tags;
//       an empty repo advertises "<zero> capabilities^{}"), flush.
//  POST <url>/git-upload-pack: "want <oid> <caps>", more wants, flush, "have" lines, "done";
//       reply: "NAK"/"ACK" then side-band-64k pack data.
//  POST <url>/git-receive-pack: "<old> <new> <ref>\0<caps>" commands, flush, raw pack;
//       reply (side-band): "unpack ok" then "ok <ref>" / "ng <ref> <reason>".
// Errors mirror the observed messages: 404 -> "repository '<url>/' not found"; 401 with no
// credentials -> "could not read Username for '<scheme://host>': terminal prompts disabled".
// Credentials: user:password in the URL, PKB_TOKEN (user PKB_USERNAME or "x-access-token"),
// or a configured credential.helper (git's helper protocol, e.g. Git Credential Manager).
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pkt, FLUSH, readPkts, line } from "./pkt.ts";
import { die, err } from "../output.ts";
import { Repo, isGitDir } from "../repo.ts";
import { Config } from "../config.ts";
import { listRefs, readRefRaw, resolveRef, updateRef, deleteRef } from "../refs.ts";
import { parsePack, writePack, enumerateObjects } from "../pack.ts";
import { anonymize } from "../remote.ts";
import { NAME, VERSION, env, REPO_DIR } from "../brand.ts";

export interface Advert {
  refs: { name: string; oid: string }[];
  peeled: Map<string, string>;
  caps: Set<string>;
  symrefs: Map<string, string>;
}
export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}
export interface PushReport {
  unpack: string;
  results: Map<string, string | null>; // null = ok, otherwise the rejection reason
}
export interface Transport {
  url: string;
  discover(service: "upload" | "receive"): Promise<Advert>;
  fetchPack(wants: string[], haves: string[]): Promise<Buffer>;
  sendPack(cmds: RefUpdate[], pack: Buffer | null): Promise<PushReport>;
  // local repositories: their objects directory (clone copies it, as git does for local paths)
  localObjects?: string;
  // finish a session that needs an explicit end (ssh)
  close?(): Promise<void>;
}

const ZERO = "0".repeat(40);
const AGENT = `agent=${NAME}/${VERSION}`;
// GitHub serves the smart protocol to user agents starting with "git/"; the product is named after.
const USER_AGENT = `git/2.0 (${NAME}/${VERSION})`;

function parseAdvert(pkts: { flush: boolean; data: Buffer }[]): Advert {
  const a: Advert = { refs: [], peeled: new Map(), caps: new Set(), symrefs: new Map() };
  let first = true;
  for (const p of pkts) {
    if (p.flush) continue;
    let s = line(p.data);
    if (s.startsWith("#")) continue;
    if (first) {
      const nul = s.indexOf("\0");
      if (nul >= 0) {
        for (const c of s.slice(nul + 1).split(" ").filter(Boolean)) {
          a.caps.add(c);
          const m = c.match(/^symref=([^:]+):(.+)$/);
          if (m) a.symrefs.set(m[1], m[2]);
        }
        s = s.slice(0, nul);
      }
      first = false;
    }
    const [oid, name] = s.split(" ");
    if (!name || name === "capabilities^{}") continue;
    if (name.endsWith("^{}")) a.peeled.set(name.slice(0, -3), oid);
    else a.refs.push({ name, oid });
  }
  return a;
}

function sideband(buf: Buffer, start: number): Buffer {
  const out: Buffer[] = [];
  const { pkts } = readPkts(buf, start);
  for (const p of pkts) {
    if (p.flush || !p.data.length) continue;
    const band = p.data[0];
    if (band === 1) out.push(p.data.subarray(1));
    else if (band === 3) die(`remote error: ${p.data.subarray(1).toString().trim()}`);
  }
  return Buffer.concat(out);
}

// ---- credentials --------------------------------------------------------------------
const HELPER_DIRS = ["C:/Program Files/Git/mingw64/bin", "C:/Program Files/Git/mingw64/libexec/git-core", "/usr/lib/git-core", "/usr/libexec/git-core"];

function helperCommand(h: string): string {
  if (h.startsWith("!")) return h.slice(1);
  if (/[\\/]/.test(h)) return `"${h}"`;
  for (const d of HELPER_DIRS) for (const ext of ["", ".exe"]) if (existsSync(join(d, `git-credential-${h}${ext}`))) return `"${join(d, `git-credential-${h}${ext}`)}"`;
  return `git-credential-${h}`;
}

function runHelpers(config: Config | null, action: "get" | "store" | "erase", u: URL, cred?: { user: string; pass: string }): { user: string; pass: string } | null {
  const helpers = config?.map.get("credential.helper") ?? [];
  const active = helpers.slice(helpers.lastIndexOf("") + 1);
  // like git, the path is only part of the lookup when credential.useHttpPath is set
  // (otherwise helpers such as Git Credential Manager miss host-wide logins)
  let input = `protocol=${u.protocol.replace(":", "")}\nhost=${u.host}\n`;
  if (config?.bool("credential.usehttppath", false)) input += `path=${u.pathname.replace(/^\//, "")}\n`;
  if (cred) input += `username=${cred.user}\npassword=${cred.pass}\n`;
  input += "\n";
  for (const h of active) {
    const r = spawnSync(`${helperCommand(h)} ${action}`, { shell: true, input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
    if (action !== "get" || r.status !== 0) continue;
    const kv = Object.fromEntries(r.stdout.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    if (kv.password) return { user: kv.username ?? "", pass: kv.password };
  }
  return null;
}

class HttpTransport implements Transport {
  url: string;
  private base: URL;
  private cred: { user: string; pass: string } | null = null;
  private fromHelper = false;
  private config: Config | null;

  constructor(url: string, config: Config | null) {
    this.url = url;
    const u = new URL(url.replace(/\/+$/, ""));
    if (u.username || u.password) this.cred = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
    u.username = "";
    u.password = "";
    this.base = u;
    this.config = config;
  }

  private shown(): string {
    return anonymize(this.url).replace(/\/+$/, "") + "/";
  }

  private async request(method: "GET" | "POST", path: string, body?: Buffer, ctype?: string): Promise<Buffer> {
    const target = this.base.href.replace(/\/+$/, "") + path;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Pragma": "no-cache" };
      if (ctype) {
        headers["Content-Type"] = `application/x-${ctype}-request`;
        headers["Accept"] = `application/x-${ctype}-result`;
      }
      if (this.cred) headers["Authorization"] = "Basic " + Buffer.from(`${this.cred.user}:${this.cred.pass}`).toString("base64");
      let res: Response;
      try {
        res = await fetch(target, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "follow" });
      } catch (e: any) {
        die(`unable to access '${this.shown()}': ${e?.cause?.message ?? e?.message ?? e}`);
      }
      if (res.status === 401) {
        if (this.cred) {
          if (this.fromHelper) runHelpers(this.config, "erase", this.base, this.cred);
          die(`Authentication failed for '${this.shown()}'`);
        }
        const tok = env("TOKEN");
        if (tok) this.cred = { user: env("USERNAME") ?? "x-access-token", pass: tok };
        else {
          this.cred = runHelpers(this.config, "get", this.base);
          this.fromHelper = !!this.cred;
        }
        if (!this.cred) die(`could not read Username for '${this.base.protocol}//${this.base.host}': terminal prompts disabled`);
        continue;
      }
      if (res.status === 404) die(`repository '${this.shown()}' not found`);
      if (!res.ok) {
        // servers explain refusals in a text body, shown as "remote: ..." (observed from git
        // against github.com: "remote: Permission to <repo> denied to <user>.")
        if (/^text\/plain/.test(res.headers.get("content-type") ?? "")) {
          const text = (await res.text()).trimEnd();
          if (text) err(text.split("\n").map((l) => `remote: ${l}\n`).join(""));
        }
        die(`unable to access '${this.shown()}': The requested URL returned error: ${res.status}`);
      }
      if (this.fromHelper && attempt > 0) runHelpers(this.config, "store", this.base, this.cred!);
      return Buffer.from(await res.arrayBuffer());
    }
    die(`Authentication failed for '${this.shown()}'`);
  }

  async discover(service: "upload" | "receive"): Promise<Advert> {
    const svc = `git-${service}-pack`;
    const buf = await this.request("GET", `/info/refs?service=${svc}`);
    const { pkts } = readPkts(buf);
    if (!pkts.length || !line(pkts[0].data).startsWith(`# service=${svc}`)) die(`'${this.shown()}' is not a smart-HTTP repository (dumb HTTP is not supported)`);
    return parseAdvert(pkts.slice(1));
  }

  async fetchPack(wants: string[], haves: string[]): Promise<Buffer> {
    const parts: Buffer[] = [];
    wants.forEach((w, i) => parts.push(pkt(i === 0 ? `want ${w} side-band-64k ofs-delta no-progress ${AGENT}\n` : `want ${w}\n`)));
    parts.push(FLUSH);
    for (const h of haves) parts.push(pkt(`have ${h}\n`));
    parts.push(pkt("done\n"));
    const res = await this.request("POST", "/git-upload-pack", Buffer.concat(parts), "git-upload-pack");
    // skip ACK/NAK lines, then demultiplex the side band
    let p = 0;
    while (p + 7 <= res.length) {
      const len = parseInt(res.toString("latin1", p, p + 4), 16);
      const s = res.toString("latin1", p + 4, p + 7);
      if (len < 4 || (s !== "NAK" && s !== "ACK")) break;
      p += len;
    }
    return sideband(res, p);
  }

  async sendPack(cmds: RefUpdate[], pack: Buffer | null): Promise<PushReport> {
    const parts: Buffer[] = [];
    cmds.forEach((c, i) => parts.push(pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0report-status side-band-64k ${AGENT}` : ""}\n`)));
    parts.push(FLUSH);
    if (pack) parts.push(pack);
    const res = await this.request("POST", "/git-receive-pack", Buffer.concat(parts), "git-receive-pack");
    return parseReport(sideband(res, 0));
  }
}

function parseReport(buf: Buffer): PushReport {
  const rep: PushReport = { unpack: "", results: new Map() };
  for (const p of readPkts(buf).pkts) {
    if (p.flush) continue;
    const s = line(p.data);
    if (s.startsWith("unpack ")) rep.unpack = s.slice(7);
    else if (s.startsWith("ok ")) rep.results.set(s.slice(3), null);
    else if (s.startsWith("ng ")) {
      const sp = s.indexOf(" ", 3);
      rep.results.set(s.slice(3, sp), s.slice(sp + 1));
    }
  }
  return rep;
}

// ---- local repository paths ------------------------------------------------------------
class LocalTransport implements Transport {
  url: string;
  private repo: Repo;
  localObjects: string;

  constructor(url: string, path: string) {
    this.url = url;
    const gd = [join(path, REPO_DIR), join(path, ".git"), path].find((d) => isGitDir(d))!;
    const config = Config.load(gd, []);
    this.repo = new Repo(gd, gd === path ? null : path, "", config);
    this.localObjects = this.repo.odb.dir;
  }

  async discover(): Promise<Advert> {
    const a: Advert = { refs: [], peeled: new Map(), caps: new Set(), symrefs: new Map() };
    const head = readRefRaw(this.repo, "HEAD") ?? "";
    const headOid = resolveRef(this.repo, "HEAD")?.oid;
    if (headOid) a.refs.push({ name: "HEAD", oid: headOid });
    if (head.startsWith("ref: ")) a.symrefs.set("HEAD", head.slice(5).trim());
    for (const r of [...listRefs(this.repo, "refs/heads/"), ...listRefs(this.repo, "refs/tags/")]) a.refs.push(r);
    return a;
  }

  async fetchPack(wants: string[], haves: string[]): Promise<Buffer> {
    return writePack(this.repo.odb, enumerateObjects(this.repo.odb, wants, haves.filter((h) => this.repo.odb.has(h))));
  }

  async sendPack(cmds: RefUpdate[], pack: Buffer | null): Promise<PushReport> {
    if (pack) for (const e of parsePack(pack, this.repo.odb)) this.repo.odb.write(e.objType!, e.body!);
    const rep: PushReport = { unpack: "ok", results: new Map() };
    for (const c of cmds) {
      const cur = resolveRef(this.repo, c.ref)?.oid ?? ZERO;
      if (cur !== c.old) rep.results.set(c.ref, "failed to lock");
      else {
        if (c.new === ZERO) deleteRef(this.repo, c.ref);
        else updateRef(this.repo, c.ref, c.new, "push");
        rep.results.set(c.ref, null);
      }
    }
    return rep;
  }
}

// ---- ssh ---------------------------------------------------------------------------------
// The protocol is the same v0 exchange, but stateful over one connection: we run
//   <ssh> [-p <port>] <user@host> "git-upload-pack '<path>'"   (or git-receive-pack)
// and talk pkt-lines over its stdin/stdout, like git does (fixture net-ssh recorded the real
// git through harness/fake-ssh.mjs, which runs git-upload-pack/receive-pack locally).
// The ssh program is PKB_SSH_COMMAND, core.sshCommand, PKB_SSH, or "ssh". If the server closes
// before advertising refs: "Could not read from remote repository." (observed wording).
export function parseSshUrl(url: string): { userHost: string; port: string | null; path: string } | null {
  let m = url.match(/^ssh:\/\/(?:([^@/]+)@)?([^:/]+|\[[^\]]+\])(?::(\d+))?(\/.*)$/i);
  if (m) return { userHost: (m[1] ? m[1] + "@" : "") + m[2], port: m[3] ?? null, path: m[4].replace(/^\/~/, "~") };
  m = url.match(/^(?:([^@/:]+)@)?([^/:]+):(?!\/\/)(.+)$/);
  if (m && !/^[a-zA-Z]$/.test(m[2])) return { userHost: (m[1] ? m[1] + "@" : "") + m[2], port: null, path: m[3] };
  return null;
}

const sessions = new Set<ReturnType<typeof spawn>>();

// end every ssh child left open (e.g. after a fatal error) so the process can exit
export function shutdownTransports(): void {
  for (const p of sessions) {
    try { p.stdin?.end(); } catch {}
    try { p.kill(); } catch {}
  }
  sessions.clear();
}

class SshTransport implements Transport {
  url: string;
  private target: { userHost: string; port: string | null; path: string };
  private config: Config | null;
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = Buffer.alloc(0);
  private ended = false;
  private exitCode: number | null = null;
  private waiters: (() => void)[] = [];

  constructor(url: string, target: { userHost: string; port: string | null; path: string }, config: Config | null) {
    this.url = url;
    this.target = target;
    this.config = config;
  }

  private start(service: string): void {
    const ssh = env("SSH_COMMAND") ?? this.config?.get("core.sshcommand") ?? (env("SSH") ? `"${env("SSH")}"` : "ssh");
    const remoteCmd = `git-${service} '${this.target.path.replace(/'/g, "'\\''")}'`;
    const cmd = `${ssh}${this.target.port ? ` -p ${this.target.port}` : ""} ${this.target.userHost} "${remoteCmd}"`;
    const proc = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    proc.stdout!.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    proc.stdout!.on("end", () => { this.ended = true; this.wake(); });
    proc.stderr!.on("data", (d: Buffer) => err(d.toString("utf8")));
    proc.on("exit", (code) => { this.exitCode = code; this.wake(); });
    proc.stdin!.on("error", () => {});
    this.proc = proc;
    sessions.add(proc);
    proc.on("exit", () => sessions.delete(proc));
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async need(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      if (this.ended) return false;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    return true;
  }

  // next pkt-line: Buffer payload, null for flush, undefined at end of stream
  private async next(): Promise<Buffer | null | undefined> {
    if (!(await this.need(4))) return undefined;
    const len = parseInt(this.buf.toString("latin1", 0, 4), 16);
    if (len === 0) {
      this.buf = this.buf.subarray(4);
      return null;
    }
    if (!(await this.need(len))) return undefined;
    const data = this.buf.subarray(4, len);
    this.buf = this.buf.subarray(len);
    return data;
  }

  private notReadable(): never {
    die("Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.");
  }

  async discover(service: "upload" | "receive"): Promise<Advert> {
    this.start(`${service}-pack`);
    const pkts: { flush: boolean; data: Buffer }[] = [];
    for (;;) {
      const p = await this.next();
      if (p === undefined) this.notReadable();
      if (p === null) break;
      pkts.push({ flush: false, data: p });
    }
    return parseAdvert(pkts);
  }

  private async demux(): Promise<Buffer> {
    const out: Buffer[] = [];
    for (;;) {
      const p = await this.next();
      if (p === undefined || p === null) break;
      if (!p.length) continue;
      const s = p.toString("latin1", 0, 3);
      if (s === "NAK" || s === "ACK") continue;
      if (p[0] === 1) out.push(p.subarray(1));
      else if (p[0] === 3) die(`remote error: ${p.subarray(1).toString().trim()}`);
    }
    return Buffer.concat(out);
  }

  async fetchPack(wants: string[], haves: string[]): Promise<Buffer> {
    // one request per connection: a second request (e.g. following tags) reconnects
    if (this.proc!.stdin!.writableEnded) {
      this.buf = Buffer.alloc(0);
      this.ended = false;
      await this.discover("upload");
    }
    const parts: Buffer[] = [];
    wants.forEach((w, i) => parts.push(pkt(i === 0 ? `want ${w} side-band-64k ofs-delta no-progress ${AGENT}\n` : `want ${w}\n`)));
    parts.push(FLUSH);
    for (const h of haves) parts.push(pkt(`have ${h}\n`));
    parts.push(pkt("done\n"));
    this.proc!.stdin!.write(Buffer.concat(parts));
    const pack = await this.demux();
    this.proc!.stdin!.end();
    return pack;
  }

  async sendPack(cmds: RefUpdate[], pack: Buffer | null): Promise<PushReport> {
    const parts: Buffer[] = [];
    cmds.forEach((c, i) => parts.push(pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0report-status side-band-64k ${AGENT}` : ""}\n`)));
    parts.push(FLUSH);
    if (pack) parts.push(pack);
    this.proc!.stdin!.end(Buffer.concat(parts));
    return parseReport(await this.demux());
  }

  // end the session when nothing (more) is requested: a flush tells the server we are done
  async close(): Promise<void> {
    if (!this.proc || this.proc.stdin!.writableEnded) return;
    this.proc.stdin!.end(FLUSH);
    while (!this.ended) await new Promise<void>((r) => this.waiters.push(r));
  }
}

export function openTransport(url: string, config: Config | null): Transport {
  if (/^https?:\/\//i.test(url)) return new HttpTransport(url, config);
  const ssh = parseSshUrl(url);
  if (ssh) return new SshTransport(url, ssh, config);
  if (/^git:\/\//i.test(url)) die(`git:// remotes are not supported; use https:// or ssh ('${url}')`);
  const path = resolve(url.replace(/^file:\/\//, ""));
  // observed (fixture net-pull-refused) for a name that is neither a remote nor a repository
  if (![join(path, REPO_DIR), join(path, ".git"), path].some((d) => isGitDir(d))) {
    err(`fatal: '${url}' does not appear to be a ${NAME} repository\n`);
    die("Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.");
  }
  return new LocalTransport(url, path);
}
