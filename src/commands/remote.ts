// pkb remote: list / -v / add / remove / get-url / set-url
// Config layout follows clone (fixtures net-clone-*): [remote "<name>"] url + fetch refspec.
// Message wording follows git's remote builtin; marked where not observed in fixtures.
import type { Repo } from "../repo.ts";
import { parseOptions } from "../options.ts";
import { remoteNames, addRemote } from "../remote.ts";
import { configSet, configRemoveSection } from "../config.ts";
import { listRefs, deleteRef } from "../refs.ts";
import { err, out, GitExit } from "../output.ts";

function fail(msg: string, code: number): never {
  err(`error: ${msg}\n`);
  throw new GitExit(code);
}

export function cmdRemote(argv: string[], repo: Repo): number {
  const p = parseOptions("remote", argv, [{ short: "v", long: "verbose", key: "verbose" }], { stopAtNonOption: true });
  const [sub, ...rest] = p.args;
  const names = remoteNames(repo).sort();
  const url = (n: string) => repo.config.get(`remote.${n}.url`) ?? "";
  if (!sub) {
    for (const n of names) out(p.opts.verbose ? `${n}\t${url(n)} (fetch)\n${n}\t${repo.config.get(`remote.${n}.pushurl`) ?? url(n)} (push)\n` : `${n}\n`);
    return 0;
  }
  const need = (n: string | undefined) => {
    if (!n || !names.includes(n)) fail(`No such remote: '${n ?? ""}'`, 2); // unverified wording
    return n!;
  };
  switch (sub) {
    case "add": {
      const [name, u] = rest;
      if (!name || !u) fail("usage: pkb remote add <name> <url>", 129);
      if (names.includes(name)) fail(`remote ${name} already exists.`, 3); // unverified wording
      addRemote(repo, name, u);
      return 0;
    }
    case "remove":
    case "rm": {
      const name = need(rest[0]);
      configRemoveSection(repo.path("config"), repo.config, "remote", name);
      for (const r of listRefs(repo, `refs/remotes/${name}/`)) deleteRef(repo, r.name);
      deleteRef(repo, `refs/remotes/${name}/HEAD`);
      for (const k of [...repo.config.map.keys()]) {
        const m = k.match(/^branch\.(.+)\.remote$/);
        if (m && repo.config.get(k) === name) configRemoveSection(repo.path("config"), repo.config, "branch", m[1]);
      }
      return 0;
    }
    case "get-url":
      out(url(need(rest[0])) + "\n");
      return 0;
    case "set-url": {
      const name = need(rest[0]);
      if (!rest[1]) fail("usage: pkb remote set-url <name> <newurl>", 129);
      configSet(repo.path("config"), repo.config, `remote.${name}.url`, rest[1]);
      return 0;
    }
    default:
      fail(`unknown subcommand: '${sub}'`, 129); // unverified wording
  }
}
