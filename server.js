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
// Then open http://localhost:3001 in your browser.
// No dependencies required – just Node.js ≥ 18.
// ────────────────────────────────────────────────────────────────────

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { exec } = require("child_process");

// ─── Config ─────────────────────────────────────────────────────────

const JIRA_BASE = (process.argv[2] || process.env.JIRA_URL || "").replace(
  /\/+$/,
  ""
);
const PORT = parseInt(process.argv[3] || process.env.PORT || "3001", 10);

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

// ─── Cookie Storage (for session-based XSRF bypass) ────────────────
const cookieJar = {}; // Stores cookies by name

// ─── Load HTML ───────────────────────────────────────────────────────

const htmlPath = path.join(__dirname, "public", "index.html");
let htmlContent;
try {
  htmlContent = fs.readFileSync(htmlPath, "utf-8");
  // Inject Jira base URL into HTML
  htmlContent = htmlContent.replace(
    '</head>',
    `<script>window.JIRA_BASE_URL = ${JSON.stringify(JIRA_BASE)};</script></head>`
  );
} catch (e) {
  console.error(`Error: ${htmlPath} not found.`);
  console.error("Make sure public/index.html exists.");
  process.exit(1);
}

// ─── Proxy ──────────────────────────────────────────────────────────

function proxyToJira(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    // Forward headers, strip browser origin/referer
    const fwdHeaders = {};
    const skipHeaders = ["host", "origin", "referer", "connection"];
    for (const [key, val] of Object.entries(req.headers)) {
      if (!skipHeaders.includes(key.toLowerCase())) {
        fwdHeaders[key] = val;
      }
    }
    fwdHeaders.host = jiraUrl.host;
    // Set Origin to Jira server (important for XSRF validation!)
    fwdHeaders.origin = JIRA_BASE;
    fwdHeaders.referer = JIRA_BASE + "/";

    // Remove XSRF headers from client
    delete fwdHeaders["X-Atlassian-Token"];
    delete fwdHeaders["x-atlassian-token"];
    delete fwdHeaders["X-Requested-With"];
    delete fwdHeaders["x-requested-with"];

    // Add session cookies (if available)
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
      fwdHeaders["X-XSRF-TOKEN"] = cookieJar["atlassian.xsrf.token"];
      fwdHeaders["X-Requested-With"] = "XMLHttpRequest";
    } else {
      // For GET: use no-check bypass
      fwdHeaders["X-Atlassian-Token"] = "no-check";
      fwdHeaders["X-Requested-With"] = "XMLHttpRequest";
    }

    // User-Agent if not present
    if (!fwdHeaders["user-agent"] && !fwdHeaders["User-Agent"]) {
      fwdHeaders["User-Agent"] = "JiraTimeTracker/1.0";
    }

    const opts = {
      hostname: jiraUrl.hostname,
      port: jiraUrl.port || (jiraUrl.protocol === "https:" ? 443 : 80),
      path: requestPath,
      method: req.method,
      headers: fwdHeaders,
      rejectUnauthorized: false,
    };

    const proxyReq = jiraClient.request(opts, (proxyRes) => {
      const resChunks = [];
      proxyRes.on("data", (c) => resChunks.push(c));
      proxyRes.on("end", () => {
        const resBody = Buffer.concat(resChunks);
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders["transfer-encoding"];
        responseHeaders["content-length"] = resBody.length;

        // Store session cookies for future requests
        const setCookie = proxyRes.headers["set-cookie"];
        if (setCookie) {
          const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
          cookies.forEach(cookie => {
            const [nameValue] = cookie.split(";");
            const [name, value] = nameValue.split("=");
            if (name && value) {
              cookieJar[name.trim()] = value.trim();
            }
          });
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
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

// ─── Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Serve the app
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    return res.end(htmlContent);
  }

  // Proxy Jira API
  if (req.url.startsWith("/rest/")) {
    return proxyToJira(req, res);
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  const w = 50;
  const pad = (l, r = "") =>
    `│  ${l}${" ".repeat(Math.max(0, w - 4 - l.length - r.length))}${r}  │`;
  console.log("");
  console.log(`┌${"─".repeat(w)}┐`);
  console.log(pad("Jira Time Tracker"));
  console.log(`├${"─".repeat(w)}┤`);
  console.log(pad("Jira Server:", JIRA_BASE));
  console.log(pad("App:", `http://localhost:${PORT}`));
  console.log(`├${"─".repeat(w)}┤`);
  console.log(pad(`Open in browser: http://localhost:${PORT}`));
  console.log(pad("Enter your PAT in the app, done."));
  console.log(`└${"─".repeat(w)}┘`);
  console.log("");
});

// Track open connections for fast shutdown
const connections = new Set();
server.on("connection", (conn) => {
  connections.add(conn);
  conn.on("close", () => connections.delete(conn));
});

// Graceful shutdown (important for Docker — Node is PID 1)
const shutdown = () => {
  console.log("\nShutting down…");
  server.close(() => process.exit(0));
  for (const conn of connections) conn.destroy();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
