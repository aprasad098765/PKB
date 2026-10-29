// Network scenarios (clone / fetch / push over smart HTTP) against a local server running the
// real git-http-backend. "seed" steps are another collaborator using the real git.
const g = (...git) => ({ git });
const gin = (cwd, ...git) => ({ git, cwd });
const seed = (...a) => ({ seed: a });
const srv = (...a) => ({ srv: a });
const sw = (seedWrite, content) => ({ seedWrite, content });
const w = (write, content) => ({ write, content });

// a bare remote r.git with two commits on master and a "side" branch
const remote = [
  srv("init", "-q", "--bare", "r.git"),
  seed("init", "-q", "-b", "master"),
  sw("a.txt", "one\ntwo\n"), sw("dir/b.txt", "bee\n"),
  seed("add", "."), seed("commit", "-q", "-m", "first"),
  sw("a.txt", "one\ntwo\nthree\n"), seed("commit", "-q", "-am", "second"),
  seed("branch", "side"),
  seed("push", "-q", "{AUTH}/r.git", "master", "side"),
];

export const net = [
  {
    name: "net-clone-basic", net: true, covers: ["net.clone"],
    steps: [...remote, g("clone", "{URL}/r.git", "c"), gin("c", "log", "--oneline"), gin("c", "status"), gin("c", "status", "-sb"), gin("c", "branch", "-a"), gin("c", "branch", "-r"), gin("c", "branch", "-vv")],
  },
  {
    name: "net-clone-variants", net: true, covers: ["net.clone"],
    steps: [...remote, g("clone", "-q", "{URL}/r.git"), g("clone", "{URL}/r.git", "r"), g("clone", "-b", "side", "{URL}/r.git", "s"), gin("s", "status", "-sb"),
      g("clone", "{URL}/nope.git", "n"), g("clone", "-b", "nosuch", "{URL}/r.git", "x"), srv("init", "-q", "--bare", "empty.git"), g("clone", "{URL}/empty.git", "e"), gin("e", "status")],
  },
  {
    name: "net-checkout-remote-branch", net: true, covers: ["net.clone", "cmd.checkout-switch"],
    steps: [...remote, g("clone", "-q", "{URL}/r.git", "c"), gin("c", "checkout", "side"), gin("c", "status", "-sb"), gin("c", "switch", "master"), gin("c", "branch", "-vv")],
  },
  {
    name: "net-fetch", net: true, covers: ["net.fetch"],
    steps: [...remote, g("clone", "-q", "{URL}/r.git", "c"), gin("c", "fetch"),
      sw("a.txt", "one\ntwo\nthree\nfour\n"), seed("commit", "-q", "-am", "third"), seed("branch", "new"), seed("push", "-q", "{AUTH}/r.git", "master", "new"),
      gin("c", "fetch"), gin("c", "status"), gin("c", "status", "-sb"), gin("c", "log", "--oneline", "origin/master"), gin("c", "merge", "origin/master"), gin("c", "status", "-sb"),
      seed("reset", "-q", "--hard", "HEAD~2"), sw("z", "z\n"), seed("add", "z"), seed("commit", "-q", "-m", "rewritten"), seed("push", "-q", "-f", "{AUTH}/r.git", "master"),
      gin("c", "fetch", "origin"), gin("c", "status"), gin("c", "fetch", "{URL}/r.git", "side")],
  },
  {
    name: "net-push", net: true, covers: ["net.push"],
    steps: [...remote, g("clone", "-q", "{AUTH}/r.git", "c"), w("c/n.txt", "new\n"), gin("c", "add", "n.txt"), gin("c", "commit", "-q", "-m", "local"),
      gin("c", "status", "-sb"), gin("c", "push"), gin("c", "status", "-sb"), gin("c", "push"),
      gin("c", "checkout", "-q", "-b", "feat"), w("c/f.txt", "f\n"), gin("c", "add", "f.txt"), gin("c", "commit", "-q", "-m", "feature"), gin("c", "push", "-u", "origin", "feat"), gin("c", "branch", "-vv"),
      gin("c", "push", "origin", "--delete", "feat"), gin("c", "push", "origin", "side:copy"), gin("c", "push", "origin", ":copy")],
  },
  {
    name: "net-push-rejected", net: true, covers: ["net.push"],
    steps: [...remote, g("clone", "-q", "{AUTH}/r.git", "c"), sw("s.txt", "s\n"), seed("add", "s.txt"), seed("commit", "-q", "-m", "theirs"), seed("push", "-q", "{AUTH}/r.git", "master"),
      w("c/m.txt", "m\n"), gin("c", "add", "m.txt"), gin("c", "commit", "-q", "-m", "mine"), gin("c", "push"), gin("c", "fetch", "-q"), gin("c", "push"), gin("c", "status", "-sb"),
      gin("c", "push", "--force"), gin("c", "push", "origin", "nosuch")],
  },
  {
    name: "net-push-auth", net: true, covers: ["net.push", "net.auth"],
    steps: [...remote, g("clone", "-q", "{URL}/r.git", "c"), w("c/x", "x\n"), gin("c", "add", "x"), gin("c", "commit", "-q", "-m", "x"), gin("c", "push"),
      gin("c", "push", "{AUTH}/r.git", "master"), gin("c", "push", "{AUTH}/nope.git", "master")],
  },
  // ---- pull -----------------------------------------------------------------------------
  {
    name: "net-pull", net: true, covers: ["net.pull"],
    steps: [...remote, g("clone", "-q", "{URL}/r.git", "c"), gin("c", "pull"),
      sw("a.txt", "one\ntwo\nthree\nfour\n"), seed("commit", "-q", "-am", "third"), seed("push", "-q", "{AUTH}/r.git", "master"),
      gin("c", "pull"), gin("c", "status", "-sb"), gin("c", "pull", "-q"),
      seed("checkout", "-q", "side"), sw("s.txt", "s\n"), seed("add", "s.txt"), seed("commit", "-q", "-m", "on side"), seed("merge", "-q", "master"), seed("push", "-q", "{AUTH}/r.git", "side"),
      gin("c", "pull", "origin", "side"), gin("c", "log", "--oneline", "-3"), gin("c", "status", "-sb")],
  },
  {
    name: "net-pull-refused", net: true, covers: ["net.pull"],
    steps: [...remote, g("clone", "-q", "{URL}/r.git", "c"), sw("t.txt", "t\n"), seed("add", "t.txt"), seed("commit", "-q", "-m", "theirs"), seed("push", "-q", "{AUTH}/r.git", "master"),
      w("c/m.txt", "m\n"), gin("c", "add", "m.txt"), gin("c", "commit", "-q", "-m", "mine"), gin("c", "pull"), gin("c", "pull", "--ff-only"), gin("c", "status", "-sb"),
      gin("c", "checkout", "-q", "-b", "lonely"), gin("c", "pull"), gin("c", "pull", "nosuchremote")],
  },
  // ---- ssh (through harness/fake-ssh.mjs, i.e. the real git-upload-pack/receive-pack) -------
  {
    name: "net-ssh", net: true, covers: ["net.ssh", "net.clone", "net.push", "net.fetch"],
    steps: [...remote, g("clone", "{SSH}/r.git", "c1"), g("clone", "-q", "{SCP}r.git", "c2"), gin("c1", "status", "-sb"), gin("c2", "branch", "-a"),
      w("c1/n.txt", "n\n"), gin("c1", "add", "n.txt"), gin("c1", "commit", "-q", "-m", "over ssh"), gin("c1", "push"), gin("c2", "fetch"), gin("c2", "pull"),
      gin("c2", "push", "origin", "master:refs/heads/viassh"), gin("c1", "fetch", "--prune"), gin("c1", "push", "origin", "--delete", "viassh"),
      g("clone", "{SSH}/missing.git", "m"), gin("c1", "log", "--oneline", "-2")],
  },
  // ---- held-out (written after the scenarios above passed; recorded, then run before fixes) ----
  {
    name: "net-ho-tags-prune", net: true, covers: ["net.fetch", "net.clone"],
    steps: [...remote, seed("tag", "-a", "-m", "release one", "v1"), seed("tag", "light", "HEAD~1"), seed("push", "-q", "{AUTH}/r.git", "--tags"),
      g("clone", "-q", "{URL}/r.git", "c"), gin("c", "branch", "-r"), gin("c", "cat-file", "-t", "v1"), gin("c", "log", "--oneline", "-1", "light"),
      seed("tag", "-a", "-m", "two", "v2"), seed("push", "-q", "{AUTH}/r.git", "v2", ":side"), gin("c", "fetch"), gin("c", "fetch", "--prune"), gin("c", "branch", "-a")],
  },
  {
    name: "net-ho-remote-add-upstream", net: true, covers: ["net.push", "net.remote"],
    steps: [srv("init", "-q", "--bare", "p.git"), g("init", "-q", "w"), w("w/a", "a\n"), gin("w", "add", "a"), gin("w", "commit", "-q", "-m", "a"),
      gin("w", "push"), gin("w", "remote", "add", "origin", "{AUTH}/p.git"), gin("w", "remote", "-v"), gin("w", "remote"), gin("w", "push"),
      gin("w", "push", "-u", "origin", "master"), gin("w", "status", "-sb"), gin("w", "checkout", "-q", "-b", "topic"), gin("w", "push"),
      gin("w", "push", "origin", "HEAD:refs/heads/other"), gin("w", "branch", "-vv"), gin("w", "branch", "-u", "origin/other"), gin("w", "branch", "-vv"), gin("w", "status")],
  },
  {
    name: "net-ho-big-and-merge", net: true, covers: ["net.fetch", "net.clone"],
    steps: [srv("init", "-q", "--bare", "b.git"), seed("init", "-q", "-b", "master"),
      ...Array.from({ length: 6 }, (_, i) => [sw(`f${i}/x.txt`, `content ${i}\n`.repeat(30)), ...Array.from({ length: 20 }, (_, k) => sw(`f${i}/n${k}.txt`, `${i}-${k}\n`))]).flat(),
      seed("add", "."), seed("commit", "-q", "-m", "many files"), seed("push", "-q", "{AUTH}/b.git", "master"),
      g("clone", "-q", "{URL}/b.git", "c"),
      ...Array.from({ length: 6 }, (_, i) => Array.from({ length: 20 }, (_, k) => sw(`g${i}/m${k}.txt`, `new ${i}-${k}\n`))).flat(),
      seed("add", "."), seed("commit", "-q", "-m", "more files"), seed("push", "-q", "{AUTH}/b.git", "master"),
      gin("c", "fetch"), gin("c", "status", "-sb"), gin("c", "merge"), gin("c", "log", "--oneline"), gin("c", "status")],
  },
  {
    name: "net-ho-local-clone", net: true, covers: ["net.clone", "net.push"],
    steps: [g("init", "-q", "orig"), w("orig/a", "a\n"), gin("orig", "add", "a"), gin("orig", "commit", "-q", "-m", "one"), gin("orig", "branch", "dev"),
      g("clone", "-q", "orig", "copy"), gin("copy", "branch", "-a"), gin("copy", "log", "--oneline"), w("copy/b", "b\n"), gin("copy", "add", "b"), gin("copy", "commit", "-q", "-m", "two"),
      gin("copy", "push", "origin", "master:fromcopy"), gin("orig", "log", "--oneline", "fromcopy")],
  },
  {
    name: "net-ho-pull-ssh", net: true, covers: ["net.pull", "net.ssh"],
    steps: [...remote, seed("tag", "-a", "-m", "rel", "v1"), seed("push", "-q", "{AUTH}/r.git", "v1"), g("clone", "-q", "{SCP}r.git", "c"), gin("c", "pull", "--ff-only"),
      sw("a.txt", "changed\n"), seed("commit", "-q", "-am", "upstream change"), seed("tag", "v2"), seed("push", "-q", "{AUTH}/r.git", "master", "v2"),
      gin("c", "pull", "--ff-only"), gin("c", "log", "--oneline", "-2"), gin("c", "checkout", "-q", "-b", "mine"), w("c/x", "x\n"), gin("c", "add", "x"), gin("c", "commit", "-q", "-m", "x"),
      gin("c", "push", "-u", "origin", "mine"), gin("c", "pull"), sw("y", "y\n"), seed("fetch", "-q", "{AUTH}/r.git", "mine:mine"), seed("checkout", "-q", "mine"), seed("add", "y"), seed("commit", "-q", "-m", "y"),
      seed("push", "-q", "{AUTH}/r.git", "mine"), w("c/z", "z\n"), gin("c", "add", "z"), gin("c", "commit", "-q", "-m", "z"), gin("c", "push"), gin("c", "pull", "--ff-only"), gin("c", "status", "-sb")],
  },
  {
    name: "net-push-new-repo", net: true, covers: ["net.push"],
    steps: [srv("init", "-q", "--bare", "fresh.git"), g("init", "-q", "w"), w("w/a", "a\n"), gin("w", "add", "a"), gin("w", "commit", "-q", "-m", "a"),
      gin("w", "push", "{AUTH}/fresh.git", "master"), g("clone", "-q", "{URL}/fresh.git", "back"), gin("back", "log", "--oneline")],
  },
];
