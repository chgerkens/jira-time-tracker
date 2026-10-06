// ─── Server tests ──────────────────────────────────────────────────
//
// Starts server.js as a child process in front of a fake Jira server
// and checks it over HTTP. Uses only Node built-ins: `npm test`.
// ────────────────────────────────────────────────────────────────────

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { companyCerts } = require("./certs");

const SERVER_JS = path.join(__dirname, "..", "server.js");
const { freePort, startFakeJira, startApp, canConnect, connectResult, waitForOutput, request } = require("./helpers");

// ─── Static app ─────────────────────────────────────────────────────

describe("serving the app", () => {
  let jira, app;
  before(async () => {
    jira = await startFakeJira();
    app = await startApp(jira.url);
  });
  after(async () => {
    await app.stop();
    await jira.close();
  });

  test("serves index.html on / with the Jira URL injected", async () => {
    const res = await request(app.port, { path: "/" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.ok(
      res.body.includes(`window.JIRA_BASE_URL = ${JSON.stringify(jira.url)};`)
    );
  });

  test("serves index.html on /index.html", async () => {
    const res = await request(app.port, { path: "/index.html" });
    assert.equal(res.status, 200);
  });

  test("sets security headers on the app page", async () => {
    const res = await request(app.port, { path: "/" });
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
  });

  test("serves /lib.js as JavaScript", async () => {
    const res = await request(app.port, { path: "/lib.js" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/javascript/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.body, /function todayKey/);
  });

  test("index.html loads /lib.js before the app script", async () => {
    const res = await request(app.port, { path: "/" });
    const lib = res.body.indexOf('<script src="/lib.js">');
    const appScript = res.body.indexOf('<script type="text/babel">');
    assert.ok(lib > 0 && lib < appScript);
  });

  test("injects the Jira URL right before </head>", async () => {
    const res = await request(app.port, { path: "/" });
    assert.ok(res.body.includes(`window.JIRA_BASE_URL = ${JSON.stringify(jira.url)};</script></head>`));
    assert.ok(res.body.startsWith("<!DOCTYPE html>"));
  });

  test("the app and lib.js are not cached", async () => {
    for (const p of ["/", "/lib.js"]) {
      const res = await request(app.port, { path: p });
      assert.equal(res.headers["cache-control"], "no-cache", p);
    }
  });

  test("only GET serves the app files", async () => {
    for (const p of ["/", "/index.html", "/lib.js"]) {
      const res = await request(app.port, { method: "POST", path: p, body: "x" });
      assert.equal(res.status, 404, p);
    }
  });

  test("returns 404 for unknown paths", async () => {
    const res = await request(app.port, { path: "/secret.txt" });
    assert.equal(res.status, 404);
    assert.equal(res.headers["content-type"], "text/plain");
    assert.equal(res.body, "Not Found");
  });

  test("CDN scripts are pinned with subresource integrity", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "..", "public", "index.html"),
      "utf-8"
    );
    const scripts = html.match(/<script[^>]+src="https?:[^"]+"[^>]*>/g) || [];
    assert.ok(scripts.length > 0);
    for (const tag of scripts) {
      assert.match(tag, /integrity="sha(256|384|512)-[^"]+"/, tag);
      assert.match(tag, /crossorigin="anonymous"/, tag);
    }
  });
});

describe("escaping the injected Jira URL", () => {
  test("a </script> in the URL cannot break out of the script tag", async () => {
    const jira = await startFakeJira();
    const app = await startApp(`${jira.url}/</script><script>alert(1)//`);
    try {
      const res = await request(app.port, { path: "/" });
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes("</script><script>alert(1)"));
      assert.ok(res.body.includes("\\u003c/script>"));
    } finally {
      await app.stop();
      await jira.close();
    }
  });
});

// ─── Proxy ──────────────────────────────────────────────────────────

