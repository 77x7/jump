import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio } from "../src/appearance.ts";
import { COLOR_THEMES } from "../src/themes.ts";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
const popupPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/popup/popup.css");
// Theme blocks live in styles.css; the popup's own sheet uses the same tokens.
const css = `${readFileSync(stylesPath, "utf8")}\n${readFileSync(popupPath, "utf8")}`.replace(/\/\*[\s\S]*?\*\//g, "");

// Tokens the overlays/popup must be able to read from the theme block itself.
// `--surface-*` opacity scaffolding is set inline per overlay, and the `*-fill`
// variables are derived with color-mix inside `.palette-backdrop`.
const INLINE_TOKENS = new Set([
  "--surface-alpha",
  "--surface-blur",
  "--surface-panel-fill",
  "--surface-hud-fill",
  "--surface-card-fill",
  "--surface-card-hover-fill",
]);

type Block = { selector: string; vars: Map<string, string> };

function themeBlocks(): Block[] {
  const blocks: Block[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    const isThemeBlock = /^:root,\s*\[data-theme="default"\]$/.test(selector)
      || /^\[data-theme="[a-z-]+"\]$/.test(selector)
      || /^\[data-scheme="light"\]\[data-theme="default"\]$/.test(selector);
    if (!isThemeBlock) continue;
    const vars = new Map<string, string>();
    for (const declaration of match[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      vars.set(declaration[1], declaration[2].trim());
    }
    blocks.push({ selector, vars });
  }
  return blocks;
}

const blocks = themeBlocks();

test("finds every preset block plus the light-scheme default block", () => {
  assert.equal(blocks.length, COLOR_THEMES.length + 1);
  for (const theme of COLOR_THEMES) {
    assert.ok(blocks.some((block) => block.selector === `[data-theme="${theme}"]` || block.selector.includes(`[data-theme="${theme}"]`)), `missing block for ${theme}`);
  }
  assert.ok(blocks.some((block) => block.selector === '[data-scheme="light"][data-theme="default"]'));
});

test("every theme block defines every token used by the overlays and popup", () => {
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
  const required = [...used].filter((token) => !INLINE_TOKENS.has(token));
  assert.ok(required.includes("--row-selected-bg"));
  assert.ok(required.includes("--row-selected-fg"));
  assert.ok(required.includes("--address-value"));

  for (const block of blocks) {
    const missing = required.filter((token) => !block.vars.has(token));
    assert.deepEqual(missing, [], `${block.selector} is missing ${missing.join(", ")}`);
  }
});

test("preset text stays readable on its own panel", () => {
  for (const block of blocks) {
    const text = block.vars.get("--text-primary");
    const panel = block.vars.get("--surface-panel");
    assert.ok(text && panel, `${block.selector} needs --text-primary and --surface-panel`);
    const ratio = contrastRatio(text, panel);
    assert.ok(ratio >= 4.5, `${block.selector} text contrast is ${ratio.toFixed(2)}:1`);
  }
});

test("preset selected rows keep their label readable", () => {
  for (const block of blocks) {
    const fg = block.vars.get("--row-selected-fg");
    const bg = block.vars.get("--row-selected-bg");
    assert.ok(fg && bg, `${block.selector} needs --row-selected-fg and --row-selected-bg`);
    assert.ok(!bg.includes("var("), `${block.selector} row background must not depend on another theme block`);
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${block.selector} selected row contrast is ${ratio.toFixed(2)}:1`);
  }
});
