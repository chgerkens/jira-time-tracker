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
const { freePort, startFakeJira, startApp, canConnect, request } = require("./helpers");

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

  test("returns 404 for unknown paths", async () => {
    const res = await request(app.port, { path: "/secret.txt" });
    assert.equal(res.status, 404);
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
      headers: { "x-atlassian-token": "client-value" },
    });
    const req = jira.last();
    assert.equal(req.headers["x-atlassian-token"], "no-check");
    assert.equal(req.headers["x-requested-with"], "XMLHttpRequest");
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
    const cookie = jira.last().headers.cookie;
    assert.match(cookie, /JSESSIONID=abc123/);
    // Values containing "=" must be kept whole.
    assert.match(cookie, /atlassian\.xsrf\.token=TOKEN\|with=equals\|lin/);
  });

  test("POST requests carry the stored XSRF token", async () => {
    await request(app.port, {
      method: "POST",
      path: "/rest/api/2/issue/ABC-1/worklog?notifyUsers=false",
      headers: PAT,
      body: "{}",
    });
    const req = jira.last();
    const url = new URL(req.url, "http://x");
    assert.equal(url.searchParams.get("notifyUsers"), "false");
    assert.equal(url.searchParams.get("atl_token"), "TOKEN|with=equals|lin");
    assert.equal(req.headers["x-xsrf-token"], "TOKEN|with=equals|lin");
    assert.equal(req.headers["x-atlassian-token"], undefined);
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

  test("keeps a bounded number of sessions", async () => {
    // Many distinct tokens must not grow memory without limit; the
    // least recently used session is dropped first.
    for (let i = 0; i < 12; i++) {
      jira.handler = (req, res) => {
        res.writeHead(200, { "Set-Cookie": `JSESSIONID=s${i}; Path=/` });
        res.end("{}");
      };
      await request(app.port, { path: "/rest/api/2/myself", headers: { authorization: `Bearer t${i}` } });
    }
    jira.handler = (req, res) => res.end("{}");

    await request(app.port, { path: "/rest/api/2/myself", headers: { authorization: "Bearer t11" } });
    assert.match(jira.last().headers.cookie, /JSESSIONID=s11/);
    await request(app.port, { path: "/rest/api/2/myself", headers: { authorization: "Bearer t0" } });
    assert.equal(jira.last().headers.cookie, undefined);
  });
});

describe("Jira unreachable", () => {
  test("answers 502 with a JSON error", async () => {
    const deadPort = await freePort();
    const app = await startApp(`http://127.0.0.1:${deadPort}`);
    try {
      const res = await request(app.port, { path: "/rest/api/2/myself" });
      assert.equal(res.status, 502);
      assert.ok(JSON.parse(res.body).error);
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
    app = await startApp(jira.url, { ALLOWED_HOSTS: "tracker.example.com" });
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

  test("allows host names listed in ALLOWED_HOSTS", async () => {
    const res = await request(app.port, {
      path: "/rest/api/2/myself",
      headers: { host: `Tracker.Example.com:${app.port}` },
    });
    assert.equal(res.status, 200);
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
      assert.equal(await canConnect(ip, app.port), false);
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

  test("trusts a CA given via NODE_EXTRA_CA_CERTS", { skip }, async () => {
    await withJira(certs.withRoot, (jira) =>
      withApp(jira.url, { NODE_EXTRA_CA_CERTS: certs.caFile }, async (app) => {
        const res = await request(app.port, { path: "/rest/api/2/myself" });
        assert.equal(res.status, 200);
      }));
  });

  test("shows at startup whether the OS trust store is used", { skip }, async () => {
    await withJira(certs.withRoot, (jira) => withApp(jira.url, {}, async (app) => {
      await request(app.port, { path: "/" });
      const expected = HAS_SYSTEM_STORE ? /Node \+ OS trust store/ : /Node built-in/;
      assert.match(app.output(), expected);
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
      assert.match(stderr, /CN=Test Company Root CA/);
      assert.match(stderr, /SHA-256: ([0-9A-F]{2}:){31}[0-9A-F]{2}/);

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
      assert.match(stderr, /CN=Test Company Root CA/);
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
        assert.match(app.output(), /TLS certificate checks disabled/);
      }));
  });
});
