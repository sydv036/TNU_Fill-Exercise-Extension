import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, label, extraEnv = {}) {
  console.log(`\n=== ${label} ===`);
  const env = { ...process.env, ...extraEnv };
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" && command === "npm" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

run("npm", ["run", "typecheck"], "TypeScript typecheck");
run("npm", ["test", "--", "--reporter=dot"], "Unit and integration tests");
run("npm", ["run", "test:coverage", "--", "--reporter=dot"], "Coverage report");
run(process.execPath, [path.join(root, "scripts", "build-release.mjs")], "Isolated Chrome and Edge release build");
run(process.execPath, [path.join(root, "scripts", "test-release.mjs")], "Checksum verification and release-artifact E2E");
run(process.execPath, [path.join(root, "scripts", "promote-production.mjs")], "Promote verified release to stable production directory");

const safeSmokeEnv = { ...process.env };
for (const key of ["TNU_REAL_SMOKE", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TNU_GEMINI_MODEL", "TNU_OPENAI_MODEL", "TNU_ANTHROPIC_MODEL"]) delete safeSmokeEnv[key];
run(process.execPath, [path.join(root, "scripts", "real-api-smoke.mjs")], "Real API smoke runner opt-in safety check (forced NOT RUN)", safeSmokeEnv);
console.log("\nVALIDATION COMPLETE: mock/integration E2E passed and the verified release was promoted to production; real Gemini/OpenAI/Claude API calls were intentionally not made.");
