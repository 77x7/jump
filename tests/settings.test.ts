import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, parseStoredSettings, themeForScheme } from "../src/settings.ts";
import { resolveSettingsRead } from "../src/popup/settingsState.ts";

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
      clear() {
        values.clear();
      },
    },
  });
  return values;
}

function installChromeStorage(
  get: () => Promise<Record<string, unknown>>,
  set: (settings: Record<string, unknown>) => Promise<void>,
) {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        sync: { get, set },
        onChanged: {
          addListener() {},
          removeListener() {},
        },
      },
    },
  });
}

test("opacity and blur parse and clamp into their ranges", () => {
  // Opacity is now a 0..1 background alpha; 0 means fully see-through.
  assert.equal(parseStoredSettings({ paletteOpacity: 0 }).paletteOpacity, 0);
  assert.equal(parseStoredSettings({ paletteOpacity: -1 }).paletteOpacity, 0);
  assert.equal(parseStoredSettings({ paletteOpacity: 0.4 }).paletteOpacity, 0.4);
  assert.equal(parseStoredSettings({ paletteOpacity: 0.65 }).paletteOpacity, 0.65);
  assert.equal(parseStoredSettings({ paletteOpacity: 2 }).paletteOpacity, 1);
  // Non-numbers fall back to the defaults instead of being coerced.
  assert.equal(parseStoredSettings({ paletteOpacity: "0.5" }).paletteOpacity, DEFAULT_SETTINGS.paletteOpacity);
  assert.equal(parseStoredSettings({ paletteOpacity: Number.NaN }).paletteOpacity, DEFAULT_SETTINGS.paletteOpacity);

  assert.equal(DEFAULT_SETTINGS.paletteBlur, 40);
  assert.equal(parseStoredSettings({}).paletteBlur, 40);
  assert.equal(parseStoredSettings({ paletteBlur: 0 }).paletteBlur, 0);
  assert.equal(parseStoredSettings({ paletteBlur: 16 }).paletteBlur, 16);
  assert.equal(parseStoredSettings({ paletteBlur: 41 }).paletteBlur, 40);
  assert.equal(parseStoredSettings({ paletteBlur: -8 }).paletteBlur, 0);
  assert.equal(parseStoredSettings({ paletteBlur: "16" }).paletteBlur, DEFAULT_SETTINGS.paletteBlur);
  assert.equal(parseStoredSettings({ paletteBlur: Number.NaN }).paletteBlur, DEFAULT_SETTINGS.paletteBlur);
});

test("a pending popup read does not replace a newer user selection", () => {
  const userSelection = { ...DEFAULT_SETTINGS, viewMode: "gallery" as const };
  const resolved = resolveSettingsRead(
    userSelection,
    DEFAULT_SETTINGS,
    0,
    1,
  );

  assert.equal(resolved.viewMode, "gallery");
});

