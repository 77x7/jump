// Screenshots of the settings popup across themes and states.
//
//   xvfb-run -a node tests/e2e/popup-shots.mjs
//
// Writes PNGs to tests/e2e/shots/popup-*.png (gitignored).
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "../../dist");
const shotsDir = resolve(here, "shots");

function findChromium() {
  if (process.env.JUMP_CHROMIUM) return process.env.JUMP_CHROMIUM;
  const cacheDir = join(process.env.HOME ?? "", ".cache/ms-playwright");
  const revisions = readdirSync(cacheDir)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const revision of revisions) {
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

const OCEAN = {
  id: "custom-ocean001",
  name: "Ocean",
  base: "default",
  scheme: "dark",
  colors: { accent: "#22d3ee", background: "#0b1b2b", text: "#e6f6ff", selectedRow: "#0e7490" },
};

const CASES = [
  { name: "mono-dark", settings: { colorScheme: "dark", darkTheme: "default" } },
  { name: "latte-light", settings: { colorScheme: "light", lightTheme: "catppuccin-latte" } },
  {
    name: "auto-colors-open",
    media: "dark",
    open: true,
    settings: {
      colorScheme: "auto",
      darkTheme: "nord",
      lightTheme: "rose-pine-dawn",
      themeOverrides: { nord: { accent: "#ff5c8a", selectedRow: "#ffd166", selectedRowText: "#1a1a1a" } },
      customThemes: [OCEAN],
      paletteOpacity: 0.3,
      paletteBlur: 12,
    },
  },
  {
    name: "warning-open",
    open: true,
    settings: {
      colorScheme: "light",
      lightTheme: "gruvbox-light",
      themeOverrides: { "gruvbox-light": { text: "#d5c4a1", selectedRowText: "#e9c3ad" } },
    },
  },
  { name: "gruvbox-dark-clear", settings: { colorScheme: "dark", darkTheme: "gruvbox-dark", paletteOpacity: 0, paletteBlur: 0 } },
];

const BASE = {
  colorScheme: "dark",
  lightTheme: "default",
  darkTheme: "default",
  themeOverrides: {},
  customThemes: [],
  paletteOpacity: 0.84,
  paletteBlur: 40,
};

mkdirSync(shotsDir, { recursive: true });
const profileDir = mkdtempSync(join(tmpdir(), "jump-popup-shots-"));
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: findChromium(),
  headless: false,
  viewport: { width: 320, height: 1400 },
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, "--no-first-run"],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  for (const shot of CASES) {
    await worker.evaluate(async (settings) => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(settings);
    }, { ...BASE, ...shot.settings });
    await page.emulateMedia({ colorScheme: shot.media ?? "dark" });
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    if (shot.open) await page.locator(".popup-disclosure-summary").click();
    await page.waitForTimeout(200);
    const file = join(shotsDir, `popup-${shot.name}.png`);
    await page.locator("main").screenshot({ path: file });
    console.log(`wrote ${file}`);
  }
} finally {
  await context.close();
  rmSync(profileDir, { recursive: true, force: true });
}
