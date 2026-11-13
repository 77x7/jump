import type { AppearanceScheme, ColorScheme, ColorTheme, CustomTheme, PalettePosition, PaletteViewMode, PinnedTab, TabSwitchMode, ThemeId, ThemeOverrides, UserSettings, ViewMode } from "./types";
import { DARK_VARIANT, LIGHT_THEMES, LIGHT_VARIANT, isColorTheme, parseColorTheme } from "./themes.ts";
import { isThemeId, parseCustomThemes, parseThemeOverrides } from "./themeLibrary.ts";

export { THEMES, themeForScheme, themesForScheme, type ThemeInfo } from "./themes.ts";

export const DEFAULT_SETTINGS: UserSettings = {
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
  paletteViewMode: "collapsed",
  paletteOpacity: 0.84,
  paletteBlur: 40,
  pinnedTabs: [],
  palettePosition: { x: 0.5, y: 0.28 },
};

const LOCAL_SETTINGS_KEY = "jump_settings";
type SettingsBackend = "sync" | "local" | "localStorage";

let selectedBackend: SettingsBackend | undefined;
let saveQueue = Promise.resolve<UserSettings>(DEFAULT_SETTINGS);
const subscribers = new Set<(settings: UserSettings) => void>();

function isViewMode(value: unknown): value is ViewMode {
  return value === "list" || value === "gallery";
}

function isAppearanceScheme(value: unknown): value is AppearanceScheme {
  return value === "light" || value === "dark" || value === "auto";
}

/** Stored theme slots accept presets and saved custom themes. */
function parseThemeId(value: unknown, fallback: ThemeId): ThemeId {
  return isThemeId(value) ? value : fallback;
}

function inferredColorScheme(theme: ColorTheme): ColorScheme {
  return LIGHT_THEMES.has(theme) ? "light" : "dark";
}

type ThemeSlots = { lightTheme: ThemeId; darkTheme: ThemeId };

/**
 * Migration from the single `theme` setting: a light preset becomes the light
 * slot (its dark counterpart fills the other), anything else becomes the dark
 * slot (its light counterpart fills the other).
 */
function migrateThemeSlots(value: Record<string, unknown>): ThemeSlots {
  // A slot that was never written (sync storage saves only changed keys) still
  // comes from the legacy `theme`, so changing one slot keeps the other.
  const legacy = legacyThemeSlots(value);
  return {
    lightTheme: "lightTheme" in value ? parseThemeId(value.lightTheme, legacy.lightTheme) : legacy.lightTheme,
    darkTheme: "darkTheme" in value ? parseThemeId(value.darkTheme, legacy.darkTheme) : legacy.darkTheme,
  };
}

function legacyThemeSlots(value: Record<string, unknown>): ThemeSlots {
  if (!("theme" in value)) {
    return { lightTheme: DEFAULT_SETTINGS.lightTheme, darkTheme: DEFAULT_SETTINGS.darkTheme };
  }
  const stored = parseColorTheme(value.theme);
  if (stored === "default" && value.theme !== "default") {
    return { lightTheme: DEFAULT_SETTINGS.lightTheme, darkTheme: DEFAULT_SETTINGS.darkTheme };
  }
  return LIGHT_THEMES.has(stored)
    ? { lightTheme: stored, darkTheme: DARK_VARIANT[stored] }
    : { lightTheme: LIGHT_VARIANT[stored], darkTheme: stored };
}

function isTabSwitchMode(value: unknown): value is TabSwitchMode {
  return value === "recent" || value === "order";
}

function isPaletteViewMode(value: unknown): value is PaletteViewMode {
  return value === "collapsed" || value === "expanded";
}

export const MAX_PALETTE_BLUR = 40;

function parsePaletteOpacity(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_SETTINGS.paletteOpacity;
}