describe("proxying /rest/* to Jira", () => {
  let jira, app;
  before(async () => {
    jira = await startFakeJira();
    app = await startApp(jira.url);
  });
  after(async () => {
    await app.stop();
    await jira.close();
  });

  test("forwards method, path, query, body and auth", async () => {
    const res = await request(app.port, {
      method: "PUT",
      path: "/rest/api/2/issue/ABC-1/worklog/42?adjustEstimate=leave",
      headers: {
        authorization: "Bearer secret-pat",
        "content-type": "application/json",
      },
      body: JSON.stringify({ timeSpentSeconds: 900 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });

    const req = jira.last();
    assert.equal(req.method, "PUT");
    assert.equal(req.url, "/rest/api/2/issue/ABC-1/worklog/42?adjustEstimate=leave");
    assert.equal(req.headers.authorization, "Bearer secret-pat");
    assert.deepEqual(JSON.parse(req.body), { timeSpentSeconds: 900 });
  });

  test("rewrites Host, Origin and Referer to the Jira server", async () => {
    await request(app.port, {
      method: "PUT",
      path: "/rest/api/2/myself",
      headers: { origin: `http://localhost:${app.port}` },
    });
    const req = jira.last();
    const jiraHost = new URL(jira.url).host;
    assert.equal(req.headers.host, jiraHost);
    assert.equal(req.headers.origin, jira.url);
    assert.equal(req.headers.referer, `${jira.url}/`);
  });

  test("sets XSRF bypass headers and drops client-supplied ones", async () => {
    await request(app.port, {
      path: "/rest/api/2/myself",
      headers: { "x-atlassian-token": "client-value", "x-requested-with": "client-value" },
    });
    const req = jira.last();
    assert.equal(req.headers["x-atlassian-token"], "no-check");
    assert.equal(req.headers["x-requested-with"], "XMLHttpRequest");
  });

  test("sends a default User-Agent but keeps the client's", async () => {
    await request(app.port, { path: "/rest/api/2/myself" });
    assert.equal(jira.last().headers["user-agent"], "JiraTimeTracker/1.0");
    await request(app.port, { path: "/rest/api/2/myself", headers: { "user-agent": "Browser/1.0" } });
    assert.equal(jira.last().headers["user-agent"], "Browser/1.0");
  });

  test("does not forward the client's Connection header", async () => {
    await request(app.port, { path: "/rest/api/2/myself", headers: { connection: "close", "x-custom": "kept" } });
    assert.notEqual(jira.last().headers.connection, "close");
    assert.equal(jira.last().headers["x-custom"], "kept");
  });

  test("logs each proxied request with its status", async () => {
    const cases = [[200, "✓"], [299, "✓"], [300, "→"], [302, "→"], [399, "→"], [400, "✗"], [500, "✗"]];
    for (const [status, icon] of cases) {
      jira.handler = (req, res) => { res.writeHead(status); res.end(); };
      await request(app.port, { method: "PUT", path: `/rest/api/2/status/${status}` });
      await waitForOutput(app, new RegExp(`  ${icon} PUT  /rest/api/2/status/${status} → ${status}\n`));
    }
    jira.handler = (req, res) => res.end("{}");
  });

  test("passes redirects through unchanged", async () => {
    jira.handler = (req, res) => {
      res.writeHead(302, { Location: "/login.jsp" });
      res.end();
    };
    try {
      const res = await request(app.port, { path: "/rest/api/2/myself" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/login.jsp");
    } finally {
      jira.handler = (req, res) => res.end("{}");
    }
  });

  test("passes Jira status codes and bodies through", async () => {
    jira.handler = (req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errorMessages: ["nope"] }));
    };
    try {
      const res = await request(app.port, { path: "/rest/api/2/myself" });
      assert.equal(res.status, 401);
      assert.deepEqual(JSON.parse(res.body), { errorMessages: ["nope"] });
    } finally {
      jira.handler = (req, res) => res.end("{}");
    }
  });
});

describe("Jira session cookies", () => {
  const PAT = { authorization: "Bearer pat-of-jane" };
  const OTHER_PAT = { authorization: "Bearer pat-of-max" };
  let jira, app;
  before(async () => {
    jira = await startFakeJira();
    app = await startApp(jira.url);
    // Jane's first request opens a Jira session
    jira.handler = (req, res) => {
      res.writeHead(200, {
        "Set-Cookie": [
          "JSESSIONID=abc123; Path=/; HttpOnly",
          "atlassian.xsrf.token=TOKEN|with=equals|lin; Path=/",
        ],
      });
      res.end("{}");
    };
    await request(app.port, { path: "/rest/api/2/myself", headers: PAT });
    jira.handler = (req, res) => res.end("{}");
  });
  after(async () => {
    await app.stop();
    await jira.close();
  });

  test("sends stored cookies on later requests with the same PAT", async () => {
    await request(app.port, { path: "/rest/api/2/myself", headers: PAT });
    // Values containing "=" must be kept whole.
    assert.equal(jira.last().headers.cookie, "JSESSIONID=abc123; atlassian.xsrf.token=TOKEN|with=equals|lin");
  });

  test("only POST uses the stored XSRF token; other methods use no-check", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      await request(app.port, { method, path: "/rest/api/2/issue/ABC-1/worklog/1", headers: PAT });
      const req = jira.last();
      assert.equal(req.headers["x-atlassian-token"], "no-check", method);
      assert.equal(req.headers["x-xsrf-token"], undefined, method);
      assert.equal(new URL(req.url, "http://x").searchParams.get("atl_token"), null, method);
    }
  });

  test("POST requests carry the stored XSRF token", async () => {
    await request(app.port, {
      method: "POST",
      path: "/rest/api/2/issue/ABC-1/worklog?notifyUsers=false",
      headers: { ...PAT, "x-atlassian-token": "no-check" }, // client's bypass is dropped
      body: "{}",
    });
    const req = jira.last();
    const url = new URL(req.url, "http://x");
    assert.equal(url.searchParams.get("notifyUsers"), "false");
    assert.equal(url.searchParams.get("atl_token"), "TOKEN|with=equals|lin");
    assert.equal(req.headers["x-xsrf-token"], "TOKEN|with=equals|lin");
    assert.equal(req.headers["x-requested-with"], "XMLHttpRequest");
    assert.equal(req.headers["x-atlassian-token"], undefined);
  });

  test("appends the XSRF token to a POST without a query string", async () => {
    await request(app.port, {
      method: "POST",
      path: "/rest/api/2/issue/ABC-1/worklog",
      headers: PAT,
      body: "{}",
    });
    const url = new URL(jira.last().url, "http://x");
    assert.equal(url.pathname, "/rest/api/2/issue/ABC-1/worklog");
    assert.equal(url.searchParams.get("atl_token"), "TOKEN|with=equals|lin");
  });

  test("ignores malformed Set-Cookie headers", async () => {
    jira.handler = (req, res) => {
      res.writeHead(200, { "Set-Cookie": ["garbage", "=novalue", "empty=", "ok=1", " spaced = 2 ; Path=/"] });
      res.end("{}");
    };
    const pat = { authorization: "Bearer pat-for-malformed-cookies" };
    await request(app.port, { path: "/rest/api/2/myself", headers: pat });
    jira.handler = (req, res) => res.end("{}");

    await request(app.port, { path: "/rest/api/2/myself", headers: pat });
    assert.equal(jira.last().headers.cookie, "ok=1; spaced=2");
  });

  test("requests without a PAT never get the stored session", async () => {
    // e.g. a script on the network sending a spoofed Host header
    await request(app.port, { path: "/rest/api/2/myself" });
    assert.equal(jira.last().headers.cookie, undefined);

    await request(app.port, {
      method: "POST",
      path: "/rest/api/2/issue/ABC-1/worklog",
      body: "{}",
    });
    const req = jira.last();
    assert.equal(req.headers.cookie, undefined);
    assert.equal(new URL(req.url, "http://x").searchParams.get("atl_token"), null);
    assert.equal(req.headers["x-xsrf-token"], undefined);
  });

  test("a different PAT does not get another user's session", async () => {
    await request(app.port, { path: "/rest/api/2/myself", headers: OTHER_PAT });
    assert.equal(jira.last().headers.cookie, undefined);
  });

  test("cookies set on a request without a PAT are not stored", async () => {
    jira.handler = (req, res) => {
      res.writeHead(200, { "Set-Cookie": "planted=evil; Path=/" });
      res.end("{}");
    };
    await request(app.port, { path: "/rest/api/2/myself" });
    jira.handler = (req, res) => res.end("{}");

    await request(app.port, { path: "/rest/api/2/myself" });
    assert.equal(jira.last().headers.cookie, undefined);
    await request(app.port, { path: "/rest/api/2/myself", headers: PAT });
    assert.doesNotMatch(jira.last().headers.cookie, /planted/);
  });
});

