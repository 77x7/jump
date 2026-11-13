import assert from "node:assert/strict";
import test from "node:test";
import { contrastRatio, mixHex, overrideCssVars, resolveAppearance } from "../src/appearance.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { CustomTheme, UserSettings } from "../src/types.ts";

function settingsWith(overrides: Partial<UserSettings>): UserSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const ocean: CustomTheme = {
  id: "custom-ocean01",
  name: "Ocean",
  base: "default",
  scheme: "dark",
  colors: { accent: "#22d3ee", background: "#0b1b2b" },
};

test("resolveAppearance uses the dark slot for a fixed dark scheme", () => {
  const resolved = resolveAppearance(settingsWith({ colorScheme: "dark", darkTheme: "nord" }), false);
  assert.deepEqual(resolved, { themeId: "nord", baseTheme: "nord", scheme: "dark", cssVars: {} });
});

test("resolveAppearance uses the light slot for a fixed light scheme", () => {
  const resolved = resolveAppearance(settingsWith({ colorScheme: "light", lightTheme: "catppuccin-latte" }), true);
  assert.deepEqual(resolved, {
    themeId: "catppuccin-latte",
    baseTheme: "catppuccin-latte",
    scheme: "light",
    cssVars: {},
  });
});

test("resolveAppearance follows the system preference in auto", () => {
  const settings = settingsWith({
    colorScheme: "auto",
    darkTheme: "gruvbox-dark",
    lightTheme: "gruvbox-light",
  });
  assert.deepEqual(resolveAppearance(settings, true), {
    themeId: "gruvbox-dark",
    baseTheme: "gruvbox-dark",
    scheme: "dark",
    cssVars: {},
  });
  assert.deepEqual(resolveAppearance(settings, false), {
    themeId: "gruvbox-light",
    baseTheme: "gruvbox-light",
    scheme: "light",
    cssVars: {},
  });
});

test("resolveAppearance applies each slot's own overrides", () => {
  const settings = settingsWith({
    colorScheme: "auto",
    darkTheme: "nord",
    lightTheme: "rose-pine-dawn",
    themeOverrides: {
      nord: { accent: "#ff0000" },
      "rose-pine-dawn": { accent: "#00ff00" },
    },
  });
  assert.equal(resolveAppearance(settings, true).cssVars["--accent-primary"], "#ff0000");
  assert.equal(resolveAppearance(settings, false).cssVars["--accent-primary"], "#00ff00");
});

test("a custom theme renders on its base with its own colours", () => {
  const settings = settingsWith({
    colorScheme: "auto",
    darkTheme: ocean.id,
    customThemes: [ocean],
  });
  const resolved = resolveAppearance(settings, true);
  assert.equal(resolved.themeId, "custom-ocean01");
  assert.equal(resolved.baseTheme, "default");
  assert.equal(resolved.scheme, "dark");
  assert.equal(resolved.cssVars["--accent-primary"], "#22d3ee");
  assert.equal(resolved.cssVars["--surface-panel"], "#0b1b2b");
  assert.equal(resolved.cssVars["--accent-glow"], "rgba(34, 211, 238, 0.25)");
});

test("custom theme colours can be layered with overrides on their own id", () => {
  const settings = settingsWith({
    colorScheme: "auto",
    darkTheme: ocean.id,
    customThemes: [ocean],
    themeOverrides: { [ocean.id]: { accent: "#ffffff", text: "#eeeeee" } },
  });
  const resolved = resolveAppearance(settings, true);
  assert.equal(resolved.cssVars["--accent-primary"], "#ffffff");
  assert.equal(resolved.cssVars["--text-primary"], "#eeeeee");
  // Untouched custom colours survive the merge.
  assert.equal(resolved.cssVars["--surface-panel"], "#0b1b2b");
});