function parsePaletteBlur(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_PALETTE_BLUR, Math.max(0, value))
    : DEFAULT_SETTINGS.paletteBlur;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function parsePalettePosition(value: unknown): PalettePosition {
  if (typeof value !== "object" || value === null || !("x" in value) || !("y" in value)) {
    return DEFAULT_SETTINGS.palettePosition;
  }
  const { x, y } = value;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    : DEFAULT_SETTINGS.palettePosition;
}

function parsePinnedTabs(value: unknown): PinnedTab[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tab): PinnedTab[] => {
    if (typeof tab !== "object" || tab === null ||
      !("tabId" in tab) || typeof tab.tabId !== "number" || !Number.isInteger(tab.tabId) || tab.tabId <= 0) {
      return [];
    }
    const url = "url" in tab && typeof tab.url === "string" ? tab.url : "";
    const identity = "identity" in tab && typeof tab.identity === "string" ? tab.identity : pinnedTabIdentity(url);
    if (!identity) return [];
    return [{
      tabId: tab.tabId,
      identity,
      url: url || identity,
      title: "title" in tab && typeof tab.title === "string" ? tab.title : url || identity,
      hostname: "hostname" in tab && typeof tab.hostname === "string" ? tab.hostname : hostnameForPinnedTab(url || identity),
      ...( "faviconUrl" in tab && typeof tab.faviconUrl === "string" ? { faviconUrl: tab.faviconUrl } : {}),
    }];
  });
}

function hostnameForPinnedTab(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function pinnedTabIdentity(url: string) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function parseLegacyPinnedTabs(value: unknown): PinnedTab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tabId): tabId is number => typeof tabId === "number" && Number.isInteger(tabId) && tabId > 0)
    .map((tabId) => ({ tabId, identity: "", url: "", title: "Pinned tab", hostname: "" }));
}

export function parseStoredSettings(value: unknown): UserSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
  const record = value as Record<string, unknown>;
  const viewMode = "viewMode" in value && isViewMode(value.viewMode) ? value.viewMode : DEFAULT_SETTINGS.viewMode;
  const { lightTheme, darkTheme } = migrateThemeSlots(record);
  const colorScheme = "colorScheme" in value && isAppearanceScheme(value.colorScheme)
    ? value.colorScheme
    : "theme" in value
      ? inferredColorScheme(parseColorTheme(record.theme))
      : DEFAULT_SETTINGS.colorScheme;
  const themeOverrides: ThemeOverrides = "themeOverrides" in value
    ? parseThemeOverrides(value.themeOverrides)
    : DEFAULT_SETTINGS.themeOverrides;
  const customThemes: CustomTheme[] = "customThemes" in value
    ? parseCustomThemes(value.customThemes)
    : DEFAULT_SETTINGS.customThemes;
  const disableMouseTabSwitcher = "disableMouseTabSwitcher" in value && isBoolean(value.disableMouseTabSwitcher)
    ? value.disableMouseTabSwitcher
    : DEFAULT_SETTINGS.disableMouseTabSwitcher;
  const disableMouseCommandPalette = "disableMouseCommandPalette" in value && isBoolean(value.disableMouseCommandPalette)
    ? value.disableMouseCommandPalette
    : DEFAULT_SETTINGS.disableMouseCommandPalette;
  const disableMouseBookmarks = "disableMouseBookmarks" in value && isBoolean(value.disableMouseBookmarks)
    ? value.disableMouseBookmarks
    : DEFAULT_SETTINGS.disableMouseBookmarks;
  const tabSwitchMode = "tabSwitchMode" in value && isTabSwitchMode(value.tabSwitchMode)
    ? value.tabSwitchMode
    : DEFAULT_SETTINGS.tabSwitchMode;
  const paletteViewMode = "paletteViewMode" in value && isPaletteViewMode(value.paletteViewMode)
    ? value.paletteViewMode
    : DEFAULT_SETTINGS.paletteViewMode;
  const paletteOpacity = "paletteOpacity" in value
    ? parsePaletteOpacity(value.paletteOpacity)
    : DEFAULT_SETTINGS.paletteOpacity;
  const paletteBlur = "paletteBlur" in value
    ? parsePaletteBlur(value.paletteBlur)
    : DEFAULT_SETTINGS.paletteBlur;
  const pinnedTabs = "pinnedTabs" in value
    ? parsePinnedTabs(value.pinnedTabs)
    : "pinnedTabIds" in value
      ? parseLegacyPinnedTabs(value.pinnedTabIds)
      : DEFAULT_SETTINGS.pinnedTabs;
  const palettePosition = "palettePosition" in value ? parsePalettePosition(value.palettePosition) : DEFAULT_SETTINGS.palettePosition;
  return { viewMode, lightTheme, darkTheme, colorScheme, themeOverrides, customThemes, disableMouseTabSwitcher, disableMouseCommandPalette, disableMouseBookmarks, tabSwitchMode, paletteViewMode, paletteOpacity, paletteBlur, pinnedTabs, palettePosition };
}

