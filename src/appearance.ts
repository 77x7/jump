import { useEffect, useMemo, useState } from "react";
import { isColorTheme, LIGHT_VARIANT } from "./themes.ts";
import type { ColorScheme, ColorTheme, CustomTheme, ThemeColors, ThemeId, ThemeToken, UserSettings } from "./types";
import { isCustomThemeId } from "./themeLibrary.ts";

export type ResolvedAppearance = {
  themeId: ThemeId;
  baseTheme: ColorTheme;
  scheme: ColorScheme;
  cssVars: Record<string, string>;
};

/** CSS variable used to preview each editable token in the settings UI. */
export const TOKEN_PREVIEW_VAR: Record<ThemeToken, string> = {
  accent: "--accent-primary",
  background: "--surface-panel",
  text: "--text-primary",
  textSecondary: "--text-secondary",
  border: "--border-panel",
  selectedRow: "--row-selected-bg",
  selectedRowText: "--row-selected-fg",
};

type Rgb = { r: number; g: number; b: number; a: number };

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseColor(value: string): Rgb | null {
  const hex = value.trim();
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (shortHex) {
    return {
      r: parseInt(shortHex[1] + shortHex[1], 16),
      g: parseInt(shortHex[2] + shortHex[2], 16),
      b: parseInt(shortHex[3] + shortHex[3], 16),
      a: 1,
    };
  }
  const longHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (longHex) {
    return { r: parseInt(longHex[1], 16), g: parseInt(longHex[2], 16), b: parseInt(longHex[3], 16), a: 1 };
  }
  // Chrome serialises translucent custom properties as #rrggbbaa.
  const alphaHex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (alphaHex) {
    return {
      r: parseInt(alphaHex[1], 16),
      g: parseInt(alphaHex[2], 16),
      b: parseInt(alphaHex[3], 16),
      a: parseInt(alphaHex[4], 16) / 255,
    };
  }
  const shortAlphaHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (shortAlphaHex) {
    return {
      r: parseInt(shortAlphaHex[1] + shortAlphaHex[1], 16),
      g: parseInt(shortAlphaHex[2] + shortAlphaHex[2], 16),
      b: parseInt(shortAlphaHex[3] + shortAlphaHex[3], 16),
      a: parseInt(shortAlphaHex[4] + shortAlphaHex[4], 16) / 255,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(hex);
  if (!rgb) return null;
  const alphaRaw = rgb[4];
  const alpha = alphaRaw === undefined
    ? 1
    : alphaRaw.endsWith("%")
      ? Number.parseFloat(alphaRaw) / 100
      : Number.parseFloat(alphaRaw);
  return {
    r: Number.parseFloat(rgb[1]),
    g: Number.parseFloat(rgb[2]),
    b: Number.parseFloat(rgb[3]),
    a: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
  };
}

function toHex({ r, g, b }: { r: number; g: number; b: number }) {
  return `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const color = parseColor(hex);
  if (!color) return hex;
  return `rgba(${clampChannel(color.r)}, ${clampChannel(color.g)}, ${clampChannel(color.b)}, ${alpha})`;
}

/** Mixes `amount` (0..1) of `target` into `from`, both `#rrggbb`. */
export function mixHex(from: string, target: string, amount: number): string {
  const a = parseColor(from);
  const b = parseColor(target);
  if (!a || !b) return from;
  const t = Math.max(0, Math.min(1, amount));
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

export function relativeLuminance(color: string | Rgb): number {
  const rgb = typeof color === "string" ? parseColor(color) : color;
  if (!rgb) return 0;
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function flatten(color: Rgb, background: Rgb): Rgb {
  if (color.a >= 1) return color;
  return {
    r: color.r * color.a + background.r * (1 - color.a),
    g: color.g * color.a + background.g * (1 - color.a),
    b: color.b * color.a + background.b * (1 - color.a),
    a: 1,
  };
}

/**
 * WCAG 2 contrast ratio. Translucent inputs are composited: the foreground
 * over the background, and a translucent background over white.
 */
export function contrastRatio(foreground: string, background: string): number {
  const white: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  if (!fg || !bg) return 1;
  const solidBg = flatten(bg, white);
  const solidFg = flatten(fg, solidBg);
  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(solidBg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function isDarkColor(color: string): boolean {
  return relativeLuminance(color) < 0.4;
}

/**
 * Derives the CSS custom properties for the seven editable tokens. Tokens that
 * are absent from `overrides` are not emitted, so the theme block keeps
 * providing them.
 */
export function overrideCssVars(overrides: ThemeColors): Record<string, string> {
  const vars: Record<string, string> = {};
  const { accent, background, text, textSecondary, border, selectedRow, selectedRowText } = overrides;

  if (accent) {
    vars["--accent-primary"] = accent;
    vars["--accent-glow"] = hexToRgba(accent, 0.25);
    vars["--border-selected"] = hexToRgba(accent, 0.45);
    vars["--bg-selected"] = hexToRgba(accent, 0.16);
  }
  if (background) {
    const cardTarget = text ?? (isDarkColor(background) ? "#ffffff" : "#000000");
    const card = mixHex(background, cardTarget, 0.06);
    const cardHover = mixHex(background, cardTarget, 0.1);
    vars["--surface-panel"] = background;
    vars["--surface-hud"] = background;
    vars["--bg-canvas"] = background;
    vars["--popup-bg"] = background;
    vars["--surface-card"] = card;
    vars["--surface-card-hover"] = cardHover;
    vars["--bg-panel"] = hexToRgba(background, 0.97);
    vars["--bg-hud"] = hexToRgba(background, 0.97);
  }
  if (text) {
    vars["--text-primary"] = text;
    vars["--kbd-text"] = text;
  }
  if (textSecondary) {
    vars["--text-secondary"] = textSecondary;
    vars["--text-muted"] = textSecondary;
  }
  if (border) {
    vars["--border-panel"] = border;
    vars["--border-card"] = hexToRgba(border, 0.65);
    vars["--divider"] = hexToRgba(border, 0.5);
    vars["--kbd-border"] = border;
  }
  if (selectedRow) vars["--row-selected-bg"] = selectedRow;
  if (selectedRowText) vars["--row-selected-fg"] = selectedRowText;
  return vars;
}

function findCustomTheme(customThemes: CustomTheme[], id: ThemeId | string) {
  return customThemes.find((theme) => theme.id === id);
}

/**
 * Resolves the stored preference (+ OS preference for Auto) into the theme to
 * render, the preset whose CSS block supplies the base palette, and the inline
 * CSS variables for per-theme overrides.
 */
export function resolveAppearance(settings: UserSettings, systemPrefersDark: boolean): ResolvedAppearance {
  const scheme: ColorScheme = settings.colorScheme === "auto"
    ? systemPrefersDark ? "dark" : "light"
    : settings.colorScheme;
  const storedTheme = scheme === "dark" ? settings.darkTheme : settings.lightTheme;
  const custom = isCustomThemeId(storedTheme) ? findCustomTheme(settings.customThemes, storedTheme) : undefined;

  if (custom) {
    const overrides = settings.themeOverrides[custom.id] ?? {};
    return {
      themeId: custom.id,
      baseTheme: custom.base,
      scheme: custom.scheme,
      cssVars: overrideCssVars({ ...custom.colors, ...overrides }),
    };
  }

  // A deleted custom theme (or a broken stored value) falls back to the preset
  // that matches the active scheme.
  const preset: ColorTheme = isColorTheme(storedTheme)
    ? storedTheme
    : scheme === "light" ? LIGHT_VARIANT.default : "default";
  return {
    themeId: preset,
    baseTheme: preset,
    scheme,
    cssVars: overrideCssVars(settings.themeOverrides[preset] ?? {}),
  };
}

/** Effective colours of the active theme, for the settings UI. */
export function resolvedThemeColors(customThemes: CustomTheme[], themeOverrides: Record<string, ThemeColors>, themeId: ThemeId): ThemeColors {
  const custom = isCustomThemeId(themeId) ? findCustomTheme(customThemes, themeId) : undefined;
  return { ...(custom?.colors ?? {}), ...(themeOverrides[themeId] ?? {}) };
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function useResolvedAppearance(settings: UserSettings): ResolvedAppearance {
  const [systemPrefersDark, setSystemPrefersDark] = useState(prefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return useMemo(() => resolveAppearance(settings, systemPrefersDark), [settings, systemPrefersDark]);
}

/** Flattens a token colour (possibly translucent) over a background to `#rrggbb`. */
export function resolveColorToken(foreground: string, background: string): string {
  const fg = parseColor(foreground);
  if (!fg) return "#000000";
  const bg = parseColor(background);
  if (bg) return toHex(flatten(fg, bg));
  return toHex(fg);
}
