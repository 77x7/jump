// Visual proof for the surface opacity / blur settings.
//
// Run with xvfb-run so the extension loads headful:
//   xvfb-run -a node tests/e2e/opacity-shots.mjs
//
// Writes PNGs to tests/e2e/shots/ (gitignored).
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const distDir = resolve(projectRoot, "dist");
const shotsDir = resolve(here, "shots");

function findChromium() {
  if (process.env.JUMP_CHROMIUM) return process.env.JUMP_CHROMIUM;
  const cacheDir = join(process.env.HOME ?? "", ".cache/ms-playwright");
  const revisions = readdirSync(cacheDir)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  for (const revision of revisions.reverse()) {
    for (const binary of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const candidate = join(cacheDir, revision, binary);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Try the next layout.
      }
    }
  }
  throw new Error(`No Playwright chromium found under ${cacheDir}`);
}

const TILE_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#fb7185",
];

const fixtureHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Busy fixture</title>
<style>
  html, body { margin: 0; padding: 0; font-family: Georgia, serif; background: #ffffff; color: #111; }
  .strip { height: 18px; background: repeating-linear-gradient(90deg, #ef4444 0 48px, #f59e0b 48px 96px, #10b981 96px 144px, #3b82f6 144px 192px, #a855f7 192px 240px); }
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; padding: 16px; }
  .tile { height: 92px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; font: 700 14px/1 system-ui, sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,.55); }
  .copy { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 4px 16px 28px; font-size: 13px; line-height: 1.4; }
  .copy p { margin: 0; background: #fff; padding: 8px; border: 1px solid #ddd; }
  .band { height: 120px; background: linear-gradient(90deg, #fda4af, #fcd34d, #86efac, #93c5fd, #c4b5fd); display: flex; align-items: center; justify-content: center; font: 800 30px/1 system-ui, sans-serif; color: #111; letter-spacing: .04em; }
</style>
</head>
<body>
  <div class="strip"></div>
  <div class="grid">
    ${TILE_COLORS.map((color, index) => `<div class="tile" style="background:${color}">TILE ${index + 1}</div>`).join("")}
  </div>
  <div class="band">BUSY BACKGROUND CONTENT</div>
  <div class="copy">
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet.</p>
    <p>Donec ullamcorper nulla non metus auctor fringilla. Cras mattis consectetur purus sit amet fermentum.</p>
    <p>Maecenas faucibus mollis interdum. Vestibulum id ligula porta felis euismod semper eget lacinia odio sem.</p>
    <p>Aenean eu leo quam. Pellentesque ornare sem lacinia quam venenatis vestibulum.</p>
    <p>Etiam porta sem malesuada magna mollis euismod. Nullam quis risus eget urna mollis ornare vel eu leo.</p>
    <p>Curabitur blandit tempus porttitor. Sed posuere consectetur est at lobortis.</p>
  </div>
</body>
</html>`;

async function main() {
  mkdirSync(shotsDir, { recursive: true });

  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profileDir = mkdtempSync(join(tmpdir(), "jump-opacity-shots-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: findChromium(),
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--disable-gpu",
    ],
  });

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "load" });
    await page.waitForTimeout(600);

    const fixtureTabId = await worker.evaluate(async (urlPrefix) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => (tab.url ?? "").startsWith(urlPrefix))?.id;
    }, origin);
    if (!fixtureTabId) throw new Error("fixture tab not found in chrome.tabs");

    const setSettings = async (settings) => {
      await worker.evaluate(async (patch) => {
        await chrome.storage.sync.set(patch);
      }, settings);
    };

    const openPalette = async (mode) => {
      await page.bringToFront();
      await worker.evaluate(async ({ tabId, mode }) => {
        const deadline = Date.now() + 10_000;
        let lastError;
        while (Date.now() < deadline) {
          try {
            // Like the background: the palette is injected on first open.
            try {
              await chrome.tabs.sendMessage(tabId, { type: "open-palette", mode });
            } catch {
              await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["assets/content.js"] });
              await chrome.tabs.sendMessage(tabId, { type: "open-palette", mode });
            }
            return;
          } catch (error) {
            lastError = String(error);
            await new Promise((done) => setTimeout(done, 150));
          }
        }
        throw new Error(`palette message never landed: ${lastError}`);
      }, { tabId: fixtureTabId, mode });
      await page.waitForSelector("#jump-command-palette", { state: "attached", timeout: 10_000 });
      await page.waitForTimeout(700);
    };

    const shootOverlay = async (name, settings, mode = "search") => {
      await setSettings(settings);
      await page.goto(origin, { waitUntil: "load" });
      await page.waitForTimeout(400);
      await openPalette(mode);
      const path = join(shotsDir, `${name}.png`);
      await page.screenshot({ path });
      console.log(`wrote ${path}`);
      return path;
    };

    const shots = [];
    for (const opacity of [0, 0.5, 1]) {
      for (const blur of [0, 16]) {
        shots.push(await shootOverlay(`palette-opacity-${opacity}-blur-${blur}`, {
          theme: "default",
          colorScheme: "dark",
          viewMode: "list",
          paletteViewMode: "expanded",
          paletteOpacity: opacity,
          paletteBlur: blur,
        }));
      }
    }

    for (const opacity of [0, 1]) {
      shots.push(await shootOverlay(`switcher-opacity-${opacity}`, {
        theme: "default",
        colorScheme: "dark",
        paletteOpacity: opacity,
        paletteBlur: 0,
      }, "switcher"));
    }

    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 320, height: 900 });
    for (const opacity of [0, 1]) {
      await setSettings({
        theme: "default",
        colorScheme: "dark",
        paletteViewMode: "collapsed",
        paletteOpacity: opacity,
        paletteBlur: 16,
      });
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
      await popupPage.waitForTimeout(700);
      const path = join(shotsDir, `popup-opacity-${opacity}.png`);
      await popupPage.screenshot({ path, fullPage: true });
      console.log(`wrote ${path}`);
      shots.push(path);
    }

    // Close the palette so no overlay is left mounted before we exit.
    await page.bringToFront();
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(200);

    console.log(`\n${shots.length} screenshots in ${shotsDir}`);
  } finally {
    await context.close().catch(() => undefined);
    await new Promise((done) => server.close(done));
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