function parseSettingsUpdate(value: unknown): Partial<UserSettings> {
  if (typeof value !== "object" || value === null) return {};
  return {
    ...( "viewMode" in value && isViewMode(value.viewMode) ? { viewMode: value.viewMode } : {}),
    ...( "lightTheme" in value && isThemeId(value.lightTheme) ? { lightTheme: value.lightTheme } : {}),
    ...( "darkTheme" in value && isThemeId(value.darkTheme) ? { darkTheme: value.darkTheme } : {}),
    ...( "colorScheme" in value && isAppearanceScheme(value.colorScheme) ? { colorScheme: value.colorScheme } : {}),
    ...( "themeOverrides" in value ? { themeOverrides: parseThemeOverrides(value.themeOverrides) } : {}),
    ...( "customThemes" in value ? { customThemes: parseCustomThemes(value.customThemes) } : {}),
    ...( "disableMouseTabSwitcher" in value && isBoolean(value.disableMouseTabSwitcher)
      ? { disableMouseTabSwitcher: value.disableMouseTabSwitcher }
      : {}),
    ...( "disableMouseCommandPalette" in value && isBoolean(value.disableMouseCommandPalette)
      ? { disableMouseCommandPalette: value.disableMouseCommandPalette }
      : {}),
    ...( "disableMouseBookmarks" in value && isBoolean(value.disableMouseBookmarks)
      ? { disableMouseBookmarks: value.disableMouseBookmarks }
      : {}),
    ...( "tabSwitchMode" in value && isTabSwitchMode(value.tabSwitchMode)
      ? { tabSwitchMode: value.tabSwitchMode }
      : {}),
    ...( "paletteViewMode" in value && isPaletteViewMode(value.paletteViewMode)
      ? { paletteViewMode: value.paletteViewMode }
      : {}),
    ...( "paletteOpacity" in value && typeof value.paletteOpacity === "number" && Number.isFinite(value.paletteOpacity)
      ? { paletteOpacity: parsePaletteOpacity(value.paletteOpacity) }
      : {}),
    ...( "paletteBlur" in value && typeof value.paletteBlur === "number" && Number.isFinite(value.paletteBlur)
      ? { paletteBlur: parsePaletteBlur(value.paletteBlur) }
      : {}),
    ...( "pinnedTabs" in value ? { pinnedTabs: parsePinnedTabs(value.pinnedTabs) } : {}),
    ...( "pinnedTabIds" in value && Array.isArray(value.pinnedTabIds)
      ? { pinnedTabs: parseLegacyPinnedTabs(value.pinnedTabIds) }
      : {}),
    ...( "palettePosition" in value ? { palettePosition: parsePalettePosition(value.palettePosition) } : {}),
  };
}

function canUseSyncStorage() {
  return typeof chrome !== "undefined" && chrome.storage?.sync !== undefined;
}

function canUseChromeLocalStorage() {
  return typeof chrome !== "undefined" && chrome.storage?.local !== undefined;
}

