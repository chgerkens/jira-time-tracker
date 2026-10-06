#!/usr/bin/env node
// ─── Coverage summary ──────────────────────────────────────────────
//
// Turns coverage/coverage-summary.json (c8 "json-summary" reporter)
// into a Markdown table, e.g. for $GITHUB_STEP_SUMMARY:
//   node scripts/coverage-summary.js >> "$GITHUB_STEP_SUMMARY"
// ────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const summary = JSON.parse(
  fs.readFileSync(path.join(root, "coverage", "coverage-summary.json"), "utf-8")
);
const thresholds = JSON.parse(fs.readFileSync(path.join(root, ".c8rc.json"), "utf-8"));

const METRICS = ["lines", "statements", "branches", "functions"];

const cell = (m, isTotal) => {
  const text = `${m.pct.toFixed(1)}% (${m.covered}/${m.total})`;
  return isTotal ? `**${text}**` : text;
};

const rows = Object.entries(summary)
  .filter(([file]) => file !== "total")
  .map(([file, m]) => `| \`${path.relative(root, file)}\` | ${METRICS.map((k) => cell(m[k])).join(" | ")} |`);

const total = summary.total;
const status = METRICS.every((k) => total[k].pct >= (thresholds[k] ?? 0)) ? "✅" : "❌";

console.log(`### ${status} Coverage`);
console.log("");
console.log(`| File | ${METRICS.map((k) => k[0].toUpperCase() + k.slice(1)).join(" | ")} |`);
console.log(`|---|${METRICS.map(() => "---:").join("|")}|`);
rows.forEach((r) => console.log(r));
console.log(`| **Total** | ${METRICS.map((k) => cell(total[k], true)).join(" | ")} |`);
console.log(`| Threshold | ${METRICS.map((k) => `${thresholds[k] ?? 0}%`).join(" | ")} |`);
console.log("");
console.log("UI code in `public/index.html` is compiled in the browser and not measured; it is covered by the e2e tests.");