describe("session limit", () => {
  let jira, app;
  before(async () => {
    jira = await startFakeJira();
    app = await startApp(jira.url);
  });
  after(async () => {
    await app.stop();
    await jira.close();
  });

  const auth = (i) => ({ authorization: `Bearer t${i}` });
  async function cookieFor(i) {
    await request(app.port, { path: "/rest/api/2/myself", headers: auth(i) });
    return jira.last().headers.cookie;
  }

  test("keeps 10 sessions and drops the least recently used", async () => {
    // open sessions t0 … t9
    for (let i = 0; i < 10; i++) {
      jira.handler = (req, res) => {
        res.writeHead(200, { "Set-Cookie": `JSESSIONID=s${i}` });
        res.end("{}");
      };
      await request(app.port, { path: "/rest/api/2/myself", headers: auth(i) });
    }
    jira.handler = (req, res) => res.end("{}");

    assert.equal(await cookieFor(0), "JSESSIONID=s0"); // t0 is now most recently used
    assert.equal(await cookieFor(10), undefined);       // 11th session evicts t1
    assert.equal(await cookieFor(0), "JSESSIONID=s0");
    assert.equal(await cookieFor(1), undefined);        // evicted (re-adding it evicts t2)
    assert.equal(await cookieFor(3), "JSESSIONID=s3");  // the rest are still there
    assert.equal(await cookieFor(9), "JSESSIONID=s9");
  });
});