function readLocalSettings() {
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
    return raw === null ? DEFAULT_SETTINGS : parseStoredSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeLocalSettings(settings: UserSettings) {
  try {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Keep the in-memory result available to the current caller.
  }
}

async function readChromeLocalSettings() {
  if (!canUseChromeLocalStorage()) throw new Error("Local extension storage is unavailable");
  const stored: unknown = await chrome.storage.local.get([
    "viewMode",
    "theme",
    "lightTheme",
    "darkTheme",
    "colorScheme",
    "themeOverrides",
    "customThemes",
    "disableMouseTabSwitcher",
    "disableMouseCommandPalette",
    "disableMouseBookmarks",
    "tabSwitchMode",
    "paletteViewMode",
    "paletteOpacity",
    "paletteBlur",
    "pinnedTabs",
    "pinnedTabIds",
    "palettePosition",
  ]);
  return parseStoredSettings(stored);
}

async function writeChromeLocalSettings(settings: UserSettings) {
  if (!canUseChromeLocalStorage()) throw new Error("Local extension storage is unavailable");
  await chrome.storage.local.set(settings);
}

function notifySubscribers(settings: UserSettings) {
  subscribers.forEach((callback) => callback(settings));
}

export async function getStoredSettings(): Promise<UserSettings> {
  if (selectedBackend === "local") return readChromeLocalSettings();
  if (selectedBackend === "localStorage") return readLocalSettings();

  if (canUseSyncStorage()) {
    try {
      const settings = parseStoredSettings(await chrome.storage.sync.get([
        "viewMode",
        "theme",
        "lightTheme",
        "darkTheme",
        "colorScheme",
        "themeOverrides",
        "customThemes",
        "disableMouseTabSwitcher",
        "disableMouseCommandPalette",
        "disableMouseBookmarks",
        "tabSwitchMode",
        "paletteViewMode",
        "paletteOpacity",
        "paletteBlur",
        "pinnedTabs",
        "pinnedTabIds",
        "palettePosition",
      ]));
      selectedBackend = "sync";
      return settings;
    } catch {
      if (canUseChromeLocalStorage()) {
        selectedBackend = "local";
        return readChromeLocalSettings();
      }
      selectedBackend = "localStorage";
    }
  } else if (canUseChromeLocalStorage()) {
    selectedBackend = "local";
    return readChromeLocalSettings();
  } else {
    selectedBackend = "localStorage";
  }

  return readLocalSettings();
}

async function saveSettings(partial: Partial<UserSettings>) {
  const current = await getStoredSettings();
  const update = parseSettingsUpdate(partial);
  const next: UserSettings = { ...current, ...update };

  if (selectedBackend === "sync" && canUseSyncStorage()) {
    try {
      await chrome.storage.sync.set(update);
      return next;
    } catch {
      selectedBackend = canUseChromeLocalStorage() ? "local" : "localStorage";
    }
  }

  if (selectedBackend === "local") {
    try {
      await writeChromeLocalSettings(next);
    } catch {
      selectedBackend = "localStorage";
      writeLocalSettings(next);
    }
  } else {
    writeLocalSettings(next);
  }
  notifySubscribers(next);
  return next;
}

export function saveStoredSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
  const pendingSave = saveQueue.then(() => saveSettings(partial), () => saveSettings(partial));
  saveQueue = pendingSave;
  return pendingSave;
}

export function subscribeToSettings(callback: (settings: UserSettings) => void) {
  subscribers.add(callback);
  const storageListener = (_changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName !== "sync" && areaName !== "local") return;
    if (areaName === "sync" && selectedBackend !== "sync") return;
    if (areaName === "local" && selectedBackend !== "local") return;
    void getStoredSettings().then(callback);
  };
  const localStorageListener = (event: StorageEvent) => {
    if (selectedBackend !== "localStorage" || (event.key !== null && event.key !== LOCAL_SETTINGS_KEY)) return;
    callback(readLocalSettings());
  };

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.addListener(storageListener);
  if (typeof window !== "undefined") window.addEventListener("storage", localStorageListener);

  return () => {
    subscribers.delete(callback);
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.removeListener(storageListener);
    if (typeof window !== "undefined") window.removeEventListener("storage", localStorageListener);
  };
}
