#!/usr/bin/env node
/**
 * Middle click on a tab in the palette (search list) or the tab switcher
 * closes that tab, and the palette stays open without it.
 *
 * Usage (after `pnpm build`):
 *   xvfb-run -a node tests/e2e/middle-click-close.mjs
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

const profile = mkdtempSync(path.join(os.tmpdir(), "jump-middle-click-"));
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

  // Search list: middle-click the second row.
  await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-palette"));
  await sleep(800);
  const rowMatch = (attributes) => attributes["data-index"] === "1" && /(^| )list-row( |$)/.test(attributes.class ?? "");
  const searchTitle = await titleUnder(rowMatch);
  const [searchRow] = await findBox(rowMatch);
  check("search list shows a second tab row", Boolean(searchRow && searchTitle), `title=${searchTitle}`);
  if (searchRow) {
    await page.mouse.click(searchRow.x, searchRow.y, { button: "middle" });
    await sleep(800);
    const urls = await openUrls();
    check("middle click closes that tab", !urls.some((url) => url.endsWith(`/${searchTitle}`)), `open=${urls.map((url) => url.split("/").pop()).join(",")}`);
    check("the palette stays open", await paletteOpen());
    const titles = [];
    for (let index = 0; index < 6; index += 1) titles.push(await titleUnder((attributes) => attributes["data-index"] === String(index)));
    await page.screenshot({ path: path.join(here, "artifacts", "middle-click-after.png") });
    check(
      "the list still shows the other tabs, without the closed one",
      titles.filter(Boolean).length >= 3 && !titles.includes(searchTitle),
      `rows=${titles.filter(Boolean).join(",")}`,
    );
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sleep(2500);

  // Switcher: middle-click a card that is not the selected one.
  await page.keyboard.down("Alt");
  await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-tab-switcher"));
  await sleep(800);
  const cardMatch = (attributes) => attributes["data-switcher-index"] === "2";
  const cardTitle = await titleUnder(cardMatch);
  const [card] = await findBox(cardMatch);
  check("switcher shows a third card", Boolean(card && cardTitle), `title=${cardTitle}`);
  if (card) {
    await page.mouse.click(card.x, card.y, { button: "middle" });
    await sleep(800);
    const urls = await openUrls();
    check("middle click on a switcher card closes that tab", !urls.some((url) => url.endsWith(`/${cardTitle}`)), `open=${urls.map((url) => url.split("/").pop()).join(",")}`);
    check("the switcher stays open", await paletteOpen());
  }
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
