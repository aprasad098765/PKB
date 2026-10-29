// Held-out scenarios: written after the implementation passed harness/scenarios.mjs and
// captured from the real git before any fix, to measure parity on unseen cases.
const g = (...git) => ({ git });
const gin = (cwd, ...git) => ({ git, cwd });
const gstdin = (stdin, ...git) => ({ git, stdin });
const w = (write, content) => ({ write, content });
const rm = (p) => ({ rm: p });
const init = g("init", "-q");
const commit = (msg) => g("commit", "-q", "-m", msg);
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1) + "\n").join("");
const base = [init, w("a.txt", "one\ntwo\nthree\n"), w("dir/b.txt", "bee\n"), g("add", "."), commit("first")];

export const holdout = [
  {
    name: "ho-ignore-rules", covers: ["cmd.status", "cmd.add"],
    steps: [init, w(".gitignore", "build/\n*.tmp\n!keep.tmp\n/rootonly\nlogs/**/*.log\n"), w("build/out.o", "o\n"), w("a.tmp", "t\n"), w("keep.tmp", "k\n"),
      w("rootonly", "r\n"), w("sub/rootonly", "s\n"), w("logs/x/y.log", "l\n"), w("logs/x/y.txt", "t\n"), w("sub/.gitignore", "*.md\n"), w("sub/r.md", "m\n"), w("sub/ok.txt", "o\n"),
      g("status", "--porcelain"), g("add", "."), g("status", "--short"), g("add", "a.tmp"), g("add", "-f", "a.tmp"), g("status", "-s")],
  },
  {
    name: "ho-log-range-path", covers: ["cmd.log"],
    steps: [...base, g("checkout", "-q", "-b", "feat"), w("f1", "1\n"), g("add", "f1"), commit("f one"), w("a.txt", "changed\n"), g("commit", "-q", "-am", "f two"),
      g("log", "--oneline", "master..feat"), g("log", "--oneline", "feat", "^master"), g("log", "--oneline", "--", "a.txt"), g("log", "--oneline", "-3"), g("log", "--oneline", "--reverse"),
      g("log", "-1"), g("log", "--oneline", "feat~1"), g("log", "--oneline", "master..")],
  },
  {
    name: "ho-diff-mixed", covers: ["cmd.diff"],
    steps: [...base, w("bin.dat", "\0\x01\x02binary\n"), w("dir/sub/new.txt", "n1\nn2\n"), w("a.txt", "zero\none\ntwo\nthree\n"), g("add", "."),
      g("diff", "--cached"), g("diff", "--cached", "--stat"), g("diff", "--cached", "--name-only"), g("diff", "--cached", "--name-status"), g("diff", "--cached", "--", "dir"), commit("second"),
      w("bin.dat", "\0\x01\x03binary\n"), g("diff"), g("diff", "HEAD~1", "--stat"), g("diff", "HEAD~1..HEAD", "--", "a.txt")],
  },
  {
    name: "ho-rename-staged", covers: ["cmd.status", "cmd.commit", "cmd.diff"],
    steps: [...base, rm("dir/b.txt"), w("dir/c.txt", "bee\n"), g("add", "-A"), g("status"), g("status", "-s"), g("diff", "--cached"), g("diff", "--cached", "--stat"), g("commit", "-m", "rename")],
  },
  {
    name: "ho-amend", covers: ["cmd.commit", "cmd.log"],
    steps: [...base, w("x", "x\n"), g("add", "x"), g("commit", "-m", "wip"), g("commit", "--amend", "-m", "real message"), g("log", "--oneline"), g("commit", "--amend", "-q", "-m", "again")],
  },
  {
    name: "ho-commit-file-msg", covers: ["cmd.commit"],
    steps: [...base, w("msg.txt", "From file\n\nWith body.\n"), w("x", "x\n"), g("add", "x"), g("commit", "-F", "msg.txt"), g("log", "-1"), w("y", "y\n"), g("add", "y"), gstdin("stdin msg\n", "commit", "-q", "-F", "-"), g("log", "--oneline", "-1")],
  },
  {
    name: "ho-branch-misc", covers: ["cmd.branch", "cmd.checkout-switch"],
    steps: [...base, w("a.txt", "2\n"), g("commit", "-q", "-am", "second"), g("branch", "old", "HEAD~1"), g("checkout", "-b", "fromold", "old"), g("branch", "-v"), g("branch", "--show-current"),
      g("checkout", "-"), g("switch", "-"), g("branch", "-d", "old"), g("checkout", "-q", "master"), g("branch", "-d", "fromold"), g("branch", "-d", "a", "b")],
  },
  {
    name: "ho-merge-ff-tree", covers: ["cmd.merge-ff"],
    steps: [...base, g("checkout", "-q", "-b", "big"), rm("dir/b.txt"), w("new/deep/f.txt", "f\n"), w("a.txt", lines(20)), g("add", "-A"), commit("restructure"), g("checkout", "-q", "master"),
      g("merge", "--ff-only", "big"), g("status", "-s"), g("log", "--oneline")],
  },
  {
    name: "ho-add-variants", covers: ["cmd.add"],
    steps: [...base, w("dir/c.txt", "c\n"), w("dir/d.md", "d\n"), w("a.txt", "mod\n"), g("add", "dir/*.txt"), g("status", "-s"), g("add", "-u"), g("status", "-s"), rm("dir/b.txt"), g("add", "dir/b.txt"), g("status", "-s"),
      gin("dir", "add", "d.md"), g("status", "-s"), g("add", "-n", ".")],
  },
  {
    name: "ho-plumbing", covers: ["cmd.hash-object", "cmd.cat-file", "cmd.write-tree"],
    steps: [...base, w("p1", "p1\n"), w("p2", "p2\n"), gstdin("p1\np2\n", "hash-object", "--stdin-paths"), g("cat-file", "-p", "HEAD^{tree}"), g("cat-file", "commit", "HEAD"),
      g("cat-file", "-s", "HEAD:a.txt"), g("write-tree", "--prefix=dir/"), g("cat-file", "-t", "HEAD:dir"), g("cat-file", "-p", "HEAD:dir"), g("hash-object", "-t", "commit", "p1")],
  },
  {
    name: "ho-untracked-layout", covers: ["cmd.status"],
    steps: [...base, w("dir/u1", "u\n"), w("newdir/x/y", "y\n"), w("ign/z.log", "z\n"), w(".gitignore", "*.log\n"), { mkdir: "emptydir" }, g("status"), g("status", "-s"), gin("newdir", "status", "-s")],
  },
  {
    name: "ho-diff-large", covers: ["cmd.diff"],
    steps: [init, w("f", lines(120)), g("add", "f"), commit("x"),
      w("f", lines(120, (i) => (i % 17 === 0 ? `changed ${i}` : i === 50 ? `line 50\nextra a\nextra b` : i === 90 ? null : `line ${i}`)).replace(/null\n/g, "")), g("diff"), g("diff", "-U5")],
  },
  {
    name: "ho-diff-code", covers: ["cmd.diff"],
    steps: [init, w("m.c", "#include <stdio.h>\n\nint a(void)\n{\n\treturn 1;\n}\n\nint main(void)\n{\n\tprintf(\"x\");\n\treturn 0;\n}\n"), g("add", "m.c"), commit("c"),
      w("m.c", "#include <stdio.h>\n\nint a(void)\n{\n\treturn 1;\n}\n\nint b(void)\n{\n\treturn 2;\n}\n\nint main(void)\n{\n\tprintf(\"x\");\n\tprintf(\"y\");\n\treturn 0;\n}\n"), g("diff")],
  },
  {
    name: "ho-unicode-paths", covers: ["cmd.status", "cmd.diff", "cmd.add"],
    steps: [init, w("café.txt", "c\n"), w("sp ace.txt", "s\n"), g("status", "-s"), g("add", "."), g("status"), g("diff", "--cached", "--stat"), commit("u"), g("log", "--oneline")],
  },
  {
    name: "ho-checkout-commit-files", covers: ["cmd.checkout-switch"],
    steps: [...base, w("a.txt", "v2\n"), g("commit", "-q", "-am", "v2"), g("checkout", "HEAD~1", "--", "a.txt"), g("status", "-s"), g("checkout", "HEAD", "a.txt"), g("status", "-s"), g("checkout", "-q", "HEAD~1"), g("status")],
  },
  {
    name: "ho-errors", covers: ["cli.exit-codes", "cmd.commit", "cmd.branch", "cmd.log", "cmd.cat-file"],
    steps: [...base, g("commit"), g("branch", "-d"), g("log", "-n"), g("cat-file", "-t"), g("cat-file", "bogus", "HEAD"), g("switch"), g("checkout"), g("status", "extra-path-not-there"), g("diff", "HEAD", "HEAD~5")],
  },
];
