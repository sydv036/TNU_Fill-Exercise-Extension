import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseDir = path.join(root, "release", `v${packageInfo.version}`);
const receiptPath = path.join(releaseDir, "release-manifest.json");
const extensionHosts = [
  { id: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { id: "chrome", path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
  { id: "edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
  { id: "edge", path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" }
];

function inside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe artifact path: ${target}`);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function sourceFingerprint() {
  const hash = createHash("sha256");
  const files = [];
  async function walk(relative) {
    const directory = path.join(root, relative);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) await walk(next);
      else if (item.isFile()) files.push(next);
    }
  }
  for (const relative of ["entrypoints", "src", "public", "assets", "tests", "scripts"]) {
    try { await walk(relative); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  files.push("package.json", "package-lock.json", "wxt.config.ts", "tsconfig.json", "vitest.config.ts");
  for (const relative of [...new Set(files)].sort()) {
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function run(script, env, label) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, [path.join(root, script)], { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
if (receipt.release !== packageInfo.version || receipt.sourceSha256 !== await sourceFingerprint()) throw new Error(`Release receipt does not match current V${packageInfo.version} source; rebuild before testing.`);
if (packageInfo.version !== receipt.release) throw new Error("Package version differs from release receipt.");

for (const browserId of ["chrome", "edge"]) {
  const record = receipt.artifacts?.[browserId];
  const artifact = path.join(releaseDir, `${browserId}-mv3`);
  inside(releaseDir, artifact);
  if (!record || record.directory !== `${browserId}-mv3`) throw new Error(`Missing ${browserId} release receipt entry.`);
  const manifest = JSON.parse(await readFile(path.join(artifact, "manifest.json"), "utf8"));
  if (manifest.version !== receipt.release || await sha256(path.join(artifact, "manifest.json")) !== record.manifestSha256) throw new Error(`${browserId} manifest is stale or changed.`);
  for (const [relative, expected] of Object.entries(record.files)) {
    const file = path.resolve(artifact, relative);
    inside(artifact, file);
    if (await sha256(file).catch(() => "") !== expected) throw new Error(`${browserId} artifact checksum mismatch: ${relative}`);
  }
  if (Object.keys(record.files).length !== record.fileCount) throw new Error(`${browserId} release receipt file count mismatch.`);
  console.log(`PASS: verified ${artifact} (${record.fileCount} hashed files; source ${receipt.sourceSha256.slice(0, 12)}).`);
}

let hosts = [];
for (const candidate of extensionHosts) {
  try { await access(candidate.path); if (!hosts.some((host) => host.id === candidate.id)) hosts.push(candidate); }
  catch { /* host executable is not installed at this location */ }
}
if (process.env.TNU_E2E_BROWSER) hosts = [{ id: "configured", path: process.env.TNU_E2E_BROWSER }];
if (!hosts.length) throw new Error("Không tìm thấy Chrome/Edge để chạy E2E. Đặt TNU_E2E_BROWSER thành đường dẫn trình duyệt Chromium.");

const apiEnv = { ...process.env };
delete apiEnv.TNU_REAL_SMOKE;
delete apiEnv.GEMINI_API_KEY;
delete apiEnv.OPENAI_API_KEY;
delete apiEnv.ANTHROPIC_API_KEY;
delete apiEnv.TNU_GEMINI_MODEL;
delete apiEnv.TNU_OPENAI_MODEL;
delete apiEnv.TNU_ANTHROPIC_MODEL;

for (const browserId of ["chrome", "edge"]) {
  const artifact = path.join(releaseDir, `${browserId}-mv3`);
  const e2eHost = hosts.find((host) => host.id === "edge") ?? hosts[0];
  console.log(`\nE2E: artifact=${artifact}; browser=${e2eHost.path}`);
  const env = { ...apiEnv, TNU_E2E_EXTENSION: artifact, TNU_E2E_BROWSER: e2eHost.path };
  run("scripts/e2e-smoke.mjs", env, `${browserId} artifact · workflow / stop-resume / stale-response / worker restart`);
  run("scripts/e2e-web-tabs.mjs", env, `${browserId} artifact · two-window TNU → local Web fixture → TNU, rotation, Stop/Switch/Resume`);
  run("scripts/e2e-live-web-bridge.mjs", env, `${browserId} artifact · Gemini/ChatGPT/Claude live content bridge DOM compatibility`);
  run("scripts/e2e-auto.mjs", env, `${browserId} artifact · API fixture / fallback / budget / error regression`);
  run("scripts/e2e-ui-release.mjs", env, `${browserId} artifact · sidepanel / provider / model / capability / unknown usage UI`);
}

console.log("PASS: all E2E suites loaded the exact checksum-verified V3.2 release artifacts. No real provider API was enabled.");
