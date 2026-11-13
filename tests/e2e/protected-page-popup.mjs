#!/usr/bin/env node
/**
 * The palette on pages Chrome does not let extensions draw on.
 *
 * On chrome:// pages (New Tab, Settings, ...) and the Web Store no content
 * script runs, so the shortcut opens the palette in the toolbar popup instead
 * (palette.html). Playwright does not expose extension popups as pages, so the
 * popup is driven through its DevTools target.
 *
 * Usage (after `pnpm build`):
 *   xvfb-run -a node tests/e2e/protected-page-popup.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const extensionDir = path.resolve(process.env.EXT_DIST ?? path.join(repoRoot, "dist"));
const artifactDir = path.join(here, "artifacts");
mkdirSync(artifactDir, { recursive: true });

function chromiumExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  const revision = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];
  return path.join(cache, revision, "chrome-linux64/chrome");
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><title>${request.url.slice(1)}</title><p>${request.url}</p>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(os.tmpdir(), "jump-protected-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromiumExecutable(),
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--window-size=1280,800"],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30000 }));
  for (const name of ["alpha", "bravo"]) {
    const tab = await context.newPage();
    await tab.goto(`${origin}/${name}`);
  }
  const page = context.pages()[0];
  await page.goto("chrome://newtab");
  await page.bringToFront();
  await sleep(800);
  const browser = await context.newCDPSession(page);

  const activeTab = () => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? "";
  });

  async function findPopup() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const { targetInfos } = await browser.send("Target.getTargets");
      const target = targetInfos.find((info) => info.url.includes("/palette.html"));
      if (target) return target;
      await sleep(25);
    }
    return undefined;
  }

  // A minimal client for one popup target over the browser session.
  async function attach(target) {
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    let nextId = 1;
    const call = (method, params = {}) => new Promise((resolve) => {
      const id = nextId++;
      const onMessage = (event) => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        browser.off("Target.receivedMessageFromTarget", onMessage);
        resolve(message.result);
      };
      browser.on("Target.receivedMessageFromTarget", onMessage);
      void browser.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) });
    });
    const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true }))?.result?.value;
    const press = async (key, text) => {
      await call("Input.dispatchKeyEvent", { type: "keyDown", key, text, windowsVirtualKeyCode: key === "Enter" ? 13 : 0 });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key });
    };
    const screenshot = async (name) => {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      if (shot?.data) writeFileSync(path.join(artifactDir, name), Buffer.from(shot.data, "base64"));
    };
    return { evaluate, press, screenshot };
  }

  // Search: opens in the popup with the keyboard in the search box.
  await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-palette"));
  const searchTarget = await findPopup();
  check("search shortcut on the New Tab page opens the popup palette", Boolean(searchTarget));
  if (searchTarget) {
    const popup = await attach(searchTarget);
    await sleep(500);
    check("search box has focus", (await popup.evaluate("document.activeElement?.className")) === "search-input");
    for (const character of "bravo") await popup.press(character, character);
    await sleep(300);
    check("typing reaches the search box", (await popup.evaluate("document.querySelector('.search-input')?.value")) === "bravo");
    await popup.screenshot("popup-search.png");
    await popup.press("Enter");
    const switched = await (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await activeTab()).endsWith("/bravo")) return true;
        await sleep(50);
      }
      return false;
    })();
    check("Enter switches to the matched tab", switched, `active=${await activeTab()}`);
  }
  check("the toolbar button opens the settings again", (await worker.evaluate(() => chrome.action.getPopup({}))).endsWith("/popup.html"));

  // Switcher: opens in the popup; the shortcut again cycles it.
  await page.bringToFront();
  await sleep(500);
  await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-tab-switcher"));
  const switcherTarget = await findPopup();
  check("switcher shortcut on the New Tab page opens the popup switcher", Boolean(switcherTarget));
  if (switcherTarget) {
    const popup = await attach(switcherTarget);
    await sleep(500);
    const selected = () => popup.evaluate("Number(document.querySelector('.switcher-card.is-selected')?.getAttribute('data-switcher-index'))");
    const before = await selected();
    await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-tab-switcher"));
    await sleep(300);
    const after = await selected();
    check("the switcher shortcut again cycles the popup switcher", Number.isInteger(before) && after !== before, `before=${before} after=${after}`);
    await popup.screenshot("popup-switcher.png");
    await popup.evaluate("window.close()");
  }
} finally {
  await context.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
  server.close();
}

const passed = checks.filter(Boolean).length;
console.log(`RESULT: ${passed === checks.length ? "PASS" : "FAIL"} (${passed}/${checks.length} checks)`);
process.exitCode = passed === checks.length ? 0 : 1;
