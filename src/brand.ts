// Product identity. pkb is a rebranded reimplementation of git's v1 command subset:
// the repository lives in ".pkb", ignore files are ".pkbignore", configuration is
// "~/.pkbconfig" / "$XDG_CONFIG_HOME/pkb/config", and environment variables use the
// PKB_ prefix. On-disk formats (objects, index, refs, reflogs, packs) and the
// "diff --git" patch header stay git-compatible, so `git --git-dir=.pkb` can read a pkb
// repository and patches still apply with git/patch tools.
export const NAME = "pkb";
export const VERSION = "0.1.0";
export const REPO_DIR = ".pkb";
export const IGNORE_FILE = ".pkbignore";
export const GITDIR_FILE_KEY = "pkbdir"; // ".pkb" file pointing elsewhere: "pkbdir: <path>"
export const CONFIG_FILE = ".pkbconfig";
export const XDG_DIR = "pkb";

// PKB_<name> environment lookup (PKB_DIR, PKB_WORK_TREE, PKB_AUTHOR_NAME, ...).
export function env(name: string): string | undefined {
  return process.env[`PKB_${name}`];
}

// Map text observed from the real git (fixtures, usage blocks) to pkb's wording.
// Used by recon/gen-usage-text.mjs and by the parity harness to derive expectations.
export function rebrand(s: string): string {
  // URLs are data (a remote "r.git" stays "r.git"): park them before rewriting
  const urls: string[] = [];
  s = s.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\{URL\}|\{AUTH\}|\{SSH\}|\{SCP\}|<HOST>|<CRED>@)[^\s'"]*/gi, (m) => `\u0000URL${urls.push(m) - 1}\u0000`);
  return s
    .replace(/diff --git /g, "\u0000DIFFHDR\u0000")
    .replace(/in Git 3\.0/g, "in a future pkb release")
    .replace(/\.gitignore\b/g, IGNORE_FILE)
    .replace(/\.gitconfig\b/g, CONFIG_FILE)
    .replace(/(^|[^A-Za-z0-9_])\.git(?=$|[^A-Za-z0-9_])/gm, `$1${REPO_DIR}`)
    .replace(/--git-dir/g, "--pkb-dir")
    .replace(/separate-git-dir/g, "separate-pkb-dir")
    .replace(/<gitdir>/g, "<pkbdir>")
    .replace(/\bGit\b/g, NAME)
    .replace(/(?<![\w-]\.)\bgit\b/g, NAME) // "name.git" (a repository name, e.g. localhost:r.git) is data
    .replace(/\u0000DIFFHDR\u0000/g, "diff --git ")
    .replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)]);
}

// pkb's own top-level help: lists only the commands pkb implements (git's help, captured in
// fixtures/cli-no-args, lists many git commands that pkb does not have).
export const HELP = [
  "usage: pkb [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]",
  "           [--pkb-dir=<path>] [--work-tree=<path>] [--bare]",
  "           <command> [<args>]",
  "",
  "These are the pkb commands:",
  "",
  "start a working area",
  "   init         Create an empty pkb repository or reinitialize an existing one",
  "",
  "work on the current change",
  "   add          Add file contents to the index",
  "",
  "examine the history and state",
  "   diff         Show changes between commits, commit and working tree, etc",
  "   log          Show commit logs",
  "   status       Show the working tree status",
  "",
  "grow, mark and tweak your common history",
  "   branch       List, create, or delete branches",
  "   checkout     Switch branches or restore working tree files",
  "   commit       Record changes to the repository",
  "   merge        Fast-forward the current branch to another commit",
  "   switch       Switch branches",
  "",
  "low-level commands",
  "   cat-file     Provide contents or details of repository objects",
  "   hash-object  Compute object ID and optionally create an object from a file",
  "   write-tree   Create a tree object from the current index",
  "",
  "See 'pkb <command> -h' for the options of a command.",
  "",
].join("\n");
