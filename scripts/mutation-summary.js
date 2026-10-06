#!/usr/bin/env node
// ─── Mutation summary ──────────────────────────────────────────────
//
// Turns reports/mutation/mutation.json (Stryker "json" reporter) into a
// Markdown table, e.g. for $GITHUB_STEP_SUMMARY:
//   node scripts/mutation-summary.js >> "$GITHUB_STEP_SUMMARY"
// ────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const reportPath = path.join(root, "reports", "mutation", "mutation.json");
if (!fs.existsSync(reportPath)) {
  console.log("### ❌ Mutation testing\n\nNo report found — Stryker did not finish.");
  process.exit(0);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
const { high, low } = report.thresholds;

const DETECTED = ["Killed", "Timeout"];
const UNDETECTED = ["Survived", "NoCoverage"];

function score(mutants) {
  const count = (states) => mutants.filter((m) => states.includes(m.status)).length;
  const detected = count(DETECTED);
  const undetected = count(UNDETECTED);
  const valid = detected + undetected;
  return {
    detected,
    survived: count(["Survived"]),
    noCoverage: count(["NoCoverage"]),
    ignored: count(["Ignored"]),
    pct: valid ? (detected / valid) * 100 : 100,
  };
}

const icon = (pct) => (pct >= high ? "✅" : pct >= low ? "⚠️" : "❌");

const files = Object.entries(report.files).map(([file, f]) => ({ file, ...score(f.mutants) }));
const total = score(Object.values(report.files).flatMap((f) => f.mutants));

console.log(`### ${icon(total.pct)} Mutation score: ${total.pct.toFixed(1)}%`);
console.log("");
console.log("| File | Score | Killed | Survived | No coverage | Ignored |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const f of files) {
  console.log(`| \`${f.file}\` | ${icon(f.pct)} ${f.pct.toFixed(1)}% | ${f.detected} | ${f.survived} | ${f.noCoverage} | ${f.ignored} |`);
}
console.log(`| **Total** | **${total.pct.toFixed(1)}%** | ${total.detected} | ${total.survived} | ${total.noCoverage} | ${total.ignored} |`);
console.log("");
console.log(`Thresholds: ✅ ≥ ${high}%, ⚠️ ≥ ${low}%. Surviving mutants are listed in the \`mutation-report\` artifact (HTML).`);
console.log("Ignored mutants are marked in the code with `// Stryker disable …: <reason>` (equivalent or untestable).");
