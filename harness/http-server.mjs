// Local smart-HTTP git server for network tests: forwards every request to the real
// git's CGI program `git-http-backend` (the server side of the protocol GitHub speaks).
// Usage: node harness/http-server.mjs <projectRoot> <port> [token]
//   token: when given, pushes (git-receive-pack) need HTTP Basic auth whose password equals
//   it, mimicking a GitHub personal access token; fetches stay anonymous.
// Prints "listening <port>" once ready.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const [root, port, token] = process.argv.slice(2);
const BACKEND = "C:/Program Files/Git/mingw64/libexec/git-core/git-http-backend.exe";

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const isPush = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
  let user = "";
  const auth = req.headers.authorization;
  if (auth?.startsWith("Basic ")) {
    const [u, p] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (!token || p === token) user = u || "anonymous";
  }
  if (isPush && token && !user) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="pkb-test"', "Content-Type": "text/plain" });
    res.end("authentication required\n");
    return;
  }
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_ADDR: "127.0.0.1",
    ...(user || !token ? { REMOTE_USER: user || "anonymous" } : {}),
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
    ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
  };
  const cgi = spawn(BACKEND, [], { env });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), sent = false;
  cgi.stdout.on("data", (chunk) => {
    if (sent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    let sep = head.indexOf("\r\n\r\n"), len = 4;
    if (sep < 0) { sep = head.indexOf("\n\n"); len = 2; }
    if (sep < 0) return;
    const headers = {};
    let status = 200;
    for (const line of head.subarray(0, sep).toString().split(/\r?\n/)) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(sep + len));
    sent = true;
  });
  cgi.stdout.on("end", () => res.end());
  cgi.stderr.on("data", () => {});
}).listen(Number(port), "127.0.0.1", () => console.log(`listening ${port}`));
