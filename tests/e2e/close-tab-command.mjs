#!/usr/bin/env node
/**
 * The "Close tab" command (no default key; users bind it, e.g. to Ctrl+W):
 * with the palette closed it closes the current tab; with the search palette
 * or the switcher open it closes the selected tab and the palette stays open.
 *
 * Usage (after `pnpm build`):
 *   xvfb-run -a node tests/e2e/close-tab-command.mjs
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const extensionDir = path.resolve(process.env.EXT_DIST ?? path.join(repoRoot, "dist"));
mkdirSync(path.join(here, "artifacts"), { recursive: true });

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

const profile = mkdtempSync(path.join(os.tmpdir(), "jump-close-tab-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chromiumExecutable(),
  headless: false,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30000 }));
  await worker.evaluate(() => chrome.storage.sync.set({ paletteViewMode: "expanded" }));
  for (const name of ["alpha", "bravo", "charlie", "delta"]) {
    const tab = await context.newPage();
    await tab.goto(`${origin}/${name}`);
  }
  const page = await context.newPage();
  await page.goto(`${origin}/home`, { waitUntil: "load" });
  await page.bringToFront();
  await sleep(2500);
  const cdp = await context.newCDPSession(page);
  const openUrls = () => worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.url));
  const paletteOpen = () => page.evaluate(() => Boolean(document.getElementById("jump-command-palette")));

  // The palette is in a closed shadow root: find elements through the pierced
  // DOM tree and click at their centre.
  async function findBox(predicate) {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const matches = [];
    const walk = (node) => {
      const attributes = {};
      for (let index = 0; index < (node.attributes ?? []).length; index += 2) attributes[node.attributes[index]] = node.attributes[index + 1];
      if (predicate(attributes)) matches.push(node);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };
    walk(root);
    const boxes = [];
    for (const node of matches) {
      const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
      const [x1, y1, , , x3, y3] = model.content;
      boxes.push({ x: (x1 + x3) / 2, y: (y1 + y3) / 2 });
    }
    return boxes;
  }
  async function titleUnder(predicate) {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let title;
    const walk = (node, inside) => {
      const attributes = {};
      for (let index = 0; index < (node.attributes ?? []).length; index += 2) attributes[node.attributes[index]] = node.attributes[index + 1];
      const nowInside = inside || predicate(attributes);
      if (nowInside && /(^| )(row-title|switcher-card-title)( |$)/.test(attributes.class ?? "") && title === undefined) {
        title = node.children?.find((child) => child.nodeType === 3)?.nodeValue;
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child, nowInside);
    };
    walk(root, false);
    return title;
  }

  const closeTab = () => worker.evaluate(() => chrome.commands.onCommand.dispatch("close-tab"));
  const selectedTitle = (selector) => titleUnder(selector);

  // Palette closed: the current tab closes.
  const victim = await context.newPage();
  await victim.goto(`${origin}/victim`, { waitUntil: "load" });
  await victim.bringToFront();
  await sleep(500);
  await closeTab();
  await sleep(600);
  check("with the palette closed, the current tab closes", !(await openUrls()).some((url) => url.endsWith("/victim")));
  await page.bringToFront();
  await sleep(2500);

  // Search palette: the selected row's tab closes.
  await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-palette"));
  await sleep(800);
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  const searchTitle = await selectedTitle((attributes) => /(^| )list-row( |$)/.test(attributes.class ?? "") && /(^| )selected( |$)/.test(attributes.class ?? ""));
  await closeTab();
  await sleep(800);
  let urls = await openUrls();
  check("in search, the selected tab closes", Boolean(searchTitle) && !urls.some((url) => url.endsWith(`/${searchTitle}`)), `selected=${searchTitle} open=${urls.map((url) => url.split("/").pop()).join(",")}`);
  check("the current tab stays open", urls.some((url) => url.endsWith("/home")));
  check("the palette stays open", await paletteOpen());
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sleep(2500);

  // Switcher: the selected card's tab closes.
  await page.keyboard.down("Alt");
  await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-tab-switcher"));
  await sleep(800);
  const cardTitle = await selectedTitle((attributes) => /(^| )switcher-card( |$)/.test(attributes.class ?? "") && /(^| )is-selected( |$)/.test(attributes.class ?? ""));
  await closeTab();
  await sleep(800);
  urls = await openUrls();
  check("in the switcher, the selected tab closes", Boolean(cardTitle) && !urls.some((url) => url.endsWith(`/${cardTitle}`)), `selected=${cardTitle} open=${urls.map((url) => url.split("/").pop()).join(",")}`);
  check("the switcher stays open", await paletteOpen());
  await page.keyboard.press("Escape");
  await page.keyboard.up("Alt");
} finally {
  await context.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
  server.close();
}

const passed = checks.filter(Boolean).length;
console.log(`RESULT: ${passed === checks.length ? "PASS" : "FAIL"} (${passed}/${checks.length} checks)`);
process.exitCode = passed === checks.length ? 0 : 1;
