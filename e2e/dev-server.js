// ─── Local dev server against the e2e fake Jira ────────────────────
//
// `npm run dev [PORT]` starts the stateful fake Jira from the e2e tests
// and server.js pointing at it, so the app can be tried without a real
// Jira. Log in with the PAT "test-pat". Data lives in memory only.
//
// Default port is 3009, not 3001: the browser keeps entries and the PAT
// in localStorage per origin, so sharing localhost:3001 with a real
// tracker would mix real entries with fake ones (and "sync" them to the
// fake). PORT from the environment is ignored for the same reason.
// ────────────────────────────────────────────────────────────────────

const { spawn } = require("node:child_process");
const path = require("node:path");
const { startJira, PAT } = require("./fake-jira");

const PORT = process.argv[2] || "3009";

(async () => {
  const jira = await startJira();
  console.log(`Fake Jira: ${jira.url}  (PAT: ${PAT})`);

  const app = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), jira.url, PORT], {
    stdio: "inherit",
  });

  const stop = () => app.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  app.on("exit", async (code) => {
    await jira.close();
    process.exit(code ?? 0);
  });
})();
