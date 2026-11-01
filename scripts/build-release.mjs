import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseVersion = packageInfo.version;
const releaseRoot = path.join(root, "release");
const destination = path.join(releaseRoot, `v${releaseVersion}`);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const stage = path.join(releaseRoot, `.staging-v${releaseVersion}-${stamp}-${process.pid}`);
const previous = path.join(releaseRoot, `.previous-v${releaseVersion}-${stamp}-${process.pid}`);
const browsers = ["chrome", "edge"];
const wxtBin = path.join(root, "node_modules", "wxt", "bin", "wxt.mjs");

function assertInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing unsafe release path: ${target}`);
}

async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(directory, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function sourceFingerprint() {
  const files = [];
  for (const entry of ["entrypoints", "src", "public", "assets", "tests", "scripts"]) {
    try { files.push(...await listFiles(root, entry)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const file of ["package.json", "package-lock.json", "wxt.config.ts", "tsconfig.json", "vitest.config.ts"]) files.push(file);
  const hash = createHash("sha256");
  for (const relative of [...new Set(files)].sort()) {
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertFile(base, relative, label) {
  if (typeof relative !== "string" || !relative.trim() || relative.includes("..")) throw new Error(`${label} path is missing or unsafe.`);
  const file = path.resolve(base, relative.replace(/^\//, ""));
  assertInside(base, file);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size === 0) throw new Error(`${label} missing/empty: ${relative}`);
  return file;
}

async function validateArtifact(browserId) {
  const directory = path.join(stage, `${browserId}-mv3`);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== releaseVersion) throw new Error(`${browserId}: manifest version is ${manifest.version}, expected ${releaseVersion}.`);
  const background = manifest.background?.service_worker;
  await assertFile(directory, background, `${browserId} background service worker`);
  if (manifest.side_panel?.default_path !== "sidepanel.html") throw new Error(`${browserId}: unexpected side panel path.`);
  const sidepanel = await assertFile(directory, manifest.side_panel.default_path, `${browserId} side panel`);
  const html = await readFile(sidepanel, "utf8");
  for (const reference of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])) {
    if (/^(?:https?:|data:|#)/i.test(reference)) continue;
    await assertFile(directory, reference, `${browserId} side panel asset`);
  }
  const scripts = manifest.content_scripts ?? [];
  if (!scripts.length) throw new Error(`${browserId}: no content scripts are registered.`);
  let hasTnuScript = false;
  let hasLocalFixtureScript = false;
  for (const script of scripts) {
    if (script.matches?.some((pattern) => pattern.startsWith("https://tnu.aum.edu.vn/"))) hasTnuScript = true;
    if (script.matches?.some((pattern) => pattern.startsWith("http://127.0.0.1/") || pattern.startsWith("http://localhost/"))) hasLocalFixtureScript = true;
    for (const file of script.js ?? []) await assertFile(directory, file, `${browserId} content script`);
    for (const file of script.css ?? []) await assertFile(directory, file, `${browserId} content stylesheet`);
  }
  if (!hasTnuScript) throw new Error(`${browserId}: TNU content script match is missing.`);
  if (!hasLocalFixtureScript) throw new Error(`${browserId}: local Web fixture content script match is missing.`);
  for (const icon of Object.values(manifest.icons ?? {})) await assertFile(directory, icon, `${browserId} manifest icon`);
  return { directory, manifest, files: await listFiles(directory) };
}

function runBuild(browserId) {
  const result = spawnSync(process.execPath, [wxtBin, "build", "-b", browserId], {
    cwd: root,
    env: { ...process.env, TNU_RELEASE_DIR: stage },
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${browserId} release build failed with exit code ${result.status}.`);
}

assertInside(releaseRoot, stage);
assertInside(releaseRoot, destination);
await mkdir(releaseRoot, { recursive: true });
await mkdir(stage, { recursive: false });
const iconResult = spawnSync(process.execPath, [path.join(root, "scripts", "generate-icons.mjs")], { cwd: root, stdio: "inherit", windowsHide: true });
if (iconResult.error) throw iconResult.error;
if (iconResult.status !== 0) throw new Error(`Icon preparation failed with exit code ${iconResult.status}.`);
const sourceHash = await sourceFingerprint();
for (const browserId of browsers) runBuild(browserId);

const artifactRecords = {};
for (const browserId of browsers) {
  const validated = await validateArtifact(browserId);
  artifactRecords[browserId] = {
    directory: `${browserId}-mv3`,
    manifestVersion: validated.manifest.version,
    manifestSha256: await sha256(path.join(validated.directory, "manifest.json")),
    fileCount: validated.files.length,
    files: Object.fromEntries(await Promise.all(validated.files.map(async (relative) => [relative, await sha256(path.join(validated.directory, relative))])))
  };
  console.log(`PASS: ${browserId} artifact validated (${artifactRecords[browserId].fileCount} files).`);
}

const receipt = {
  release: releaseVersion,
  builtAt: new Date().toISOString(),
  buildId: randomUUID(),
  sourceSha256: sourceHash,
  output: "isolated staging directory; no .output cleanup",
  artifacts: artifactRecords
};
await writeFile(path.join(stage, "release-manifest.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

let movedPrevious = false;
try {
  if (await stat(destination).catch(() => undefined)) {
    await rename(destination, previous);
    movedPrevious = true;
  }
  await rename(stage, destination);
} catch (error) {
  if (movedPrevious && !(await stat(destination).catch(() => undefined))) await rename(previous, destination).catch(() => undefined);
  throw error;
}

console.log(`RELEASE_READY: ${destination}`);
for (const browserId of browsers) console.log(`${browserId.toUpperCase()}: ${path.join(destination, `${browserId}-mv3`)}`);
console.log(`RECEIPT: ${path.join(destination, "release-manifest.json")}`);
if (movedPrevious) console.log(`PREVIOUS_RELEASE_PRESERVED: ${previous}`);