test("persisted settings validate fields independently", () => {
  assert.deepEqual(
    parseStoredSettings({ viewMode: "unsupported", theme: "nord", extra: "ignored" }),
    { ...DEFAULT_SETTINGS, darkTheme: "nord" },
  );
  assert.deepEqual(
    parseStoredSettings({ viewMode: { value: "gallery" }, theme: "unknown" }),
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(
    parseStoredSettings({ paletteViewMode: "expanded", paletteOpacity: 0.65 }),
    { ...DEFAULT_SETTINGS, paletteViewMode: "expanded", paletteOpacity: 0.65 },
  );
  assert.deepEqual(
    parseStoredSettings({ paletteViewMode: "bad", paletteOpacity: 2 }),
    { ...DEFAULT_SETTINGS, paletteOpacity: 1 },
  );
  assert.deepEqual(
    parseStoredSettings({ useVibrancy: false, disableMouseTabSwitcher: true, disableMouseCommandPalette: "yes", pinnedTabs: [{ tabId: 12, url: "https://example.com" }, { tabId: 0, url: "bad" }] }),
    {
      ...DEFAULT_SETTINGS,
      disableMouseTabSwitcher: true,
      pinnedTabs: [{
        tabId: 12,
        identity: "https://example.com/",
        url: "https://example.com",
        title: "https://example.com",
        hostname: "example.com",
      }],
    },
  );
});

test("color scheme selects the light or dark variant of a theme", () => {
  assert.equal(themeForScheme("catppuccin-mocha", "light"), "catppuccin-latte");
  assert.equal(themeForScheme("catppuccin-latte", "dark"), "catppuccin-mocha");
  assert.equal(themeForScheme("rose-pine-moon", "light"), "rose-pine-dawn");
  assert.equal(themeForScheme("gruvbox-light", "dark"), "gruvbox-dark");
  assert.equal(themeForScheme("tokyo-night", "light"), "default");
});

test("migrates the single stored theme into light and dark slots", () => {
  // A dark preset fills the dark slot; its light counterpart fills the other.
  assert.deepEqual(parseStoredSettings({ theme: "nord" }), {
    ...DEFAULT_SETTINGS,
    lightTheme: "default",
    darkTheme: "nord",
  });
  assert.deepEqual(parseStoredSettings({ theme: "gruvbox-light" }), {
    ...DEFAULT_SETTINGS,
    lightTheme: "gruvbox-light",
    darkTheme: "gruvbox-dark",
    colorScheme: "light",
  });
  assert.deepEqual(parseStoredSettings({ theme: "catppuccin-mocha" }), {
    ...DEFAULT_SETTINGS,
    lightTheme: "catppuccin-latte",
    darkTheme: "catppuccin-mocha",
  });
  // An old stored colorScheme wins over the one inferred from the theme.
  assert.deepEqual(parseStoredSettings({ colorScheme: "light", theme: "catppuccin-macchiato" }), {
    ...DEFAULT_SETTINGS,
    colorScheme: "light",
    lightTheme: "catppuccin-latte",
    darkTheme: "catppuccin-macchiato",
  });
  // New-style slots are kept as-is, including custom ids.
  assert.deepEqual(parseStoredSettings({ lightTheme: "custom-abc123", darkTheme: "vesper", colorScheme: "auto" }), {
    ...DEFAULT_SETTINGS,
    lightTheme: "custom-abc123",
    darkTheme: "vesper",
    colorScheme: "auto",
  });
  // Unknown slots fall back to the defaults.
  assert.deepEqual(parseStoredSettings({ lightTheme: "nope", darkTheme: 42 }), DEFAULT_SETTINGS);
  // An invalid legacy theme is ignored.
  assert.deepEqual(parseStoredSettings({ theme: "unknown" }), DEFAULT_SETTINGS);
});

test("stored custom themes and overrides are validated", () => {
  const custom = {
    id: "custom-abc123",
    name: "Ocean",
    base: "nord" as const,
    scheme: "dark" as const,
    colors: { accent: "#22d3ee", text: "not-a-color", nope: "#ffffff" },
  };
  const parsed = parseStoredSettings({
    darkTheme: "custom-abc123",
    customThemes: [custom, { ...custom, id: "custom-abc123" }, { id: "bad", name: "x" }],
    themeOverrides: {
      "custom-abc123": { background: "#001122" },
      "not-a-theme": { background: "#ffffff" },
      nord: { accent: "blue" },
    },
  });
  assert.deepEqual(parsed.customThemes, [{
    id: "custom-abc123",
    name: "Ocean",
    base: "nord",
    scheme: "dark",
    colors: { accent: "#22d3ee" },
  }]);
  assert.deepEqual(parsed.themeOverrides, { "custom-abc123": { background: "#001122" } });
});

test("migrates legacy pinned tab IDs", () => {
  assert.deepEqual(parseStoredSettings({ pinnedTabIds: [12, "bad", 0] }), {
    ...DEFAULT_SETTINGS,
    pinnedTabs: [{ tabId: 12, identity: "", url: "", title: "Pinned tab", hostname: "" }],
  });
});

test("ignores invalid legacy pinned tab IDs", () => {
  assert.deepEqual(parseStoredSettings({ pinnedTabIds: "bad" }), DEFAULT_SETTINGS);
});

test("overlapping saves preserve both partial updates", async () => {
  installLocalStorage();
  let stored: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  let activeWrites = 0;
  let maximumActiveWrites = 0;

  installChromeStorage(
    async () => ({ ...stored }),
    async (settings) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = { ...stored, ...settings };
      activeWrites -= 1;
    },
  );

  const settings = await import(`../src/settings.ts?concurrent=${Date.now()}`);
  await Promise.all([
    settings.saveStoredSettings({ viewMode: "gallery" }),
    settings.saveStoredSettings({ darkTheme: "nord" }),
  ]);

  assert.deepEqual(stored, { ...DEFAULT_SETTINGS, viewMode: "gallery", darkTheme: "nord" });
  assert.equal(maximumActiveWrites, 1);
});

test("a failed sync write selects localStorage for later reads", async () => {
  const localValues = installLocalStorage();
  let syncReads = 0;

  installChromeStorage(
    async () => {
      syncReads += 1;
      return { ...DEFAULT_SETTINGS };
    },
    async () => {
      throw new Error("sync unavailable");
    },
  );

  const settings = await import(`../src/settings.ts?fallback=${Date.now()}`);
  await settings.saveStoredSettings({ viewMode: "gallery" });
  const loaded = await settings.getStoredSettings();

  assert.equal(loaded.viewMode, "gallery");
  assert.equal(syncReads, 1);
  assert.equal(
    JSON.parse(localValues.get("jump_settings") ?? "null").viewMode,
    "gallery",
  );
});

test("changing one theme slot keeps the other slot migrated from the legacy theme", () => {
  const settings = parseStoredSettings({ theme: "gruvbox-dark", colorScheme: "dark", lightTheme: "rose-pine-dawn" });
  assert.equal(settings.lightTheme, "rose-pine-dawn");
  assert.equal(settings.darkTheme, "gruvbox-dark");
});