describe("configuration", () => {
  function runServer(args, env) {
    return new Promise((resolve) => {
      execFile(process.execPath, [SERVER_JS, ...args], {
        env: { ...process.env, JIRA_URL: "", PORT: "", ...env },
        timeout: 5000,
      }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
  }

  test("prints usage and exits without a Jira URL", async () => {
    const { code, stderr } = await runServer([]);
    assert.equal(code, 1);
    assert.equal(stderr, [
      "",
      "  Usage: node server.js <JIRA_URL> [PORT]",
      "  e.g.:  node server.js https://jira.your-company.com",
      "         node server.js https://jira.your-company.com 8080",
      "",
      "  Alternatively: JIRA_URL=https://jira.your-company.com node server.js",
      "",
      "",
    ].join("\n"));
  });

  test("reads JIRA_URL and PORT from the environment", async () => {
    const jira = await startFakeJira();
    const port = await freePort();
    const child = require("node:child_process").spawn(process.execPath, [SERVER_JS], {
      env: { ...process.env, JIRA_URL: `${jira.url}//`, PORT: String(port), HOST: "" },
      stdio: "ignore",
    });
    try {
      let res;
      for (let i = 0; i < 100 && !res; i++) {
        res = await request(port, { path: "/rest/api/2/myself" }).catch(() => null);
        if (!res) await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(res.status, 200);
      // trailing slashes stripped from the configured URL
      assert.equal(jira.last().headers.origin, jira.url);
      assert.equal(jira.last().headers.referer, `${jira.url}/`);
    } finally {
      child.kill();
      await jira.close();
    }
  });

  test("exits with a message when public/index.html is missing", async () => {
    // realpath: macOS reports /var/folders/… as /private/var/folders/…
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jtt-nohtml-")));
    try {
      fs.copyFileSync(SERVER_JS, path.join(dir, "server.js"));
      const { code, stderr } = await new Promise((resolve) => {
        execFile(process.execPath, [path.join(dir, "server.js"), "http://127.0.0.1:1", "0"], { timeout: 5000 },
          (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }));
      });
      assert.equal(code, 1);
      assert.equal(stderr,
        `Error: ${path.join(dir, "public", "index.html")} not found.\nMake sure public/index.html exists.\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--export-ca reports an unreachable Jira", async () => {
    const deadPort = await freePort();
    const { code, stdout, stderr } = await runServer(["--export-ca", `https://127.0.0.1:${deadPort}`]);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /Could not connect to 127\.0\.0\.1:\d+/);
  });
});

describe("startup and shutdown", () => {
  test("prints an aligned banner with the Jira and app URLs", async () => {
    const jira = await startFakeJira();
    const app = await startApp(jira.url);
    try {
      const out = await waitForOutput(app, /└─+┘\n\n/);
      assert.ok(out.startsWith("\n┌"), "blank line before the banner");
      const box = out.split("\n").filter((l) => /^[┌├│└]/.test(l));
      assert.ok(box.length >= 7, out);
      for (const line of box) assert.equal([...line].length, 52, `misaligned: "${line}"`);
      assert.match(box[0], /^┌─{50}┐$/);
      assert.match(box[box.length - 1], /^└─{50}┘$/);
      assert.match(out, /│ {2}Jira Time Tracker +│/);
      assert.match(out, new RegExp(`│ {2}Jira Server: +${jira.url} {2}│`));
      assert.match(out, new RegExp(`│ {2}App: +http://localhost:${app.port} {2}│`));
      assert.match(out, new RegExp(`│ {2}Open in browser: http://localhost:${app.port} +│`));
      assert.match(out, /│ {2}Enter your PAT in the app, done\. +│/);
      assert.equal(box.filter((l) => l.startsWith("├")).length, 2);
      // certificate info only for https Jira
      assert.doesNotMatch(out, /Certificates:/);
    } finally {
      await app.stop();
      await jira.close();
    }
  });

  test("shutdown doesn't wait for requests still waiting on Jira", {
    skip: process.platform === "win32" && "no POSIX signals on Windows",
  }, async () => {
    const jira = await startFakeJira();
    jira.handler = () => {}; // never answers
    const app = await startApp(jira.url);
    try {
      const pending = request(app.port, { path: "/rest/api/2/myself" }).catch((e) => e);
      while (jira.requests.length === 0) await new Promise((r) => setTimeout(r, 10));
      const started = Date.now();
      const { code } = await app.stop();
      assert.equal(code, 0);
      assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
      assert.ok((await pending) instanceof Error); // the client's connection was cut
    } finally {
      await jira.close();
    }
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    test(`${signal} shuts down promptly despite open keep-alive connections`, {
      skip: process.platform === "win32" && "no POSIX signals on Windows",
    }, async () => {
      const jira = await startFakeJira();
      const app = await startApp(jira.url);
      try {
        // keep-alive connection that would hold server.close() open for ~5s
        const agent = new (require("node:http").Agent)({ keepAlive: true });
        await new Promise((resolve, reject) => {
          require("node:http").get({ host: "127.0.0.1", port: app.port, path: "/", agent,
            headers: { host: `localhost:${app.port}` } }, (res) => { res.resume(); res.on("end", resolve); })
            .on("error", reject);
        });
        const started = Date.now();
        const { code } = await app.stop(signal);
        assert.equal(code, 0);
        assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
        assert.match(app.output(), /Shutting down…/);
        agent.destroy();
      } finally {
        await jira.close();
      }
    });
  }
});

describe("Jira unreachable", () => {
  test("answers 502 with a JSON error", async () => {
    const deadPort = await freePort();
    const app = await startApp(`http://127.0.0.1:${deadPort}`);
    try {
      const res = await request(app.port, { path: "/rest/api/2/myself" });
      assert.equal(res.status, 502);
      assert.equal(res.headers["content-type"], "application/json");
      assert.match(JSON.parse(res.body).error, /ECONNREFUSED/);
      // no certificate hint for unrelated errors
      assert.doesNotMatch(res.body, /NODE_EXTRA_CA_CERTS/);
      const out = await waitForOutput(app, /✗ Proxy error: connect ECONNREFUSED/);
      assert.doesNotMatch(out, /NODE_EXTRA_CA_CERTS/);
    } finally {
      await app.stop();
    }
  });
});

// ─── Request guard ──────────────────────────────────────────────────

describe("request guard", () => {
  let jira, app;
  before(async () => {
    jira = await startFakeJira();
    app = await startApp(jira.url, { ALLOWED_HOSTS: " Tracker.Example.COM , other.example , " });
  });
  after(async () => {
    await app.stop();
    await jira.close();
  });

  async function expectBlocked(opts, status = 403) {
    const before = jira.requests.length;
    const res = await request(app.port, opts);
    assert.equal(res.status, status);
    assert.equal(jira.requests.length, before, "request must not reach Jira");
  }

  test("allows same-origin requests from the app", async () => {
    const res = await request(app.port, {
      method: "POST",
      path: "/rest/api/2/issue/ABC-1/worklog",
      headers: {
        origin: `http://localhost:${app.port}`,
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    assert.equal(res.status, 200);
  });

  test("allows loopback host names", async () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const res = await request(app.port, {
        path: "/rest/api/2/myself",
        headers: { host: `${host}:${app.port}` },
      });
      assert.equal(res.status, 200, host);
    }
  });

  test("allows host names listed in ALLOWED_HOSTS (trimmed, any case)", async () => {
    for (const host of [`tracker.example.com:${app.port}`, `TRACKER.example.com:${app.port}`, "other.example"]) {
      const res = await request(app.port, { path: "/rest/api/2/myself", headers: { host } });
      assert.equal(res.status, 200, host);
    }
  });

  test("allows a Host header without port", async () => {
    const res = await request(app.port, { path: "/rest/api/2/myself", headers: { host: "localhost" } });
    assert.equal(res.status, 200);
  });

  test("allows Sec-Fetch-Site: none (typed URL, bookmark)", async () => {
    const res = await request(app.port, { path: "/", headers: { "sec-fetch-site": "none" } });
    assert.equal(res.status, 200);
  });

  test("blocks host names that only contain an allowed name", async () => {
    for (const host of [
      `localhost:${app.port}.evil.example`, // allowed name as prefix
      "evil.example:localhost",              // allowed name as suffix
      `localhost.evil.example:${app.port}`,
      `localhost:${app.port}:${app.port}`,
    ]) {
      await expectBlocked({ path: "/rest/api/2/myself", headers: { host } });
    }
  });

  test("answers blocked requests with a plain 403 and logs them", async () => {
    const res = await request(app.port, {
      path: "/rest/api/2/myself",
      headers: { host: `evil.example:${app.port}` },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers["content-type"], "text/plain");
    assert.equal(res.body, "Forbidden");
    await waitForOutput(app, new RegExp(`✗ Blocked GET /rest/api/2/myself \\(host: evil\\.example:${app.port}, origin: -\\)`));

    await request(app.port, { path: "/x", headers: { origin: "https://evil.example" } });
    await waitForOutput(app, /✗ Blocked GET \/x \(host: localhost:\d+, origin: https:\/\/evil\.example\)/);
  });

  test("blocks a foreign Origin (cross-site form/fetch)", async () => {
    await expectBlocked({
      method: "POST",
      path: "/rest/api/2/issue/ABC-1/worklog",
      headers: { origin: "https://evil.example" },
      body: "{}",
    });
  });

  test("blocks cross-site and same-site Sec-Fetch-Site", async () => {
    for (const site of ["cross-site", "same-site"]) {
      await expectBlocked({
        path: "/rest/api/2/myself",
        headers: { "sec-fetch-site": site },
      });
    }
  });

  test("blocks unknown Host headers (DNS rebinding)", async () => {
    await expectBlocked({
      path: "/rest/api/2/myself",
      headers: { host: `evil.example:${app.port}` },
    });
  });

  test("blocks an empty Host header, even with a trailing comma in ALLOWED_HOSTS", async () => {
    const before = jira.requests.length;
    const status = await new Promise((resolve, reject) => {
      const sock = require("node:net").connect(app.port, "127.0.0.1", () =>
        sock.write("GET /rest/api/2/myself HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n"));
      let data = "";
      sock.on("data", (d) => (data += d));
      sock.on("end", () => resolve(Number(data.split(" ")[1])));
      sock.on("error", reject);
    });
    assert.equal(status, 403);
    assert.equal(jira.requests.length, before);
  });

  test("blocks requests without a Host header", async () => {
    // Node itself rejects HTTP/1.1 requests without Host (400) before our
    // guard runs; either way the request must not reach Jira.
    await expectBlocked({ path: "/rest/api/2/myself", headers: { host: null } }, 400);
  });

  test("also guards the app page", async () => {
    const res = await request(app.port, {
      path: "/",
      headers: { host: `evil.example:${app.port}` },
    });
    assert.equal(res.status, 403);
  });
});

// ─── Network binding ────────────────────────────────────────────────

function externalIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

describe("network binding", () => {
  const ip = externalIPv4();

  test("listens on loopback only by default", { skip: !ip && "no external IPv4 address" }, async () => {
    const jira = await startFakeJira();
    const app = await startApp(jira.url);
    try {
      assert.equal(await canConnect("127.0.0.1", app.port), true);
      // must be actively refused — a timeout would prove nothing
      assert.equal(await connectResult(ip, app.port), "refused");
    } finally {
      await app.stop();
      await jira.close();
    }
  });

  test("HOST=0.0.0.0 listens on all interfaces", { skip: !ip && "no external IPv4 address" }, async () => {
    const jira = await startFakeJira();
    const app = await startApp(jira.url, { HOST: "0.0.0.0" });
    try {
      assert.equal(await canConnect(ip, app.port), true);
    } finally {
      await app.stop();
      await jira.close();
    }
  });
});

// ─── TLS verification ───────────────────────────────────────────────

const SERVER = path.join(__dirname, "..", "server.js");
const HAS_SYSTEM_STORE = typeof require("node:tls").getCACertificates === "function";
// Set by CI after installing the test CA (JTT_CERT_DIR) into the OS trust store
const OS_TRUSTS_TEST_CA = process.env.JTT_OS_TRUSTS_TEST_CA === "1";

function exportCA(url, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SERVER, "--export-ca", url], { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const pemBody = (pem) => pem.replace(/-----[^-]+-----|\s/g, "");

describe("TLS verification", () => {
  const certs = companyCerts();
  const skip = !certs && "openssl not available";
  after(() => certs && certs.cleanup());

  async function withJira(tls, fn) {
    const jira = await startFakeJira({ tls });
    try {
      await fn(jira);
    } finally {
      await jira.close();
    }
  }

  async function withApp(url, env, fn) {
    const app = await startApp(url, env);
    try {
      await fn(app);
    } finally {
      await app.stop();
    }
  }

  test("rejects a certificate from an unknown CA and explains what to do", {
    skip: skip || (OS_TRUSTS_TEST_CA && "test CA is installed in the OS trust store"),
  }, async () => {
    await withJira(certs.withRoot, (jira) => withApp(jira.url, {}, async (app) => {
      const res = await request(app.port, { path: "/rest/api/2/myself" });
      assert.equal(res.status, 502);
      assert.equal(jira.requests.length, 0);
      assert.match(JSON.parse(res.body).error, /self-signed certificate in certificate chain/);
      assert.match(JSON.parse(res.body).error, /NODE_EXTRA_CA_CERTS/);
      assert.match(app.output(), /NODE_EXTRA_CA_CERTS/);
    }));
  });

  test("shows the certificate hint once, with what to do", {
    skip: skip || (OS_TRUSTS_TEST_CA && "test CA is installed in the OS trust store"),
  }, async () => {
    await withJira(certs.withRoot, (jira) => withApp(jira.url, {}, async (app) => {
      const first = await request(app.port, { path: "/rest/api/2/myself" });
      await request(app.port, { path: "/rest/api/2/myself" });
      const out = await waitForOutput(app, /(✗ Proxy error: [^\n]+\n[\s\S]*){2}/);
      const hint = HAS_SYSTEM_STORE
        ? /Jira's certificate is not trusted by Node or the OS trust store \(on Linux, browsers use their own store\)\. Install the CA system-wide, or export it with --export-ca and set NODE_EXTRA_CA_CERTS \(see README\)\./
        : /Jira's certificate is not trusted by Node\. Use Node >= 22\.15 \(reads the OS trust store\) or set NODE_EXTRA_CA_CERTS \(see README\)\./;
      assert.match(JSON.parse(first.body).error, hint);
      assert.equal(out.split("    → Jira's certificate").length - 1, 1, out);
      assert.match(out, hint);
    }));
  });

  for (const [name, variant] of [
    ["Jira doesn't send its CA", "leafOnly"],
    ["Jira uses a self-signed certificate", "selfSigned"],
    ["Jira sends an intermediate but no root CA", "withIntermediate"],
  ]) {
    test(`shows the certificate hint when ${name}`, {
      skip: skip || (OS_TRUSTS_TEST_CA && "test CA is installed in the OS trust store"),
    }, async () => {
      await withJira(certs[variant], (jira) => withApp(jira.url, {}, async (app) => {
        const res = await request(app.port, { path: "/rest/api/2/myself" });
        assert.equal(res.status, 502);
        assert.match(JSON.parse(res.body).error, /NODE_EXTRA_CA_CERTS/);
      }));
    });
  }

  test("trusts a CA given via NODE_EXTRA_CA_CERTS", { skip }, async () => {
    await withJira(certs.withRoot, (jira) =>
      withApp(jira.url, { NODE_EXTRA_CA_CERTS: certs.caFile }, async (app) => {
        const res = await request(app.port, { path: "/rest/api/2/myself" });
        assert.equal(res.status, 200);
      }));
  });

  test("shows at startup whether the OS trust store is used", { skip }, async () => {
    await withJira(certs.withRoot, (jira) => withApp(jira.url, {}, async (app) => {
      const out = await waitForOutput(app, /└─+┘/);
      const value = HAS_SYSTEM_STORE ? "Node \\+ OS trust store" : "Node built-in";
      assert.match(out, new RegExp(`│ {2}Certificates: +${value} {2}│`));
    }));
  });

  test("trusts CAs from the OS trust store", {
    skip: skip || (!HAS_SYSTEM_STORE && "needs Node >= 22.15")
      || (!OS_TRUSTS_TEST_CA && process.platform !== "linux"
        && "needs the test CA in the OS trust store (CI) or Linux"),
  }, async () => {
    // Without the CA installed, Linux lets us point the OS store at a file
    const env = OS_TRUSTS_TEST_CA ? {} : { SSL_CERT_FILE: certs.caFile };
    await withJira(certs.withRoot, (jira) =>
      withApp(jira.url, env, async (app) => {
        const res = await request(app.port, { path: "/rest/api/2/myself" });
        assert.equal(res.status, 200);
      }));
  });

  test("--export-ca writes the root CA, which then makes Jira trusted", { skip }, async () => {
    await withJira(certs.withRoot, async (jira) => {
      const { code, stdout, stderr } = await exportCA(jira.url);
      assert.equal(code, 0, stderr);
      assert.equal(pemBody(stdout), pemBody(certs.ca));
      assert.match(stderr, /CA: {6}O=Test Company, CN=Test Company Root CA\n/);
      assert.match(stderr, /SHA-256: ([0-9A-F]{2}:){31}[0-9A-F]{2}\n/);
      assert.match(stderr, /Valid: {3}.+ – .+\n/);

      const exported = path.join(certs.dir, "exported.pem");
      fs.writeFileSync(exported, stdout);
      await withApp(jira.url, { NODE_EXTRA_CA_CERTS: exported }, async (app) => {
        const res = await request(app.port, { path: "/rest/api/2/myself" });
        assert.equal(res.status, 200);
      });
    });
  });

  test("--export-ca finds a root CA Jira doesn't send in the OS trust store", {
    skip: skip || (!OS_TRUSTS_TEST_CA && "needs the test CA in the OS trust store (CI)"),
  }, async () => {
    await withJira(certs.leafOnly, async (jira) => {
      const { code, stdout, stderr } = await exportCA(jira.url);
      assert.equal(code, 0, stderr);
      assert.equal(pemBody(stdout), pemBody(certs.ca));
    });
  });

  test("--export-ca explains when Jira doesn't send its root CA", {
    skip: skip || (OS_TRUSTS_TEST_CA && "test CA is installed in the OS trust store"),
  }, async () => {
    await withJira(certs.leafOnly, async (jira) => {
      const { code, stdout, stderr } = await exportCA(jira.url);
      assert.notEqual(code, 0);
      assert.equal(stdout, "");
      assert.match(stderr, /did not send its root CA/);
      assert.match(stderr, /Issuer: O=Test Company, CN=Test Company Root CA\n/);
      assert.match(stderr, /Ask your IT department for that CA certificate\./);
    });
  });

  test("--export-ca without a URL prints usage", async () => {
    const { code, stderr } = await exportCA("", { JIRA_URL: "" });
    assert.notEqual(code, 0);
    assert.match(stderr, /Usage: node server.js --export-ca/);
  });

  test("JIRA_INSECURE_TLS=1 accepts any certificate and warns at startup", { skip }, async () => {
    await withJira(certs.withRoot, (jira) =>
      withApp(jira.url, { JIRA_INSECURE_TLS: "1" }, async (app) => {
        const res = await request(app.port, { path: "/rest/api/2/myself" });
        assert.equal(res.status, 200);
        const box = (await waitForOutput(app, /└─+┘/)).split("\n").filter((l) => /^[┌├│└]/.test(l));
        const warning = box.findIndex((l) => l.includes("WARNING: TLS certificate checks disabled"));
        assert.ok(warning > 0, box.join("\n"));
        assert.match(box[warning - 1], /^├─{50}┤$/);
        assert.match(box[warning + 1], /^└─{50}┘$/);
      }));
  });
});
