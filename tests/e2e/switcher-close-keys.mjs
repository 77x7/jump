#!/usr/bin/env node
/**
 * Tab switcher: keys released while it closes must not switch tabs.
 *
 * Escape closes the switcher on key down. The key releases that follow (Escape
 * itself, or Alt) arrive during the closing animation and used to count as
 * "modifier released", switching to the selected tab anyway. Enter likewise
 * switched once on key down and tried again on key up.
 *
 * Usage:
 *   xvfb-run -a node tests/e2e/switcher-close-keys.mjs
 *   EXT_DIST=/path/to/dist xvfb-run -a node tests/e2e/switcher-close-keys.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const extensionDir = path.resolve(process.env.EXT_DIST ?? path.join(repoRoot, "dist"));
const cache = path.join(os.homedir(), ".cache/ms-playwright");
const revision = readdirSync(cache)
  .filter((name) => /^chromium-\d+$/.test(name))
  .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><title>Page ${request.url}</title><p>${request.url}</p>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(os.tmpdir(), "jump-switcher-keys-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: path.join(cache, revision, "chrome-linux64/chrome"),
  headless: false,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  for (const name of ["other-a", "other-b"]) {
    const page = await context.newPage();
    await page.goto(`${origin}/${name}`, { waitUntil: "load" });
  }
  const page = await context.newPage();
  await page.goto(`${origin}/home`, { waitUntil: "load" });

  const activeUrl = () => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? "";
  });
  const paletteOpen = () => page.evaluate(() => Boolean(document.getElementById("jump-command-palette")));

  async function openSwitcher() {
    await page.bringToFront();
    await sleep(2500); // page idle: the standby switcher is ready
    await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-tab-switcher"));
    for (let i = 0; i < 40 && !(await paletteOpen()); i += 1) await sleep(50);
    return paletteOpen();
  }

  async function afterClose(name, keys) {
    if (!(await openSwitcher())) {
      check(name, false, "switcher did not open");
      return;
    }
    await keys();
    await sleep(600);
    const url = await activeUrl();
    check(name, url === `${origin}/home` && !(await paletteOpen()), `active tab ${url}`);
  }

  await afterClose("Escape closes without switching", async () => {
    await page.keyboard.press("Escape");
  });

  await afterClose("Alt held, Escape, Alt released: no switch", async () => {
    await page.keyboard.down("Alt");
    await page.keyboard.press("Escape");
    await page.keyboard.up("Alt");
  });

  await afterClose("Escape held past Alt release: no switch", async () => {
    await page.keyboard.down("Alt");
    await page.keyboard.down("Escape");
    await page.keyboard.up("Alt");
    await sleep(50);
    await page.keyboard.up("Escape");
  });

  // Enter still switches, exactly once, to the selected (next) tab.
  if (await openSwitcher()) {
    const switches = await worker.evaluate(() => {
      globalThis.__jumpActivations = [];
      globalThis.__jumpOnActivated ??= chrome.tabs.onActivated.addListener((info) => globalThis.__jumpActivations.push(info.tabId));
      return true;
    }).then(async () => {
      await page.keyboard.press("Enter");
      await sleep(800);
      return worker.evaluate(() => globalThis.__jumpActivations.length);
    });
    const url = await activeUrl();
    check("Enter switches once", switches === 1 && url !== `${origin}/home`, `${switches} activation(s), active tab ${url}`);
  } else {
    check("Enter switches once", false, "switcher did not open");
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
  server.close();
}

const passed = checks.filter(Boolean).length;
console.log(`RESULT: ${passed === checks.length ? "PASS" : "FAIL"} (${passed}/${checks.length} checks)`);
process.exitCode = passed === checks.length ? 0 : 1;
