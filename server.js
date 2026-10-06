#!/usr/bin/env node
// ─── Jira Time Tracker – Server ────────────────────────────────────
//
// Serves the web app and proxies /rest/* to Jira Server.
// No CORS, no XSRF — everything on a single port.
//
// Start:
//   node server.js https://jira.your-company.com
//   node server.js https://jira.your-company.com 8080
//
// Export Jira's CA certificate (e.g. for Docker):
//   node server.js --export-ca https://jira.your-company.com > company-ca.pem
//
// Then open http://localhost:3001 in your browser.
// No dependencies required – just Node.js ≥ 22.
// ────────────────────────────────────────────────────────────────────

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const tls = require("tls");

// ─── Trusted CAs ────────────────────────────────────────────────────
// Node's bundled CAs (+ NODE_EXTRA_CA_CERTS) plus the OS trust store, so a
// Jira certificate from a company CA works whenever the browser trusts it.
// Reading the OS store needs Node ≥ 22.15; older versions use Node's CAs.

// Stryker disable all: fallbacks for Node < 22.15 — not reachable on the Node
// versions the tests run on. The OS store itself is tested in CI (trust-store).
const HAS_SYSTEM_STORE = typeof tls.getCACertificates === "function";

function systemCAs() {
  if (!HAS_SYSTEM_STORE) return [];
  try {
    return tls.getCACertificates("system");
  } catch {
    return [];
  }
}

function trustedCAs() {
  if (!HAS_SYSTEM_STORE) return undefined; // Node defaults
  return [...new Set([...tls.getCACertificates("default"), ...systemCAs()])];
}

const OLD_NODE_CERT_SOURCE = "Node built-in";
const OLD_NODE_CERT_HINT =
  "Jira's certificate is not trusted by Node. Use Node >= 22.15 (reads the " +
  "OS trust store) or set NODE_EXTRA_CA_CERTS (see README).";
// Stryker restore all

// ─── --export-ca ────────────────────────────────────────────────────
// Prints the root CA of Jira's certificate chain as PEM (stdout), with its
// subject and fingerprint on stderr so it can be compared in the browser.
// Uses only Node — no openssl needed, works inside the Docker image too.

function exportCA(target) {
  if (!target) {
    console.error("Usage: node server.js --export-ca <JIRA_URL> > company-ca.pem");
    // Stryker disable next-line all: equivalent — new URL(undefined) would exit with 1 as well
    process.exit(1);
  }
  const url = new URL(target);
  // Not verified on purpose: we want to read the chain of an untrusted cert.
  const socket = tls.connect(
    {
      host: url.hostname,
      port: url.port || 443,
      servername: url.hostname,
      rejectUnauthorized: false,
    },
    () => {
      // Stryker disable next-line all: equivalent — the loop below fills it
      const chain = [];
      const seen = new Set();
      let cert = socket.getPeerCertificate(true);
      while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        chain.push(new crypto.X509Certificate(cert.raw));
        cert = cert.issuerCertificate;
      }
      socket.end();
      // Stryker disable all: unreachable — a TLS handshake always includes a certificate
      if (!chain.length) {
        console.error(`No certificate received from ${url.host}.`);
        process.exit(1);
      }
      // Stryker restore all
      let root = chain[chain.length - 1];
      if (root.subject !== root.issuer) {
        // Root not sent by Jira — look it up in the OS trust store
        // Stryker disable next-line ArrowFunction: needs the test CA in the OS store (CI trust-store job)
        const isIssuer = (ca) => root.checkIssued(ca);
        const found = systemCAs()
          .map((pem) => new crypto.X509Certificate(pem))
          .find(isIssuer);
        // Stryker disable next-line ConditionalExpression: needs the test CA in the OS store (CI trust-store job)
        if (!found) {
          console.error(`${url.host} did not send its root CA and it is not in the OS trust store.`);
          console.error(`Issuer: ${root.issuer.replace(/\n/g, ", ")}`);
          console.error("Ask your IT department for that CA certificate.");
          // Stryker disable next-line all: equivalent — `root = undefined` below would crash with exit code 1
          process.exit(1);
        }
        root = found;
      }

      console.error(`CA:      ${root.subject.replace(/\n/g, ", ")}`);
      console.error(`SHA-256: ${root.fingerprint256}`);
      console.error(`Valid:   ${root.validFrom} – ${root.validTo}`);
      process.stdout.write(root.toString());
    }
  );
  socket.on("error", (err) => {
    console.error(`Could not connect to ${url.host}: ${err.message}`);
    process.exit(1);
  });
}

