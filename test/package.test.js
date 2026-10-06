// ─── Package tests ─────────────────────────────────────────────────
//
// The app is run via `npx github:chgerkens/jira-time-tracker <JIRA_URL>`
// (and later from npm). Checks that the package contains exactly the
// files the server needs — nothing missing, nothing private.
// ────────────────────────────────────────────────────────────────────

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

describe("npm package", () => {
  test("uses the scoped name (the unscoped one belongs to someone else)", () => {
    assert.equal(pkg.name, "@chgerkens/jira-time-tracker");
    assert.deepEqual(pkg.publishConfig, { access: "public" });
  });

  test("exposes server.js as the jira-time-tracker command", () => {
    assert.deepEqual(pkg.bin, { "jira-time-tracker": "server.js" });
    const firstLine = fs.readFileSync(path.join(root, "server.js"), "utf-8").split("\n")[0];
    assert.equal(firstLine, "#!/usr/bin/env node");
  });

  test("contains exactly the files the server needs", () => {
    // npm is a .cmd script on Windows, which needs a shell to run
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf-8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = JSON.parse(out)[0].files.map((f) => f.path.replace(/\\/g, "/")).sort();
    assert.deepEqual(files, [
      "LICENSE",
      "README.md",
      "package.json",
      "public/index.html",
      "public/lib.js",
      "server.js",
    ]);
  });
});
