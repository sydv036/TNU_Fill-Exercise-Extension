import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || "release/v3.4.1/chrome-mv3");
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = await mkdtemp(path.join(tmpdir(), "tnu-scorm-e2e-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const tnu = await context.newPage();
  await tnu.route("https://tnu.aum.edu.vn/**", (route) => {
    const url = route.request().url();
    if (url.includes("/pluginfile.php/")) return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: '<div id="playerView"><div id="slide">Fixture slide</div><output id="timeline">0</output></div><audio id="lesson-audio"></audio><button id="next-slide" aria-label="next slide">TIẾP</button><script>window.__nextClicks=0;window.__timelineTicks=0;window.__dateElapsed=0;const startedAt=Date.now();setInterval(()=>{window.__timelineTicks++;window.__dateElapsed=Date.now()-startedAt;document.getElementById("timeline").textContent=String(window.__timelineTicks)},1000);document.getElementById("next-slide").addEventListener("click",()=>window.__nextClicks++)</script>'
    });
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: '<iframe id="scorm_object" src="https://tnu.aum.edu.vn/pluginfile.php/1/mod_scorm/content/1/res/index.html"></iframe>'
    });
  });
  await tnu.goto("https://tnu.aum.edu.vn/mod/scorm/player.php");
  const frame = tnu.frameLocator("#scorm_object");
  await frame.locator("#lesson-audio").waitFor({ state: "attached" });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator("nav").getByRole("button", { name: /Bài giảng/ }).click();
  await panel.getByLabel("Tốc độ phát").selectOption("8");
  await panel.getByRole("button", { name: /Bật tăng tốc/ }).click();
  await frame.locator("#lesson-audio").waitFor({ state: "attached" });
  await tnu.waitForFunction(() => {
    const audio = document.querySelector("#scorm_object")?.contentDocument?.querySelector("#lesson-audio");
    return audio?.playbackRate === 8 && audio?.defaultPlaybackRate === 8;
  });
  await tnu.waitForFunction(() => document.querySelector("#scorm_object")?.contentDocument?.documentElement?.getAttribute("data-tnu-scorm-clock-applied") === "8");
  const beforeTicks = await frame.locator("body").evaluate(() => window.__timelineTicks);
  await tnu.waitForTimeout(650);
  const acceleratedTicks = (await frame.locator("body").evaluate(() => window.__timelineTicks)) - beforeTicks;
  if (acceleratedTicks < 4) throw new Error(`SCORM slide timeline remained near 1x (${acceleratedTicks} ticks in 650ms).`);
  const acceleratedDateElapsed = await frame.locator("body").evaluate(() => window.__dateElapsed);
  if (acceleratedDateElapsed < 3_000) throw new Error(`SCORM Date-based clock remained near 1x (${acceleratedDateElapsed}ms).`);

  await frame.locator("#lesson-audio").evaluate((audio) => {
    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("ended"));
  });
  await tnu.waitForTimeout(900);
  if (await frame.locator("body").evaluate(() => window.__nextClicks) !== 1) throw new Error("SCORM accelerator did not advance exactly once after a real ended event.");

  await frame.locator("#playerView").evaluate((root) => { root.insertAdjacentHTML("beforeend", '<input type="radio" name="answer">'); });
  await frame.locator("#lesson-audio").evaluate((audio) => {
    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("ended"));
  });
  await tnu.waitForTimeout(900);
  if (await frame.locator("body").evaluate(() => window.__nextClicks) !== 1) throw new Error("SCORM accelerator skipped an interactive slide.");
  await panel.getByRole("button", { name: "Dừng ngay" }).click();
  await tnu.waitForFunction(() => document.querySelector("#scorm_object")?.contentDocument?.querySelector("#lesson-audio")?.playbackRate === 1);
  await tnu.waitForFunction(() => document.querySelector("#scorm_object")?.contentDocument?.documentElement?.getAttribute("data-tnu-scorm-clock-applied") === "1");
  console.log("PASS: SCORM iframe nhận 8× cho cả media và timeline, tự chuyển đúng một lần sau ended, dừng ở tương tác và khôi phục 1× khi Stop.");
} finally {
  if (context) await context.close();
  await rm(profile, { recursive: true, force: true });
}