// ─── Server mode ────────────────────────────────────────────────────

function main() {
  // ─── Config ─────────────────────────────────────────────────────────

  const JIRA_BASE = (process.argv[2] || process.env.JIRA_URL || "").replace(
    /\/+$/,
    ""
  );
  // Stryker disable next-line StringLiteral: the default port can't be tested without occupying 3001
  const PORT = parseInt(process.argv[3] || process.env.PORT || "3001", 10);
  // Bind to loopback by default so the proxy (and its Jira session cookies)
  // isn't reachable from the network. Docker sets HOST=0.0.0.0.
  const HOST = process.env.HOST || "127.0.0.1";
  // TLS certificates are verified against Node's CAs and the OS trust store.
  // Extra CAs: NODE_EXTRA_CA_CERTS=/path/to/ca.pem; JIRA_INSECURE_TLS=1
  // disables checks (not recommended).
  const INSECURE_TLS = process.env.JIRA_INSECURE_TLS === "1";
  // Host names the browser may use to reach this server (DNS rebinding guard).
  const ALLOWED_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    // Stryker disable next-line StringLiteral: equivalent — a dummy default only adds an unused host name
    ...(process.env.ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ]);

  if (!JIRA_BASE) {
    console.error("");
    console.error("  Usage: node server.js <JIRA_URL> [PORT]");
    console.error("  e.g.:  node server.js https://jira.your-company.com");
    console.error("         node server.js https://jira.your-company.com 8080");
    console.error("");
    console.error(
      "  Alternatively: JIRA_URL=https://jira.your-company.com node server.js"
    );
    console.error("");
    process.exit(1);
  }

  const jiraUrl = new URL(JIRA_BASE);
  const jiraClient = jiraUrl.protocol === "https:" ? https : http;
  // Stryker disable next-line all: plain http ignores `ca`; the https case is tested via the OS trust store (Linux/CI)
  const TRUSTED_CAS = jiraUrl.protocol === "https:" ? trustedCAs() : undefined;

  // ─── Cookie Storage (for session-based XSRF bypass) ────────────────
  // One jar per Authorization header (keyed by its hash), so a Jira session
  // opened with a PAT is only reused by requests carrying that same PAT.
  // Requests without a PAT never get stored cookies.
  const MAX_COOKIE_JARS = 10;
  const cookieJars = new Map(); // sha256(Authorization) → { name: value }

  function cookieJarFor(authorization) {
    if (!authorization) return null;
    const key = crypto.createHash("sha256").update(authorization).digest("hex");
    let jar = cookieJars.get(key);
    if (jar) {
      cookieJars.delete(key); // move to the end (most recently used)
    } else {
      jar = {};
      if (cookieJars.size >= MAX_COOKIE_JARS) {
        cookieJars.delete(cookieJars.keys().next().value);
      }
    }
    cookieJars.set(key, jar);
    return jar;
  }

  // ─── Load HTML ───────────────────────────────────────────────────────

  const htmlPath = path.join(__dirname, "public", "index.html");
  let htmlContent;
  try {
    htmlContent = fs.readFileSync(htmlPath, "utf-8");
    // Inject Jira base URL into HTML
    htmlContent = htmlContent.replace(
      '</head>',
      `<script>window.JIRA_BASE_URL = ${JSON.stringify(JIRA_BASE).replace(/</g, "\\u003c")};</script></head>`
    );
  } catch (e) {
    console.error(`Error: ${htmlPath} not found.`);
    console.error("Make sure public/index.html exists.");
    process.exit(1);
  }

  const libContent = fs.readFileSync(path.join(__dirname, "public", "lib.js"));

  // TLS errors caused by a certificate from an internal/company CA
  const UNTRUSTED_CERT_ERRORS = new Set([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  const UNTRUSTED_CERT_HINT = HAS_SYSTEM_STORE
    ? "Jira's certificate is not trusted by Node or the OS trust store " +
      "(on Linux, browsers use their own store). Install the CA system-wide, " +
      "or export it with --export-ca and set NODE_EXTRA_CA_CERTS (see README)."
    : OLD_NODE_CERT_HINT;
  const CERT_SOURCE = HAS_SYSTEM_STORE ? "Node + OS trust store" : OLD_NODE_CERT_SOURCE;
  let certHintShown = false;

  // ─── Proxy ──────────────────────────────────────────────────────────

  function proxyToJira(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);

      // Forward the client's headers (Node lowercases their names). Host,
      // Origin, Referer and X-Requested-With are overwritten below; the
      // client's XSRF bypass and hop-by-hop Connection are dropped.
      const fwdHeaders = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (key !== "connection" && key !== "x-atlassian-token") {
          fwdHeaders[key] = val;
        }
      }
      fwdHeaders.host = jiraUrl.host;
      // Set Origin to Jira server (important for XSRF validation!)
      fwdHeaders.origin = JIRA_BASE;
      fwdHeaders.referer = JIRA_BASE + "/";
      fwdHeaders["x-requested-with"] = "XMLHttpRequest";

      // Add session cookies for this PAT (if available)
      const cookieJar = cookieJarFor(req.headers.authorization) || {};
      const cookieString = Object.entries(cookieJar).map(([name, value]) => `${name}=${value}`).join("; ");
      if (cookieString) {
        fwdHeaders["cookie"] = cookieString;
      }

      let requestPath = req.url;

      // For POST requests: use real XSRF token instead of "no-check" bypass
      if (req.method === "POST" && cookieJar["atlassian.xsrf.token"]) {
        // Token as query parameter (like Jira Web UI does)
        const separator = requestPath.includes("?") ? "&" : "?";
        requestPath = `${requestPath}${separator}atl_token=${encodeURIComponent(cookieJar["atlassian.xsrf.token"])}`;
        // Token also as header
        fwdHeaders["x-xsrf-token"] = cookieJar["atlassian.xsrf.token"];
      } else {
        // Everything else: use no-check bypass
        fwdHeaders["x-atlassian-token"] = "no-check";
      }

      // User-Agent if not present
      if (!fwdHeaders["user-agent"]) {
        fwdHeaders["user-agent"] = "JiraTimeTracker/1.0";
      }

      const opts = {
        hostname: jiraUrl.hostname,
        // Stryker disable next-line all: default ports need a Jira on 443/80
        port: jiraUrl.port || (jiraUrl.protocol === "https:" ? 443 : 80),
        path: requestPath,
        method: req.method,
        headers: fwdHeaders,
        rejectUnauthorized: !INSECURE_TLS,
        ca: TRUSTED_CAS,
      };

      const proxyReq = jiraClient.request(opts, (proxyRes) => {
        const resChunks = [];
        proxyRes.on("data", (c) => resChunks.push(c));
        proxyRes.on("end", () => {
          const resBody = Buffer.concat(resChunks);
          const responseHeaders = { ...proxyRes.headers };
          delete responseHeaders["transfer-encoding"];
          responseHeaders["content-length"] = resBody.length;

          // Store session cookies for future requests (Node always
          // delivers set-cookie as an array)
          // Stryker disable next-line ArrayDeclaration: equivalent — a dummy entry without "=" is skipped
          for (const cookie of proxyRes.headers["set-cookie"] || []) {
            const [nameValue] = cookie.split(";");
            const eq = nameValue.indexOf("=");
            if (eq === -1) continue;
            const name = nameValue.slice(0, eq).trim();
            const value = nameValue.slice(eq + 1).trim();
            if (name && value) {
              cookieJar[name] = value;
            }
          }

          const status = proxyRes.statusCode;
          const icon = status < 300 ? "✓" : status < 400 ? "→" : "✗";
          const method = req.method.padEnd(4);
          console.log(`  ${icon} ${method} ${req.url} → ${status}`);

          res.writeHead(status, responseHeaders);
          res.end(resBody);
        });
      });

      proxyReq.on("error", (err) => {
        console.error(`  ✗ Proxy error: ${err.message}`);
        const untrustedCert = UNTRUSTED_CERT_ERRORS.has(err.code);
        if (untrustedCert && !certHintShown) {
          console.error(`    → ${UNTRUSTED_CERT_HINT}`);
          certHintShown = true;
        }
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: untrustedCert ? `${err.message} — ${UNTRUSTED_CERT_HINT}` : err.message,
        }));
      });

      proxyReq.end(body);
    });
  }

  // ─── Request Guard ──────────────────────────────────────────────────
  // Only accept requests addressed to an allowed host name (blocks DNS
  // rebinding) and coming from this app itself (blocks cross-site requests
  // that would otherwise ride on the proxy's stored Jira session cookies).

  function hostName(hostHeader) {
    // Stryker disable next-line StringLiteral: `|| ""` — Node rejects requests without Host
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader || "");
    // Stryker disable next-line StringLiteral: any non-allowed name blocks just the same
    return m ? m[1].toLowerCase() : "";
  }

  function isTrustedRequest(req) {
    if (!ALLOWED_HOSTS.has(hostName(req.headers.host))) return false;
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return false;
    return true;
  }

  const SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };

  // ─── Server ─────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    if (!isTrustedRequest(req)) {
      console.log(`  ✗ Blocked ${req.method} ${req.url} (host: ${req.headers.host}, origin: ${req.headers.origin || "-"})`);
      res.writeHead(403, { "Content-Type": "text/plain", ...SECURITY_HEADERS });
      return res.end("Forbidden");
    }

    // Serve the app
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        ...SECURITY_HEADERS,
      });
      return res.end(htmlContent);
    }

    if (req.method === "GET" && req.url === "/lib.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        ...SECURITY_HEADERS,
      });
      return res.end(libContent);
    }

    // Proxy Jira API
    if (req.url.startsWith("/rest/")) {
      return proxyToJira(req, res);
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(PORT, HOST, () => {
    const w = 50;
    const pad = (l, r = "") =>
      `│  ${l}${" ".repeat(Math.max(0, w - 4 - l.length - r.length))}${r}  │`;
    console.log("");
    console.log(`┌${"─".repeat(w)}┐`);
    console.log(pad("Jira Time Tracker"));
    console.log(`├${"─".repeat(w)}┤`);
    console.log(pad("Jira Server:", JIRA_BASE));
    if (jiraUrl.protocol === "https:") {
      console.log(pad("Certificates:", CERT_SOURCE));
    }
    console.log(pad("App:", `http://localhost:${PORT}`));
    console.log(`├${"─".repeat(w)}┤`);
    console.log(pad(`Open in browser: http://localhost:${PORT}`));
    console.log(pad("Enter your PAT in the app, done."));
    if (INSECURE_TLS) {
      console.log(`├${"─".repeat(w)}┤`);
      console.log(pad("WARNING: TLS certificate checks disabled"));
    }
    console.log(`└${"─".repeat(w)}┘`);
    console.log("");
  });

  // Graceful shutdown (important for Docker — Node is PID 1). Also cut
  // connections with requests still in flight (e.g. waiting on Jira).
  const shutdown = () => {
    console.log("\nShutting down…");
    // Stryker disable next-line ArrowFunction: equivalent — with all connections closed the process exits anyway
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[2] === "--export-ca") {
  exportCA(process.argv[3] || process.env.JIRA_URL);
} else {
  main();
}
