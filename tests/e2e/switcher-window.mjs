#!/usr/bin/env node
/**
 * Tab switcher: only the cards near the selection and the visible scroll area
 * are rendered.
 *
 * A switcher palette is preloaded in every page, so a card per tab costs every
 * page ~800 DOM nodes and ~2.4 MB of heap at 40 tabs. Cards outside the
 * rendered window are replaced by spacers that keep the track's width and every
 * card's position unchanged.
 *
 * The palette lives in a closed shadow root, so its cards are read through CDP
 * (`DOM.querySelectorAll` on the shadow root) and the visible result is checked
 * from a screenshot crop around the track centre.
 *
 * Usage:
 *   xvfb-run -a node tests/e2e/switcher-window.mjs
 *   EXT_DIST=/path/to/dist xvfb-run -a node tests/e2e/switcher-window.mjs
 *   TABS=60 ARTIFACTS=/tmp/shots xvfb-run -a node tests/e2e/switcher-window.mjs
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const extensionDir = path.resolve(process.env.EXT_DIST ?? path.join(repoRoot, "dist"));
const TABS = Number(process.env.TABS ?? 60);
const artifactDir = path.resolve(process.env.ARTIFACTS ?? path.join(repoRoot, "tests", "e2e", "artifacts"));
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
  // A flat, colourful page: a preview or a placeholder card is clearly not the
  // palette background, and the area outside the HUD stays uniform.
  response.end(
    `<!doctype html><title>Page ${request.url}</title>` +
    `<body style="margin:0;height:100vh;background:hsl(${(request.url.length * 47) % 360} 70% 55%)">` +
    `<p style="position:fixed;right:8px;bottom:8px;margin:0">${request.url}</p></body>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(os.tmpdir(), "jump-switcher-window-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: path.join(cache, revision, "chrome-linux64/chrome"),
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  // Reuse the page the browser opened with, so the tab count is exactly TABS.
  const pages = [context.pages()[0] ?? await context.newPage()];
  await pages[0].goto(`${origin}/tab-0`, { waitUntil: "load" });
  for (let index = 1; index < TABS; index += 1) {
    const tab = await context.newPage();
    await tab.goto(`${origin}/tab-${index}`, { waitUntil: "load" });
    pages.push(tab);
  }
  // The switcher opens in the tab that is active when the command fires.
  const page = pages.at(-1);
  const viewport = page.viewportSize();

  const paletteOpen = () => page.evaluate(() => Boolean(document.getElementById("jump-command-palette")));

  // The palette's shadow root is closed: read the cards through CDP instead.
  const cdp = await context.newCDPSession(page);
  async function paletteCards() {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId: hostNodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#jump-command-palette",
    });
    if (!hostNodeId) return [];
    const { node: host } = await cdp.send("DOM.describeNode", { nodeId: hostNodeId, depth: 1, pierce: true });
    const shadow = host.shadowRoots?.[0];
    if (!shadow) return [];
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: shadow.nodeId, selector: ".switcher-card" });
    const cards = [];
    for (const nodeId of nodeIds) {
      const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
      const attribute = (name) => {
        for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === name) return attributes[i + 1];
        return undefined;
      };
      cards.push({
        nodeId,
        index: Number(attribute("data-switcher-index")),
        selected: attribute("aria-selected") === "true",
        setSize: attribute("aria-setsize"),
        posInSet: attribute("aria-posinset"),
      });
    }
    return cards.sort((a, b) => a.index - b.index);
  }
  const selectedIndex = (list) => list.find((card) => card.selected)?.index ?? null;
  const range = (list) => `cards=${list.length} first=${list[0]?.index} last=${list.at(-1)?.index}`;

  // How far a screenshot crop is from one flat colour: a card is full of
  // detail, a spacer area (or the palette's background) is not.
  async function cropStats(clip, label) {
    const png = await page.screenshot({ clip });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, `switcher-window-${label}.png`), png);
    return page.evaluate(async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const counts = new Map();
      let sum = 0;
      let sumSquares = 0;
      for (let i = 0; i < data.length; i += 4) {
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += luminance;
        sumSquares += luminance * luminance;
      }
      const pixels = data.length / 4;
      const mean = sum / pixels;
      return {
        pixels,
        buckets: counts.size,
        dominantShare: Math.max(...counts.values()) / pixels,
        stdDev: Math.sqrt(Math.max(0, sumSquares / pixels - mean * mean)),
      };
    }, `data:image/png;base64,${png.toString("base64")}`);
  }

  async function openSwitcher() {
    await page.bringToFront();
    await sleep(2500); // page idle: the standby switcher is ready
    await worker.evaluate(() => chrome.commands.onCommand.dispatch("open-tab-switcher"));
    for (let i = 0; i < 60 && !(await paletteOpen()); i += 1) await sleep(50);
    await sleep(700); // settle: cards mounted, scrollIntoView applied
    return paletteOpen();
  }

  if (!(await openSwitcher())) {
    check("the switcher opens", false, "palette never appeared");
    throw new Error("switcher did not open");
  }

  // ------------------------------------------------------- (a) rendered window
  const opened = await paletteCards();
  const openedSelected = selectedIndex(opened);
  // Selection window (2*6+1) plus the cards visible in a 1280px track (5) and
  // its overscan on both sides; anything more means cards still render for tabs
  // nobody can see.
  const limit = 25;
  check(
    `renders at most ${limit} of ${TABS} cards`,
    opened.length > 0 && opened.length <= limit,
    range(opened),
  );
  check("the selection is rendered", openedSelected !== null, `selected=${openedSelected}`);
  check(
    "rendered cards keep real indices, order and set size",
    opened.every((card, offset) => card.index === opened[0].index + offset),
    range(opened),
  );
  check(
    "each card reports its set size and position",
    opened.every((card) => card.setSize === String(TABS) && card.posInSet === String(card.index + 1)),
    `sizes=${[...new Set(opened.map((card) => card.setSize))].join(",")} first-posinset=${opened[0]?.posInSet}`,
  );

  // ------------------------------------------------- (b) selection far right
  // Alt stays down while tabbing: the switcher cycles on Tab, and releasing Alt
  // is what switches to the selected tab.
  const presses = 40;
  await page.keyboard.down("Alt");
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press("Tab");
    await sleep(25);
  }
  await sleep(700);
  const afterTabs = await paletteCards();
  const afterSelected = selectedIndex(afterTabs);
  const expected = ((openedSelected ?? 0) + presses) % TABS;
  check(`Tab x${presses} selects tab ${expected}`, afterSelected === expected, `selected=${afterSelected}`);
  check(
    "the window followed the far selection",
    afterTabs.some((card) => card.index === expected) && afterTabs.length <= limit,
    range(afterTabs),
  );

  // The selected card must be on screen, not parked behind a spacer.
  const selectedNode = afterTabs.find((card) => card.selected);
  const box = selectedNode ? (await cdp.send("DOM.getBoxModel", { nodeId: selectedNode.nodeId })).model : null;
  const [x1, y1, , , x3, y3] = box?.border ?? [];
  const centreX = viewport.width / 2;
  const centreY = viewport.height / 2;
  check(
    "the selected card is on screen",
    Boolean(box) && x1 >= 0 && x3 <= viewport.width && y1 >= 0 && y3 <= viewport.height,
    box ? `card x=${x1.toFixed(0)}..${x3.toFixed(0)} y=${y1.toFixed(0)}..${y3.toFixed(0)} in ${viewport.width}x${viewport.height}` : "no box model",
  );
  check(
    "the selected card covers the track centre",
    Boolean(box) && x1 <= centreX && x3 >= centreX && y1 <= centreY && y3 >= centreY,
    box ? `card centre x=${((x1 + x3) / 2).toFixed(0)} y=${((y1 + y3) / 2).toFixed(0)}` : "no box model",
  );

  // Screenshot proof: the card area is full of detail, the palette background
  // outside the HUD is flat.
  const cardCrop = box
    ? { x: Math.round((x1 + x3) / 2 - 130), y: Math.round((y1 + y3) / 2 - 60), width: 260, height: 120 }
    : { x: Math.round(centreX - 130), y: Math.round(centreY - 60), width: 260, height: 120 };
  const cardPixels = await cropStats(cardCrop, "selected-card");
  const backgroundPixels = await cropStats({ x: 0, y: 0, width: 260, height: 120 }, "background");
  console.log(`      card crop ${JSON.stringify(cardCrop)}: ${JSON.stringify(cardPixels)}`);
  console.log(`      background crop 0,0 260x120: ${JSON.stringify(backgroundPixels)}`);
  check(
    "the track centre shows a card, not a blank spacer",
    cardPixels.buckets >= 4 &&
      cardPixels.dominantShare < 0.98 &&
      cardPixels.stdDev > 1.5 &&
      cardPixels.stdDev > backgroundPixels.stdDev * 3 &&
      cardPixels.buckets > backgroundPixels.buckets,
    `card buckets=${cardPixels.buckets} share=${cardPixels.dominantShare.toFixed(3)} stdDev=${cardPixels.stdDev.toFixed(2)}; ` +
      `background buckets=${backgroundPixels.buckets} stdDev=${backgroundPixels.stdDev.toFixed(2)}`,
  );
  await page.screenshot({ path: path.join(artifactDir, "switcher-window-cycle-40.png") });

  // ------------------------------------------------------------- (c) wrap-around
  for (let i = 0; i < TABS && selectedIndex(await paletteCards()) !== 0; i += 1) {
    await page.keyboard.press("ArrowRight");
    await sleep(25);
  }
  const atZero = await paletteCards();
  check("ArrowRight wraps round to the first tab", selectedIndex(atZero) === 0, `selected=${selectedIndex(atZero)}`);
  await page.keyboard.press("ArrowLeft");
  await sleep(600);
  const wrapped = await paletteCards();
  const wrappedSelected = selectedIndex(wrapped);
  check("ArrowLeft from the first tab selects the last one", wrappedSelected === TABS - 1, `selected=${wrappedSelected}`);
  check(
    "the wrapped selection is rendered",
    wrapped.some((card) => card.index === TABS - 1) && wrapped.every((card) => card.setSize === String(TABS)),
    range(wrapped),
  );
  const wrappedNode = wrapped.find((card) => card.selected);
  const wrappedBox = wrappedNode ? (await cdp.send("DOM.getBoxModel", { nodeId: wrappedNode.nodeId })).model : null;
  const [wx1, wy1, , , wx3, wy3] = wrappedBox?.border ?? [NaN, NaN, NaN, NaN, NaN, NaN];
  check(
    "the wrapped selection is on screen",
    Boolean(wrappedBox) && wx1 >= 0 && wx3 <= viewport.width && wy1 >= 0 && wy3 <= viewport.height,
    wrappedBox ? `card x=${wx1.toFixed(0)}..${wx3.toFixed(0)} y=${wy1.toFixed(0)}..${wy3.toFixed(0)}` : "no box model",
  );
  const wrappedPixels = await cropStats(
    Number.isFinite(wx1)
      ? { x: Math.round((wx1 + wx3) / 2 - 130), y: Math.round((wy1 + wy3) / 2 - 60), width: 260, height: 120 }
      : { x: Math.round(centreX - 130), y: Math.round(centreY - 60), width: 260, height: 120 },
    "wrapped-card",
  );
  console.log(`      wrapped card crop: ${JSON.stringify(wrappedPixels)}`);
  await page.screenshot({ path: path.join(artifactDir, "switcher-window-wrapped.png") });
  // Releasing Alt switches to the selected tab and closes the switcher.
  await page.keyboard.up("Alt");
  await sleep(600);
  check("releasing Alt closes the switcher", !(await paletteOpen()), `palette=${await paletteOpen()}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
  server.close();
}

const passed = checks.filter(Boolean).length;
console.log(`RESULT: ${passed === checks.length ? "PASS" : "FAIL"} (${passed}/${checks.length} checks)`);
process.exitCode = passed === checks.length ? 0 : 1;
