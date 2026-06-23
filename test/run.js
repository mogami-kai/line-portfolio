// ============================================================
// Runs every *.test.js in this directory and aggregates results.
//   node test/run.js
// ============================================================

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n### ${f}`);
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  } catch (e) {
    failed++;
  }
}

console.log(`\n${failed ? "❌" : "✅"} suites: ${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
