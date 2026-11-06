import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "release");
const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const source = path.join(releaseRoot, `v${packageInfo.version}`);
const production = path.join(releaseRoot, "production");
const stage = path.join(releaseRoot, `.production-staging-${randomUUID()}`);
const previous = path.join(releaseRoot, `.production-previous-${randomUUID()}`);

function assertInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe production path: ${target}`);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

assertInside(releaseRoot, source);
assertInside(releaseRoot, production);
assertInside(releaseRoot, stage);
assertInside(releaseRoot, previous);
const receipt = JSON.parse(await readFile(path.join(source, "release-manifest.json"), "utf8"));
if (receipt.release !== packageInfo.version) throw new Error(`Release receipt is ${receipt.release}; expected ${packageInfo.version}.`);

for (const browserId of ["chrome", "edge"]) {
  const record = receipt.artifacts?.[browserId];
  if (!record || record.directory !== `${browserId}-mv3`) throw new Error(`Missing ${browserId} artifact receipt.`);
  const artifact = path.join(source, record.directory);
  assertInside(source, artifact);
  for (const [relative, expected] of Object.entries(record.files)) {
    const file = path.resolve(artifact, relative);
    assertInside(artifact, file);
    if (await sha256(file).catch(() => "") !== expected) throw new Error(`${browserId} checksum mismatch: ${relative}`);
  }
}

await mkdir(releaseRoot, { recursive: true });
await cp(source, stage, { recursive: true, force: true, errorOnExist: false });
let movedPrevious = false;
try {
  if (await stat(production).catch(() => undefined)) {
    await rename(production, previous);
    movedPrevious = true;
  }
  await rename(stage, production);
  if (movedPrevious) await rm(previous, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
} catch (error) {
  if (movedPrevious && !(await stat(production).catch(() => undefined))) await rename(previous, production).catch(() => undefined);
  await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}

console.log(`PRODUCTION_READY: ${production}`);
console.log(`PRODUCTION_VERSION: ${receipt.release}`);
console.log(`VERSIONED_ARTIFACT_CLEANED: ${source}`);
console.log(`CHROME: ${path.join(production, "chrome-mv3")}`);
console.log(`EDGE: ${path.join(production, "edge-mv3")}`);
