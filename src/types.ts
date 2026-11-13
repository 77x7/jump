export type ColorTheme =
  | "default"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"
  | "rose-pine-dawn"
  | "rose-pine-main"
  | "rose-pine-moon"
  | "tokyo-night"
  | "nord"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "vesper";

export type ColorScheme = "light" | "dark";

/** Stored appearance preference: a fixed scheme or follow the OS. */
export type AppearanceScheme = ColorScheme | "auto";

export type ThemeToken =
  | "accent"
  | "background"
  | "text"
  | "textSecondary"
  | "border"
  | "selectedRow"
  | "selectedRowText";

export type ThemeColors = Partial<Record<ThemeToken, string>>;

export type ThemeId = ColorTheme | `custom-${string}`;

export type CustomTheme = {
  id: `custom-${string}`;
  name: string;
  base: ColorTheme;
  scheme: ColorScheme;
  colors: ThemeColors;
};

export type ThemeOverrides = Record<string, ThemeColors>;

export type ViewMode = "list" | "gallery";
export type TabSwitchMode = "recent" | "order";
export type PaletteViewMode = "collapsed" | "expanded";

export type PalettePosition = {
  x: number;
  y: number;
};

export type PinnedTab = {
  tabId: number;
  identity: string;
  url: string;
  title: string;
  hostname: string;
  faviconUrl?: string;
};

export type UserSettings = {
  viewMode: ViewMode;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  colorScheme: AppearanceScheme;
  themeOverrides: ThemeOverrides;
  customThemes: CustomTheme[];
  disableMouseTabSwitcher: boolean;
  disableMouseCommandPalette: boolean;
  disableMouseBookmarks: boolean;
  tabSwitchMode: TabSwitchMode;
  paletteViewMode: PaletteViewMode;
  paletteOpacity: number;
  paletteBlur: number;
  pinnedTabs: PinnedTab[];
  palettePosition: PalettePosition;
};

export type BookmarkItem = {
  id: string;
  title: string;
  url: string;
  folderPath: string[];
  dateAdded?: number;
  faviconUrl?: string;
};

export type PaletteTab = {
  id: number;
  windowId: number;
  title: string;
  url: string;
  hostname: string;
  index: number;
  faviconUrl?: string;
  active: boolean;
  windowFocused: boolean;
  pinned: boolean;
  audible: boolean;
  muted: boolean;
  lastAccessed?: number;
};

/**
 * The tab list with a version string. The background gives a new version only
 * when the list's content changed, so the palette can tell an unchanged list
 * by comparing one string instead of the whole list.
 */
export type TabList = { tabs: PaletteTab[]; version: string };

/** A tab screenshot; capturedAt identifies the capture. */
export type TabPreview = { dataUrl: string; capturedAt: number };

export type BrowserMessage =
  | { type: "get-tabs" }
  | { type: "get-tab-previews"; tabIds: number[] }
  | { type: "palette-opened" }
  | { type: "palette-closed" }
  | { type: "search-history"; query: string; maxResults?: number }
  | { type: "activate-tab"; tab: PaletteTab }
  | { type: "toggle-tab-muted"; tabId: number; muted: boolean }
  | { type: "open-url"; url: string; openerTabId?: number }
  | { type: "search-web"; query: string }
  | { type: "open-shortcut-settings" }
  | {
    type: "open-palette";
    mode?: "search" | "switcher" | "bookmarks";
    activeTabId?: number;
    /** Sent with the open so the first render already has the list and theme. */
    tabs?: PaletteTab[];
    /** Identifies `tabs`; equal versions mean an identical list (see TabList). */
    tabsVersion?: string;
    settings?: UserSettings;
    /** capturedAt of the background's preview of the active tab, if any. */
    activePreviewAt?: number;
  }
  | { type: "cycle-tab-switcher"; direction?: "next" | "prev" }
  | { type: "request-pin-selected-tab" }
  | { type: "request-mute-selected-tab" }
  | { type: "get-bookmarks" }
  | { type: "open-bookmark"; url: string }
  | { type: "set-tab-pinned"; tab: PinnedTab; pinned: boolean }
  | { type: "get-settings" }
  | { type: "save-settings"; settings: Partial<UserSettings> };


