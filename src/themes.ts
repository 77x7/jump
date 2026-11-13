import type { ColorScheme, ColorTheme } from "./types";

export type ThemeInfo = {
  id: ColorTheme;
  name: string;
  badge: string;
  bg: string;
  accent: string;
  text: string;
};

export const THEMES: ThemeInfo[] = [
  {
    id: "default",
    name: "Mono",
    badge: "Adaptive",
    bg: "#08080a",
    accent: "#38bdf8",
    text: "#ffffff",
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin",
    badge: "Mocha",
    bg: "#1e1e2e",
    accent: "#cba6f7",
    text: "#cdd6f4",
  },
  {
    id: "rose-pine-main",
    name: "Rosé Pine",
    badge: "Main",
    bg: "#191724",
    accent: "#ebbcba",
    text: "#e0def4",
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin",
    badge: "Latte",
    bg: "#eff1f5",
    accent: "#8839ef",
    text: "#4c4f69",
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin",
    badge: "Frappé",
    bg: "#303446",
    accent: "#ca9ee6",
    text: "#c6d0f5",
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin",
    badge: "Macchiato",
    bg: "#24273a",
    accent: "#c6a0f6",
    text: "#cad3f5",
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine",
    badge: "Dawn",
    bg: "#faf4ed",
    accent: "#d7827e",
    text: "#575279",
  },
  {
    id: "rose-pine-moon",
    name: "Rosé Pine",
    badge: "Moon",
    bg: "#232136",
    accent: "#ea9a97",
    text: "#e0def4",
  },
  {
    id: "vesper",
    name: "Vesper",
    badge: "Peppermint",
    bg: "#101010",
    accent: "#ffc799",
    text: "#ffffff",
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox",
    badge: "Light",
    bg: "#fbf1c7",
    accent: "#af3a03",
    text: "#3c3836",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    badge: "Night",
    bg: "#1a1b26",
    accent: "#7aa2f7",
    text: "#c0caf5",
  },
  {
    id: "nord",
    name: "Nord",
    badge: "Arctic",
    bg: "#2e3440",
    accent: "#88c0d0",
    text: "#eceff4",
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox",
    badge: "Dark",
    bg: "#282828",
    accent: "#fe8019",
    text: "#ebdbb2",
  },
];

export const COLOR_THEMES: ColorTheme[] = THEMES.map((theme) => theme.id);

export function isColorTheme(value: unknown): value is ColorTheme {
  return typeof value === "string" && (COLOR_THEMES as string[]).includes(value);
}

export function parseColorTheme(value: unknown): ColorTheme {
  if (isColorTheme(value)) return value;
  if (value === "catppuccin") return "catppuccin-mocha";
  if (value === "rose-pine") return "rose-pine-main";
  if (value === "gruvbox") return "gruvbox-dark";
  return "default";
}

export const LIGHT_THEMES = new Set<ColorTheme>(["catppuccin-latte", "rose-pine-dawn", "gruvbox-light"]);

export const LIGHT_VARIANT: Record<ColorTheme, ColorTheme> = {
  default: "default",
  "catppuccin-mocha": "catppuccin-latte",
  "catppuccin-frappe": "catppuccin-latte",
  "catppuccin-macchiato": "catppuccin-latte",
  "catppuccin-latte": "catppuccin-latte",
  "rose-pine-main": "rose-pine-dawn",
  "rose-pine-moon": "rose-pine-dawn",
  "rose-pine-dawn": "rose-pine-dawn",
  "gruvbox-dark": "gruvbox-light",
  "gruvbox-light": "gruvbox-light",
  "tokyo-night": "default",
  nord: "default",
  vesper: "default",
};

export const DARK_VARIANT: Record<ColorTheme, ColorTheme> = {
  default: "default",
  "catppuccin-latte": "catppuccin-mocha",
  "catppuccin-mocha": "catppuccin-mocha",
  "catppuccin-frappe": "catppuccin-frappe",
  "catppuccin-macchiato": "catppuccin-macchiato",
  "rose-pine-dawn": "rose-pine-main",
  "rose-pine-main": "rose-pine-main",
  "rose-pine-moon": "rose-pine-moon",
  "gruvbox-light": "gruvbox-dark",
  "gruvbox-dark": "gruvbox-dark",
  "tokyo-night": "tokyo-night",
  nord: "nord",
  vesper: "vesper",
};

export function themeForScheme(theme: ColorTheme, scheme: ColorScheme): ColorTheme {
  return scheme === "light" ? LIGHT_VARIANT[theme] : DARK_VARIANT[theme];
}

export function themesForScheme(scheme: ColorScheme): ThemeInfo[] {
  return THEMES.filter((theme) => theme.id === "default" || (scheme === "light" ? LIGHT_THEMES.has(theme.id) : !LIGHT_THEMES.has(theme.id)));
}

export function themeInfo(id: ColorTheme): ThemeInfo {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
