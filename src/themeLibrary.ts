import { isColorTheme } from "./themes.ts";
import type { ColorScheme, ColorTheme, CustomTheme, ThemeColors, ThemeId, ThemeOverrides, ThemeToken } from "./types";

/** The seven user-editable colour tokens, in UI order. */
export const THEME_TOKENS: ThemeToken[] = [
  "accent",
  "background",
  "text",
  "textSecondary",
  "border",
  "selectedRow",
  "selectedRowText",
];

/**
 * chrome.storage.sync allows 8 KB per item. Ten themes of seven short hex
 * colours plus name/base/id stay well inside that budget.
 */
export const MAX_CUSTOM_THEMES = 10;
export const MAX_THEME_NAME_LENGTH = 40;
export const THEMES_EXPORT_VERSION = 1;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CUSTOM_ID = /^custom-[a-z0-9]{1,24}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export function normalizeHex(value: string) {
  return value.toLowerCase();
}

export function isThemeToken(value: unknown): value is ThemeToken {
  return typeof value === "string" && (THEME_TOKENS as string[]).includes(value);
}

export function isThemeId(value: unknown): value is ThemeId {
  return isColorTheme(value) || (typeof value === "string" && CUSTOM_ID.test(value));
}

/** Keep only known tokens with valid `#rrggbb` values. */
export function parseThemeColors(value: unknown): ThemeColors {
  if (typeof value !== "object" || value === null) return {};
  const colors: ThemeColors = {};
  for (const token of THEME_TOKENS) {
    if (!(token in value)) continue;
    const color = (value as Record<string, unknown>)[token];
    if (isHexColor(color)) colors[token] = normalizeHex(color);
  }
  return colors;
}

export function cleanThemeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_THEME_NAME_LENGTH).trim();
  return name.length > 0 ? name : null;
}

function isColorScheme(value: unknown): value is ColorScheme {
  return value === "light" || value === "dark";
}

export function newCustomThemeId(taken: Iterable<string>): `custom-${string}` {
  const used = new Set(taken);
  for (;;) {
    const id = `custom-${Math.random().toString(36).slice(2, 10)}` as `custom-${string}`;
    if (!used.has(id)) return id;
  }
}

export function parseCustomTheme(value: unknown): CustomTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const name = cleanThemeName("name" in value ? value.name : null);
  const base = "base" in value ? value.base : null;
  const scheme = "scheme" in value ? value.scheme : null;
  const id = "id" in value && isThemeId(value.id) && typeof value.id === "string" && value.id.startsWith("custom-")
    ? (value.id as `custom-${string}`)
    : null;
  if (!name || !isColorTheme(base) || !isColorScheme(scheme) || !id) return null;
  return {
    id,
    name,
    base,
    scheme,
    colors: parseThemeColors("colors" in value ? value.colors : null),
  };
}

/** Validates a stored theme array: invalid entries are dropped, ids deduped, cap enforced. */
export function parseCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomTheme[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const theme = parseCustomTheme(entry);
    if (!theme) continue;
    if (ids.has(theme.id)) continue;
    ids.add(theme.id);
    themes.push(theme);
    if (themes.length >= MAX_CUSTOM_THEMES) break;
  }
  return themes;
}

export function parseThemeOverrides(value: unknown): ThemeOverrides {
  if (typeof value !== "object" || value === null) return {};
  const overrides: ThemeOverrides = {};
  for (const [id, colors] of Object.entries(value)) {
    if (!isThemeId(id)) continue;
    const parsed = parseThemeColors(colors);
    if (Object.keys(parsed).length > 0) overrides[id] = parsed;
  }
  return overrides;
}

export type ThemesFile = {
  version: typeof THEMES_EXPORT_VERSION;
  customThemes: CustomTheme[];
  themeOverrides: ThemeOverrides;
};

export function buildThemesFile(customThemes: CustomTheme[], themeOverrides: ThemeOverrides): ThemesFile {
  return {
    version: THEMES_EXPORT_VERSION,
    customThemes: customThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      base: theme.base,
      scheme: theme.scheme,
      colors: { ...theme.colors },
    })),
    themeOverrides: Object.fromEntries(
      Object.entries(themeOverrides).map(([id, colors]) => [id, { ...colors }]),
    ),
  };
}

export type ImportResult = {
  customThemes: CustomTheme[];
  themeOverrides: ThemeOverrides;
  importedCount: number;
};

/**
 * Strict import: `#rrggbb` colours only, names trimmed and capped, unknown keys
 * dropped, colliding ids regenerated, at most MAX_CUSTOM_THEMES themes merged.
 * Throws an Error with a user-facing message for unusable input.
 */
export function importThemes(text: string, existing: { customThemes: CustomTheme[]; themeOverrides: ThemeOverrides }): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("That file does not contain a Jump theme export.");
  }
  const record = parsed as Record<string, unknown>;
  if ("version" in record && record.version !== THEMES_EXPORT_VERSION) {
    throw new Error(`Unsupported theme file version: ${String(record.version)}.`);
  }
  const rawThemes = "customThemes" in record ? record.customThemes : [];
  if (!Array.isArray(rawThemes)) throw new Error("That file has an invalid customThemes list.");

  const customThemes = [...existing.customThemes];
  const themeOverrides: ThemeOverrides = { ...existing.themeOverrides };
  const takenIds = customThemes.map((theme) => theme.id);
  const idRemap = new Map<string, string>();
  let importedCount = 0;
  let importedOverrideCount = 0;

  for (const entry of rawThemes) {
    if (customThemes.length >= MAX_CUSTOM_THEMES) break;
    const candidate: unknown = typeof entry === "object" && entry !== null
      ? { id: newCustomThemeId(takenIds), ...entry }
      : entry;
    if (typeof candidate === "object" && candidate !== null && !("id" in candidate && typeof candidate.id === "string" && isCustomThemeId(candidate.id))) {
      (candidate as { id: string }).id = newCustomThemeId(takenIds);
    }
    const theme = parseCustomTheme(candidate);
    if (!theme) continue;
    let id = theme.id;
    if (takenIds.includes(id)) id = newCustomThemeId(takenIds);
    if (id !== theme.id) idRemap.set(theme.id, id);
    takenIds.push(id);
    customThemes.push({ ...theme, id });
    importedCount += 1;
  }

  if ("themeOverrides" in record) {
    const importedOverrides = parseThemeOverrides(record.themeOverrides);
    for (const [id, colors] of Object.entries(importedOverrides)) {
      const target = idRemap.get(id) ?? id;
      themeOverrides[target] = { ...themeOverrides[target], ...colors };
      importedOverrideCount += 1;
    }
  }

  if (importedCount === 0 && importedOverrideCount === 0) {
    throw new Error("That file contained no usable themes.");
  }

  return { customThemes, themeOverrides, importedCount };
}

export function isCustomThemeId(id: string): id is `custom-${string}` {
  return CUSTOM_ID.test(id);
}
