// ─── Test helpers ──────────────────────────────────────────────────
//
// Shared by the node:test suites and the Playwright e2e tests:
// a recording fake Jira server and a launcher for server.js.
// ────────────────────────────────────────────────────────────────────

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Fake Jira: records every request and answers via a swappable handler.
async function startFakeJira({ tls } = {}) {
  const jira = {
    requests: [],
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
  const onRequest = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      jira.requests.push(record);
      jira.handler(req, res, record);
    });
  };
  const server = tls
    ? https.createServer(tls, onRequest)
    : http.createServer(onRequest);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  jira.url = `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}`;
  jira.last = () => jira.requests[jira.requests.length - 1];
  jira.close = () => new Promise((r) => server.close(r));
  return jira;
}

// Starts server.js and resolves once it accepts connections.
async function startApp(jiraUrl, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, jiraUrl, String(port)], {
    env: { ...process.env, HOST: "", ALLOWED_HOSTS: "", JIRA_INSECURE_TLS: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server.js exited early:\n${output}`);
    }
    if (await canConnect("127.0.0.1", port)) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server.js did not start:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    port,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.on("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(500);
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(false));
  });
}

// Raw HTTP request so the Host header can be set freely
// (`host: null` sends no Host header at all).
function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = { host: `localhost:${port}`, ...headers };
    const setHost = allHeaders.host !== null;
    if (!setHost) delete allHeaders.host;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: allHeaders,
        setHost,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { freePort, startFakeJira, startApp, canConnect, request };
