// Visual proof for the appearance work: Auto scheme, per-theme colour
// overrides, saved custom themes, the popup's new controls, and every preset.
//
// Run with xvfb-run so the extension loads headful:
//   xvfb-run -a node tests/e2e/color-shots.mjs
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

const PRESETS = [
  ["default", "dark"],
  ["catppuccin-mocha", "dark"],
  ["rose-pine-main", "dark"],
  ["tokyo-night", "dark"],
  ["nord", "dark"],
  ["gruvbox-dark", "dark"],
  ["catppuccin-frappe", "dark"],
  ["catppuccin-macchiato", "dark"],
  ["rose-pine-moon", "dark"],
  ["vesper", "dark"],
  ["catppuccin-latte", "light"],
  ["rose-pine-dawn", "light"],
  ["gruvbox-light", "light"],
  // Mono also has a light-scheme variant block of its own.
  ["default-light", "light"],
];

const OCEAN = {
  id: "custom-ocean001",
  name: "Ocean",
  base: "default",
  scheme: "dark",
  colors: { accent: "#22d3ee", background: "#0b1b2b", text: "#e6f6ff", selectedRow: "#0e7490" },
};

const BASE_SETTINGS = {
  viewMode: "list",
  lightTheme: "default",
  darkTheme: "default",
  colorScheme: "dark",
  themeOverrides: {},
  customThemes: [],
  disableMouseTabSwitcher: false,
  disableMouseCommandPalette: false,
  disableMouseBookmarks: false,
  tabSwitchMode: "recent",
  paletteViewMode: "expanded",
  paletteOpacity: 1,
  paletteBlur: 0,
  pinnedTabs: [],
  palettePosition: { x: 0.5, y: 0.28 },
};

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
];

const fixtureHtml = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Jump fixture</title>
<style>
  html, body { margin: 0; padding: 0; font-family: Georgia, serif; background: #ffffff; color: #111; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 16px; }
  .tile { height: 120px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; font: 700 14px/1 system-ui, sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,.55); }
