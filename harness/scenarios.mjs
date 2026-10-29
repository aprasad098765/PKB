// Parity scenarios. Each covers one or more ledger obligations (recon/build-ledger-input.mjs)
// with positive and negative cases. Steps run in a fresh empty directory.
const g = (...git) => ({ git });
const gin = (cwd, ...git) => ({ git, cwd });
const gstdin = (stdin, ...git) => ({ git, stdin });
const w = (write, content) => ({ write, content });
const rm = (p) => ({ rm: p });
const init = g("init", "-q");
const commit = (msg) => g("commit", "-q", "-m", msg);

// A small repo with history used by several scenarios.
const base = [
  init,
  w("a.txt", "one\ntwo\nthree\n"),
  w("dir/b.txt", "bee\n"),
  g("add", "."),
  commit("first"),
];

export const scenarios = [
  // ---- cli / dispatcher -------------------------------------------------
  { name: "cli-no-args", covers: ["cli.dispatch", "cli.exit-codes"], steps: [g()] },
  { name: "cli-version", covers: ["cli.dispatch"], steps: [g("--version"), g("version")] },
  { name: "cli-unknown-command", covers: ["cli.unknown-command"], steps: [g("frobnicate"), g("stauts")] },
  { name: "cli-not-a-repo", covers: ["cli.not-a-repo", "repo.discovery"], steps: [g("status"), g("log"), g("add", "x"), g("cat-file", "-t", "HEAD"), g("write-tree"), g("branch"), g("diff", "--cached")] },
  { name: "cli-worktree-required", covers: ["cli.worktree-required"], steps: [g("init", "-q", "--bare"), g("status"), g("add", "x"), g("commit", "-m", "x")] },
  { name: "repo-discovery-subdir", covers: ["repo.discovery"], steps: [...base, w("dir/c.txt", "see\n"), gin("dir", "status"), gin("dir", "add", "c.txt"), gin("dir", "status", "--short"), gin("dir", "write-tree")] },
  { name: "repo-git-dir-env", covers: ["repo.discovery"], steps: [init, w("x", "x\n"), g("--git-dir=.git", "add", "x"), g("--git-dir=.git", "write-tree"), g("-C", "nosuch", "status")] },

  // ---- init -------------------------------------------------------------
  { name: "init-default", covers: ["cmd.init", "refs.files"], steps: [g("init")] },
  { name: "init-quiet-branch", covers: ["cmd.init"], steps: [g("init", "-q", "-b", "main"), g("status")] },
  { name: "init-reinit", covers: ["cmd.init"], steps: [g("init"), g("init")] },
  { name: "init-directory", covers: ["cmd.init"], steps: [g("init", "sub"), gin("sub", "status", "--short")] },
  { name: "init-initial-branch-option", covers: ["cmd.init"], steps: [g("init", "--initial-branch=trunk")] },
  { name: "init-bad-option", covers: ["cmd.init", "cli.exit-codes"], steps: [g("init", "--bogus")] },

  // ---- hash-object / cat-file / loose objects ----------------------------
  {
    name: "hash-object", covers: ["cmd.hash-object", "odb.loose-write", "odb.hash"],
    steps: [init, w("f.txt", "hello\n"), w("empty", ""), g("hash-object", "f.txt"), g("hash-object", "empty"), g("hash-object", "-w", "f.txt"),
      gstdin("from stdin\n", "hash-object", "--stdin"), gstdin("written\n", "hash-object", "-w", "--stdin"), g("hash-object", "-t", "blob", "f.txt"),
      g("hash-object", "missing.txt"), g("hash-object", "-t", "bogus", "f.txt")],
  },
  { name: "hash-object-outside-repo", covers: ["cmd.hash-object", "odb.hash"], steps: [w("f.txt", "hello\n"), g("hash-object", "f.txt"), g("hash-object", "-w", "f.txt")] },
  {
    name: "cat-file", covers: ["cmd.cat-file", "odb.loose-read", "odb.tree-format", "odb.commit-format"],
    steps: [...base, g("cat-file", "-t", "HEAD"), g("cat-file", "-s", "HEAD"), g("cat-file", "-p", "HEAD"), g("cat-file", "-p", "HEAD^{tree}"),
      g("cat-file", "-t", "HEAD^{tree}"), g("cat-file", "-p", "HEAD:a.txt"), g("cat-file", "blob", "HEAD:a.txt"), g("cat-file", "-s", "HEAD:dir/b.txt"),
      g("cat-file", "-e", "HEAD"), g("cat-file", "-t", "f2ad6c76f0115a6ba5b00456a849810e7ec0af20"),
      g("cat-file", "-e", "0000000000000000000000000000000000000001"), g("cat-file", "-p", "nosuchref"), g("cat-file", "-t", "HEAD:nope.txt"), g("cat-file")],
  },
  {
    name: "tree-ordering", covers: ["odb.tree-format", "cmd.write-tree", "index.sort"],
    steps: [init, w("a-b", "1\n"), w("a/x", "2\n"), w("a.c", "3\n"), w("ab", "4\n"), w("B", "5\n"), w("z/y/x", "6\n"), g("add", "."), g("write-tree")],
  },

  // ---- add / index -------------------------------------------------------
  { name: "add-basic", covers: ["cmd.add", "index.format-v2", "index.sort"], steps: [init, w("b", "b\n"), w("a", "a\n"), w("c/d", "d\n"), g("add", "b"), g("add", "a", "c")] },
  { name: "add-dot-and-update", covers: ["cmd.add", "index.format-v2"], steps: [...base, w("a.txt", "changed\n"), w("new.txt", "new\n"), g("add", "."), g("status", "--short"), rm("dir/b.txt"), g("add", "-A"), g("status", "--short")] },
  { name: "add-nothing", covers: ["cmd.add"], steps: [init, g("add")] },
  { name: "add-unmatched", covers: ["cmd.add", "cli.exit-codes"], steps: [init, w("a", "a\n"), g("add", "nope"), g("add", "a", "nope")] },
  { name: "add-lock-held", covers: ["index.lockfile"], steps: [init, w("a", "a\n"), w(".git/index.lock", ""), g("add", "a")] },
  { name: "add-ignored", covers: ["cmd.add"], steps: [init, w(".gitignore", "*.log\n"), w("x.log", "x\n"), w("y.txt", "y\n"), g("add", "."), g("add", "x.log"), g("status", "--short")] },

  // ---- write-tree --------------------------------------------------------
  { name: "write-tree-empty", covers: ["cmd.write-tree"], steps: [init, g("write-tree")] },
  { name: "write-tree-nested", covers: ["cmd.write-tree", "odb.tree-format"], steps: [init, w("top", "t\n"), w("d1/d2/leaf", "l\n"), w("d1/f", "f\n"), g("add", "."), g("write-tree"), g("cat-file", "-p", "HEAD"), g("write-tree", "--bogus")] },

  // ---- commit ------------------------------------------------------------
  { name: "commit-initial", covers: ["cmd.commit", "odb.commit-format", "refs.files"], steps: [init, w("a", "a\n"), g("add", "a"), g("commit", "-m", "initial commit")] },
  { name: "commit-second", covers: ["cmd.commit", "refs.files"], steps: [...base, w("a.txt", "one\n2\nthree\n"), g("add", "a.txt"), g("commit", "-m", "second", "-m", "body paragraph")] },
  { name: "commit-all-flag", covers: ["cmd.commit"], steps: [...base, w("a.txt", "x\n"), rm("dir/b.txt"), g("commit", "-a", "-m", "all")] },
  { name: "commit-nothing", covers: ["cmd.commit"], steps: [...base, g("commit", "-m", "nothing")] },
  { name: "commit-nothing-untracked", covers: ["cmd.commit"], steps: [...base, w("u.txt", "u\n"), g("commit", "-m", "nothing")] },
  { name: "commit-empty-repo", covers: ["cmd.commit"], steps: [init, g("commit", "-m", "x")] },
  { name: "commit-empty-message", covers: ["cmd.commit"], steps: [init, w("a", "a\n"), g("add", "a"), g("commit", "-m", "")] },
  { name: "commit-message-cleanup", covers: ["cmd.commit", "odb.commit-format"], steps: [init, w("a", "a\n"), g("add", "a"), g("commit", "-q", "-m", "  subject  \n\n\n\nbody line   \n\n# not a comment with -m\n\n")] },
  { name: "commit-allow-empty", covers: ["cmd.commit"], steps: [...base, g("commit", "--allow-empty", "-m", "empty")] },

  // ---- status ------------------------------------------------------------
  { name: "status-empty-repo", covers: ["cmd.status"], steps: [init, g("status"), g("status", "-s"), g("status", "-sb")] },
  { name: "status-untracked-new", covers: ["cmd.status"], steps: [init, w("u", "u\n"), w("s", "s\n"), w("ud/x", "x\n"), g("add", "s"), g("status"), g("status", "--short"), g("status", "--porcelain"), g("status", "-sb")] },
  { name: "status-clean", covers: ["cmd.status"], steps: [...base, g("status"), g("status", "-s"), g("status", "-sb")] },
  {
    name: "status-mixed", covers: ["cmd.status"],
    steps: [...base, w("a.txt", "modified\n"), w("n.txt", "n\n"), g("add", "n.txt"), w("n.txt", "n2\n"), rm("dir/b.txt"), w("untracked.txt", "u\n"), g("status"), g("status", "-s"), g("status", "--porcelain"), g("status", "-sb")],
  },
  { name: "status-staged-delete", covers: ["cmd.status"], steps: [...base, rm("a.txt"), g("add", "-A"), g("status"), g("status", "-s")] },
  { name: "status-branch-other", covers: ["cmd.status"], steps: [...base, g("checkout", "-q", "-b", "feature"), g("status"), g("status", "-sb")] },

  // ---- log ---------------------------------------------------------------
  { name: "log-empty-repo", covers: ["cmd.log"], steps: [init, g("log")] },
  {
    name: "log-history", covers: ["cmd.log"],
    steps: [...base, w("a.txt", "2\n"), g("commit", "-q", "-am", "second\n\nwith a body\nof two lines"), w("c", "c\n"), g("add", "c"), commit("third"),
      g("log"), g("log", "--oneline"), g("log", "-n", "2"), g("log", "-1", "--oneline"), g("log", "HEAD~1"), g("log", "--oneline", "nosuch")],
  },

  // ---- diff --------------------------------------------------------------
  { name: "diff-clean", covers: ["cmd.diff"], steps: [...base, g("diff"), g("diff", "--cached"), g("diff", "--exit-code")] },
  {
    name: "diff-worktree", covers: ["cmd.diff"],
    steps: [...base, w("a.txt", "one\nTWO\nthree\nfour\n"), rm("dir/b.txt"), g("diff"), g("diff", "--exit-code")],
  },
  { name: "diff-cached", covers: ["cmd.diff"], steps: [...base, w("new.txt", "fresh\nfile\n"), w("a.txt", "one\nthree\n"), g("add", "."), g("diff", "--cached"), g("diff", "--staged"), g("diff")] },
  {
    name: "diff-hunks", covers: ["cmd.diff"],
    steps: [init, w("f", Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("")), g("add", "f"), commit("lines"),
      w("f", Array.from({ length: 30 }, (_, i) => (i === 1 ? "changed 2\n" : i === 25 ? "" : `line ${i + 1}\n`)).join("") + "appended\n"), g("diff"), g("diff", "-U1"), g("diff", "-U0")],
  },
  { name: "diff-no-newline", covers: ["cmd.diff"], steps: [init, w("f", "a\nb"), g("add", "f"), commit("x"), w("f", "a\nc"), g("diff"), w("f", "a\nb\n"), g("diff")] },
  { name: "diff-commits", covers: ["cmd.diff"], steps: [...base, w("a.txt", "one\ntwo\n"), g("commit", "-q", "-am", "second"), g("diff", "HEAD~1", "HEAD"), g("diff", "HEAD~1"), g("diff", "HEAD"), g("diff", "nosuch")] },
  { name: "diff-empty-repo", covers: ["cmd.diff"], steps: [init, w("a", "a\n"), g("add", "a"), g("diff"), g("diff", "--cached")] },

  // ---- branch ------------------------------------------------------------
  {
    name: "branch-ops", covers: ["cmd.branch", "refs.files"],
    steps: [...base, g("branch"), g("branch", "feature"), g("branch", "zeta"), g("branch", "alpha", "HEAD"), g("branch"), g("branch", "--list"), g("branch", "-v"),
      g("branch", "feature"), g("branch", "-d", "zeta"), g("branch", "-d", "nosuch"), g("branch", "-D", "alpha"), g("branch", "bad..name"), g("branch", "x", "nosuch"), g("branch")],
  },
  { name: "branch-delete-current", covers: ["cmd.branch"], steps: [...base, g("branch", "-d", "master")] },
  { name: "branch-delete-unmerged", covers: ["cmd.branch"], steps: [...base, g("checkout", "-q", "-b", "side"), w("s", "s\n"), g("add", "s"), commit("side"), g("checkout", "-q", "master"), g("branch", "-d", "side"), g("branch", "-D", "side")] },
  { name: "branch-empty-repo", covers: ["cmd.branch"], steps: [init, g("branch"), g("branch", "x")] },

  // ---- checkout / switch -------------------------------------------------
  {
    name: "checkout-branches", covers: ["cmd.checkout-switch", "refs.files"],
    steps: [...base, g("checkout", "-b", "feature"), w("f.txt", "feature\n"), g("add", "f.txt"), commit("on feature"), g("checkout", "master"), g("checkout", "master"),
      g("checkout", "feature"), g("checkout", "nosuch"), g("checkout", "-b", "feature")],
  },
  {
    name: "switch-branches", covers: ["cmd.checkout-switch"],
    steps: [...base, g("switch", "-c", "topic"), w("dir/b.txt", "changed bee\n"), g("commit", "-q", "-am", "topic change"), g("switch", "master"), g("switch", "master"),
      g("switch", "nosuch"), g("switch", "-c", "topic"), g("switch", "topic")],
  },
  {
    name: "checkout-dirty-conflict", covers: ["cmd.checkout-switch"],
    steps: [...base, g("checkout", "-q", "-b", "other"), w("a.txt", "other\n"), g("commit", "-q", "-am", "other"), g("checkout", "-q", "master"), w("a.txt", "local edit\n"), g("checkout", "other"), g("switch", "other"), g("status", "-s")],
  },
  {
    name: "checkout-dirty-carry", covers: ["cmd.checkout-switch"],
    steps: [...base, g("branch", "same"), w("a.txt", "local edit\n"), w("u.txt", "u\n"), g("checkout", "same"), g("status", "-s")],
  },
  { name: "checkout-file", covers: ["cmd.checkout-switch"], steps: [...base, w("a.txt", "junk\n"), g("checkout", "--", "a.txt"), g("status", "-s"), g("checkout", "--", "nope")] },
  { name: "checkout-removes-files", covers: ["cmd.checkout-switch"], steps: [...base, g("checkout", "-q", "-b", "more"), w("dir/sub/n.txt", "n\n"), g("add", "."), commit("more"), g("checkout", "master"), g("status", "-s")] },

  // ---- merge (fast-forward) ----------------------------------------------
  {
    name: "merge-ff", covers: ["cmd.merge-ff", "refs.files"],
    steps: [...base, g("checkout", "-q", "-b", "feature"), w("a.txt", "one\ntwo\nthree\nfour\n"), w("new.txt", "n\n"), g("add", "."), commit("feature work"), g("checkout", "-q", "master"),
      g("merge", "feature"), g("merge", "feature"), g("log", "--oneline")],
  },
  { name: "merge-ff-only-diverged", covers: ["cmd.merge-ff"], steps: [...base, g("checkout", "-q", "-b", "side"), w("s", "s\n"), g("add", "s"), commit("side"), g("checkout", "-q", "master"), w("m", "m\n"), g("add", "m"), commit("main"), g("merge", "--ff-only", "side")] },
  { name: "merge-bad-ref", covers: ["cmd.merge-ff"], steps: [...base, g("merge", "nosuch"), g("merge")] },
  { name: "merge-already-ancestor", covers: ["cmd.merge-ff"], steps: [...base, g("branch", "old"), w("x", "x\n"), g("add", "x"), commit("x"), g("merge", "old")] },

  // ---- added in Phase 3 to pin behaviour the first capture left open -------
  { name: "cache-tree-order", covers: ["cmd.write-tree", "index.format-v2"], steps: [init, w("zz/x", "1\n"), w("a/x", "2\n"), w("bbb/x", "3\n"), w("c/x", "4\n"), w("c/dd/x", "5\n"), w("c/e/x", "6\n"), g("add", "."), g("write-tree"), w("c/e/x", "7\n"), g("add", "c/e/x")] },
  { name: "cat-file-missing-full-hex", covers: ["cmd.cat-file"], steps: [...base, g("cat-file", "-p", "0123456789012345678901234567890123456789"), g("cat-file", "-s", "0123456789012345678901234567890123456789"), g("cat-file", "blob", "HEAD"), g("cat-file", "tree", "HEAD"), g("cat-file", "-p", "5fcf681")] },
  { name: "checkout-path-no-dashdash", covers: ["cmd.checkout-switch"], steps: [...base, w("a.txt", "junk\n"), w("dir/b.txt", "junk\n"), g("checkout", "a.txt"), g("checkout", "dir"), g("status", "-s")] },
  { name: "checkout-untracked-overwrite", covers: ["cmd.checkout-switch"], steps: [...base, g("checkout", "-q", "-b", "t"), w("u.txt", "tracked\n"), g("add", "u.txt"), commit("add u"), g("checkout", "-q", "master"), w("u.txt", "untracked\n"), g("checkout", "t"), g("merge", "t")] },
  { name: "commit-unstaged-only", covers: ["cmd.commit", "cmd.status"], steps: [...base, w("a.txt", "changed\n"), g("commit", "-m", "x"), g("status")] },
  { name: "status-subdir-relative", covers: ["cmd.status"], steps: [...base, w("top.txt", "t\n"), w("dir/sub/x", "x\n"), w("a.txt", "m\n"), gin("dir", "status"), gin("dir", "status", "-s"), gin("dir", "status", "--porcelain"), gin("dir", "diff")] },
  { name: "merge-ff-dirty", covers: ["cmd.merge-ff"], steps: [...base, g("checkout", "-q", "-b", "f"), w("a.txt", "f\n"), g("commit", "-q", "-am", "f"), g("checkout", "-q", "master"), w("a.txt", "local\n"), g("merge", "f"), w("dir/b.txt", "other\n"), g("checkout", "--", "a.txt"), g("merge", "f"), g("status", "-s")] },
  {
    name: "branch-rename-copy", covers: ["cmd.branch"],
    steps: [init, g("branch", "-M", "main"), g("status", "-sb"), w("a", "a\n"), g("add", "a"), commit("one"), g("branch", "-M", "main"), g("branch", "-m", "trunk"), g("branch"),
      g("branch", "side"), g("branch", "-m", "side", "s2"), g("branch", "-m", "s2", "trunk"), g("branch", "-M", "s2", "trunk"), g("branch", "-m", "nosuch", "x"), g("branch", "-m", "bad..name"),
      g("branch", "-c", "copy1"), g("branch", "-c", "trunk", "copy1"), g("branch", "-C", "trunk", "copy1"), g("branch", "-c", "copy1", "copy2"), g("branch", "-v"), g("log", "--oneline", "-1")],
  },
  { name: "usage-texts", covers: ["cli.exit-codes"], steps: [init, ...["add", "branch", "cat-file", "checkout", "clone", "commit", "diff", "fetch", "hash-object", "init", "log", "merge", "pull", "push", "remote", "status", "switch", "write-tree"].map((c) => g(c, "-h")), g("status", "--bogus"), g("commit", "-x"), g("diff", "--bogus")] },
  {
    name: "detached-head", covers: ["cmd.checkout-switch", "cmd.status", "cmd.branch", "cmd.commit"],
    steps: [...base, w("a.txt", "2\n"), g("commit", "-q", "-am", "second"), g("checkout", "HEAD~1"), g("status"), g("status", "-sb"), g("branch"), w("d", "d\n"), g("add", "d"), g("commit", "-m", "on detached"),
      g("switch", "master"), g("switch", "5fcf681"), g("switch", "--detach", "5fcf681"), g("checkout", "master")],
  },
  { name: "diff-move-lines", covers: ["cmd.diff"], steps: [init, w("f", "a\nb\nc\nd\ne\nf\n"), w("g", "x\n\ny\n"), g("add", "."), commit("x"), w("f", "c\nd\ne\na\nb\nf\n"), w("g", "x\n\ny\n\ny\n"), g("diff")] },
];