test("a deleted custom theme falls back to the scheme's default preset", () => {
  const settings = settingsWith({ colorScheme: "auto", darkTheme: "custom-deleted1", lightTheme: "custom-deleted2" });
  assert.deepEqual(resolveAppearance(settings, true), {
    themeId: "default",
    baseTheme: "default",
    scheme: "dark",
    cssVars: {},
  });
  assert.deepEqual(resolveAppearance(settings, false), {
    themeId: "default",
    baseTheme: "default",
    scheme: "light",
    cssVars: {},
  });
});

test("custom themes declare the scheme they were saved in", () => {
  const lightOcean: CustomTheme = { ...ocean, id: "custom-ocean02", scheme: "light", base: "rose-pine-dawn" };
  const settings = settingsWith({
    colorScheme: "auto",
    lightTheme: lightOcean.id,
    customThemes: [lightOcean],
  });
  const resolved = resolveAppearance(settings, false);
  assert.equal(resolved.baseTheme, "rose-pine-dawn");
  assert.equal(resolved.scheme, "light");
});

test("overrideCssVars derives the full accent family", () => {
  assert.deepEqual(overrideCssVars({ accent: "#38bdf8" }), {
    "--accent-primary": "#38bdf8",
    "--accent-glow": "rgba(56, 189, 248, 0.25)",
    "--border-selected": "rgba(56, 189, 248, 0.45)",
    "--bg-selected": "rgba(56, 189, 248, 0.16)",
  });
});

test("overrideCssVars derives surfaces from the background", () => {
  // Mixed toward the overridden text colour, not a hard-coded polarity.
  assert.deepEqual(overrideCssVars({ background: "#000000", text: "#ffffff" }), {
    "--surface-panel": "#000000",
    "--surface-hud": "#000000",
    "--bg-canvas": "#000000",
    "--popup-bg": "#000000",
    "--surface-card": "#0f0f0f",
    "--surface-card-hover": "#1a1a1a",
    "--bg-panel": "rgba(0, 0, 0, 0.97)",
    "--bg-hud": "rgba(0, 0, 0, 0.97)",
    "--text-primary": "#ffffff",
    "--kbd-text": "#ffffff",
  });
  // Without a text override a dark background mixes toward white and a light
  // one toward black.
  assert.equal(overrideCssVars({ background: "#000000" })["--surface-card"], "#0f0f0f");
  assert.equal(overrideCssVars({ background: "#ffffff" })["--surface-card"], "#f0f0f0");
});

test("overrideCssVars derives text, border and selected row tokens", () => {
  assert.deepEqual(overrideCssVars({ text: "#123456", textSecondary: "#654321" }), {
    "--text-primary": "#123456",
    "--kbd-text": "#123456",
    "--text-secondary": "#654321",
    "--text-muted": "#654321",
  });
  assert.deepEqual(overrideCssVars({ border: "#808080" }), {
    "--border-panel": "#808080",
    "--border-card": "rgba(128, 128, 128, 0.65)",
    "--divider": "rgba(128, 128, 128, 0.5)",
    "--kbd-border": "#808080",
  });
  assert.deepEqual(overrideCssVars({ selectedRow: "#123456", selectedRowText: "#abcdef" }), {
    "--row-selected-bg": "#123456",
    "--row-selected-fg": "#abcdef",
  });
});

test("overrideCssVars omits untouched tokens", () => {
  assert.deepEqual(overrideCssVars({}), {});
  assert.deepEqual(Object.keys(overrideCssVars({ accent: "#ffffff" })).sort(), [
    "--accent-glow",
    "--accent-primary",
    "--bg-selected",
    "--border-selected",
  ]);
});

test("mixHex interpolates hex colours", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#ff0000", "#00ff00", 0), "#ff0000");
  assert.equal(mixHex("#ff0000", "#00ff00", 1), "#00ff00");
});

test("contrastRatio matches WCAG reference values", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
  assert.equal(Math.round(contrastRatio("#777777", "#ffffff") * 100) / 100, 4.48);
  // A translucent foreground is composited over the background first.
  const translucent = contrastRatio("rgba(0, 0, 0, 0.5)", "#ffffff");
  assert.ok(Math.abs(translucent - contrastRatio("#808080", "#ffffff")) < 0.05, "translucent fg composites");
});
