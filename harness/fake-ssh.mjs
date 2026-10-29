// Stand-in for `ssh` in tests: instead of connecting to a host it runs the requested git
// service locally (the real git-upload-pack / git-receive-pack) on a repository under
// $FAKE_SSH_ROOT, with stdin/stdout wired straight through, exactly as sshd would.
// Invoked as: fake-ssh.mjs [ssh options...] <host> "git-upload-pack '<path>'"
import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[args.length - 1];
const m = command.match(/^(git-upload-pack|git-receive-pack|git-upload-archive)\s+'?(.*?)'?$/);
if (!m) {
  process.stderr.write(`fake-ssh: unsupported command: ${command}\n`);
  process.exit(255);
}
const root = process.env.FAKE_SSH_ROOT;
const path = join(root, m[2].replace(/^\/+/, "").replace(/^~\//, ""));
const service = m[1].slice(4); // upload-pack / receive-pack
const child = spawn("C:/Program Files/Git/mingw64/bin/git.exe", [service, path], {
  stdio: ["pipe", "inherit", "inherit"],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
});
process.stdin.pipe(child.stdin);
child.on("exit", (code) => process.exit(code ?? 1));