</style>
</head>
<body>
  <div class="grid">
    ${TILE_COLORS.map((color, index) => `<div class="tile" style="background:${color}">TILE ${index + 1}</div>`).join("")}
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

  const profileDir = mkdtempSync(join(tmpdir(), "jump-color-shots-"));
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

    const setSettings = async (patch) => {
      await worker.evaluate(async (settings) => {
        await chrome.storage.sync.clear();
        await chrome.storage.sync.set(settings);
      }, { ...BASE_SETTINGS, ...patch });
    };

    const openFixtureTabs = async (page) => {
      await page.goto(`${origin}/?fixture=1`, { waitUntil: "load" });
      for (const name of ["notes", "design-review", "release-checklist"]) {
        const extra = await context.newPage();
        await extra.goto(`${origin}/?tab=${name}`, { waitUntil: "load" });
        await extra.waitForTimeout(120);
      }
      await page.bringToFront();
      await page.waitForTimeout(200);
    };

    const fixtureTabId = async () => {
      const tabId = await worker.evaluate(async (urlPrefix) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => (tab.url ?? "").startsWith(`${urlPrefix}/?fixture=1`))?.id;
      }, origin);
      if (!tabId) throw new Error("fixture tab not found in chrome.tabs");
      return tabId;
    };

    const openPalette = async (page) => {
      await page.bringToFront();
      const tabId = await fixtureTabId();
      await worker.evaluate(async ({ id }) => {
        const deadline = Date.now() + 10_000;
        let lastError;
        while (Date.now() < deadline) {
          try {
            await chrome.tabs.sendMessage(id, { type: "open-palette", mode: "search" });
            return;
          } catch (error) {
            lastError = String(error);
            await new Promise((done) => setTimeout(done, 150));
          }
        }
        throw new Error(`palette message never landed: ${lastError}`);
      }, { id: tabId });
      await page.waitForSelector("#jump-command-palette", { state: "attached", timeout: 10_000 });
      await page.waitForTimeout(600);
    };

    const closePalette = async (page) => {
      await page.bringToFront();
      await page.keyboard.press("Escape");
      await page.waitForSelector("#jump-command-palette", { state: "detached", timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(200);
    };

    const shootPalette = async (page, name, patch, { media } = {}) => {
      await closePalette(page);
      await setSettings(patch);
      if (media) await page.emulateMedia({ colorScheme: media });
      await page.goto(`${origin}/?fixture=1`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      await openPalette(page);
      const path = join(shotsDir, `${name}.png`);
      await page.screenshot({ path });
      console.log(`wrote ${path}`);
      return path;
    };

    const shots = [];
    const page = await context.newPage();
    await openFixtureTabs(page);

    // (1) Auto scheme: same settings, OS preference flips live.
    await page.emulateMedia({ colorScheme: "dark" });
    shots.push(await shootPalette(page, "auto-dark", {
      colorScheme: "auto",
      darkTheme: "catppuccin-mocha",
      lightTheme: "catppuccin-latte",
    }, { media: "dark" }));
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(700);
    const liveLightPath = join(shotsDir, "auto-light-live.png");
    await page.screenshot({ path: liveLightPath });
    console.log(`wrote ${liveLightPath} (palette stayed open across the media change)`);
    shots.push(liveLightPath);
    // And once more opened fresh under the light preference.
    shots.push(await shootPalette(page, "auto-light", {
      colorScheme: "auto",
      darkTheme: "catppuccin-mocha",
      lightTheme: "catppuccin-latte",
    }, { media: "light" }));

    // (2) Per-theme colour overrides on a preset.
    shots.push(await shootPalette(page, "override-colors", {
      colorScheme: "dark",
      darkTheme: "nord",
      themeOverrides: {
        nord: {
          accent: "#ff5c8a",
          background: "#101820",
          selectedRow: "#ffd166",
          selectedRowText: "#101820",
        },
      },
    }, { media: "dark" }));

    // (3) A saved custom theme, chosen as the dark slot.
    shots.push(await shootPalette(page, "custom-theme", {
      colorScheme: "auto",
      darkTheme: OCEAN.id,
      lightTheme: "rose-pine-dawn",
      customThemes: [OCEAN],
    }, { media: "dark" }));

    // (5) Every preset with a selected row.
    for (const [theme, scheme] of PRESETS) {
      const preset = theme === "default-light" ? "default" : theme;
      shots.push(await shootPalette(page, `preset-${theme}`, {
        colorScheme: scheme,
        ...(scheme === "dark" ? { darkTheme: preset } : { lightTheme: preset }),
      }, { media: scheme }));
    }

    // (4) Popup in Auto: both selects, the Colors section and the custom list.
    await setSettings({
      colorScheme: "auto",
      darkTheme: "nord",
      lightTheme: "rose-pine-dawn",
      customThemes: [OCEAN],
    });
    await context.pages()[0].emulateMedia({ colorScheme: "dark" });
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 305, height: 1200 });
    await popupPage.emulateMedia({ colorScheme: "dark" });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
    await popupPage.waitForTimeout(800);
    const popupPath = join(shotsDir, "popup-auto-colors.png");
    await popupPage.locator("main").screenshot({ path: popupPath });
    console.log(`wrote ${popupPath}`);
    shots.push(popupPath);

    // The contrast warning for a pair under 4.5:1.
    await setSettings({
      colorScheme: "dark",
      darkTheme: "nord",
      themeOverrides: {
        nord: { text: "#9aa0a8", background: "#3b4252", selectedRow: "#cbd5e1", selectedRowText: "#dbe3ec" },
      },
    });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
    await popupPage.waitForTimeout(800);
    const warningPath = join(shotsDir, "popup-contrast-warning.png");
    await popupPage.locator("main").screenshot({ path: warningPath });
    console.log(`wrote ${warningPath}`);
    shots.push(warningPath);

    await closePalette(page);
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
