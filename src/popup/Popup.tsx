import { useLayoutEffect, useRef, useState } from "react";
import { openShortcutSettings } from "../browser";
import { CommandIcon, ArrowUpRightIcon, InfoIcon } from "../icons";
import { DEFAULT_SETTINGS, MAX_PALETTE_BLUR, getStoredSettings, saveStoredSettings, themesForScheme } from "../settings";
import { THEMES } from "../themes";
import { THEME_TOKENS, buildThemesFile, cleanThemeName, importThemes, isCustomThemeId, MAX_CUSTOM_THEMES, newCustomThemeId } from "../themeLibrary";
import {
  TOKEN_PREVIEW_VAR,
  contrastRatio,
  resolveColorToken,
  resolvedThemeColors,
  useResolvedAppearance,
} from "../appearance";
import type { AppearanceScheme, ColorScheme, CustomTheme, PaletteViewMode, TabSwitchMode, ThemeColors, ThemeId, ThemeToken, UserSettings } from "../types";
import { resolveSettingsRead } from "./settingsState";
import { useMountEffect } from "../hooks/useMountEffect";

const MIN_CONTRAST = 4.5;

const TOKEN_LABELS: Record<ThemeToken, string> = {
  accent: "Accent",
  background: "Background",
  text: "Text",
  textSecondary: "Secondary text",
  border: "Border",
  selectedRow: "Selected row",
  selectedRowText: "Selected row text",
};

type ThemeOption = { id: ThemeId; label: string; group: string };

function presetOptions(scheme: ColorScheme): ThemeOption[] {
  return themesForScheme(scheme).map((theme) => ({
    id: theme.id,
    label: theme.name === "Mono" ? `${theme.name} · ${theme.badge}` : `${theme.badge}`,
    group: theme.name === "Mono" ? "" : theme.name,
  }));
}

function themeSlotId(settings: UserSettings, scheme: ColorScheme): ThemeId {
  return scheme === "light" ? settings.lightTheme : settings.darkTheme;
}

function themeOptionLabel(themeId: ThemeId, customThemes: CustomTheme[]): string {
  if (isCustomThemeId(themeId)) return customThemes.find((theme) => theme.id === themeId)?.name ?? themeId;
  const preset = THEMES.find((theme) => theme.id === themeId);
  return preset ? `${preset.name} · ${preset.badge}` : themeId;
}

function groupByFamily(options: ThemeOption[]) {
  const groups: { name: string; options: ThemeOption[] }[] = [];
  for (const option of options) {
    const group = option.group || "";
    const existing = groups.find((entry) => entry.name === group);
    if (existing) existing.options.push(option);
    else if (group) groups.push({ name: group, options: [option] });
    else groups.unshift({ name: "", options: [option] });
  }
  return groups;
}

export function Popup() {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({});
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  const [shownColors, setShownColors] = useState<Record<ThemeToken, string> | null>(null);
  const [isNamingTheme, setIsNamingTheme] = useState(false);
  const [themeName, setThemeName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [importStatus, setImportStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsRevision = useRef(0);
  const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
  const defaultSearchShortcut = isMac ? "⌘⇧P" : "Ctrl Shift P";
  const defaultSwitcherShortcut = isMac ? "⌥Q" : "Alt Q";
  const defaultPinShortcut = isMac ? "⌘K" : "Alt K";
  const defaultBookmarksShortcut = isMac ? "⌥B" : "Alt B";
  const movePaletteShortcut = isMac ? "⌥ + drag" : "Alt + drag";
  const version = typeof chrome !== "undefined" && chrome.runtime?.getManifest?.()?.version
    ? chrome.runtime.getManifest().version
    : "0.1.7";

  const appearance = useResolvedAppearance(settings);
  const activeCustom = isCustomThemeId(appearance.themeId)
    ? settings.customThemes.find((theme) => theme.id === appearance.themeId)
    : undefined;
  const activeOverrides: ThemeColors = settings.themeOverrides[appearance.themeId] ?? {};

  useMountEffect(() => {
    const readRevision = settingsRevision.current;
    void getStoredSettings().then((loaded) => {
      setSettings((current) => resolveSettingsRead(
        current,
        loaded,
        readRevision,
        settingsRevision.current,
      ));
    }).catch(() => {
      // Keep defaults when settings are temporarily unavailable.
    });
  });

  useMountEffect(() => {
    if (typeof chrome === "undefined" || !chrome.commands?.getAll) return;
    void chrome.commands.getAll().then((commands) => {
      const currentShortcuts: Record<string, string> = {};
      commands.forEach((command) => {
        if (command.name && command.shortcut) currentShortcuts[command.name] = command.shortcut;
      });
      setShortcuts(currentShortcuts);
      setShortcutsLoaded(true);
    }).catch(() => {
      // Commands API unavailable: keep manifest defaults and no warning,
      // since we cannot verify which keys are actually assigned.
    });
  });

  // Read the effective colours back out of the rendered theme block so the
  // pickers start from what is actually on screen (including rgba tokens).
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || typeof getComputedStyle !== "function") return;
    const computed = getComputedStyle(element);
    const panel = computed.getPropertyValue(TOKEN_PREVIEW_VAR.background).trim() || "#000000";
    const next = {} as Record<ThemeToken, string>;
    for (const token of THEME_TOKENS) {
      next[token] = resolveColorToken(computed.getPropertyValue(TOKEN_PREVIEW_VAR[token]).trim() || panel, panel);
    }
    setShownColors(next);
  }, [appearance, settings.customThemes, settings.themeOverrides]);

  const shortcutRows = [
    { label: "Search tabs", command: "open-palette" as const, fallback: defaultSearchShortcut },
    { label: "Visual switcher", command: "open-tab-switcher" as const, fallback: defaultSwitcherShortcut },
    { label: "Pin selected tab", command: "pin-tab" as const, fallback: defaultPinShortcut },
    { label: "Bookmark manager", command: "open-bookmarks" as const, fallback: defaultBookmarksShortcut },
  ];
  const unsetCommands = shortcutRows.filter((row) => !shortcuts[row.command]);

  const openShortcutSettingsAndClose = async () => {
    try {
      await openShortcutSettings();
    } finally {
      window.close();
    }
  };

  const updateSettings = async (partial: Partial<UserSettings>) => {
    const saveRevision = settingsRevision.current + 1;
    settingsRevision.current = saveRevision;
    const previousSettings = settings;
    setSettings((current) => ({ ...current, ...partial }));
    try {
      const next = await saveStoredSettings(partial);
      if (settingsRevision.current === saveRevision) setSettings(next);
    } catch {
      if (settingsRevision.current === saveRevision) {
        try {
          setSettings(await getStoredSettings());
        } catch {
          setSettings(previousSettings);
        }
      }
    }
  };

  const updateSetting = async <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    await updateSettings({ [key]: value });
  };

  const chooseScheme = (scheme: AppearanceScheme) => {
    void updateSetting("colorScheme", scheme);
  };

  const chooseTheme = (scheme: ColorScheme, themeId: ThemeId) => {
    void updateSetting(scheme === "light" ? "lightTheme" : "darkTheme", themeId);
  };

  const isTokenOverridden = (token: ThemeToken) => {
    if (activeCustom && token in activeCustom.colors) return true;
    return token in activeOverrides;
  };

  const withUpdatedOverrides = (themeId: string, nextColors: ThemeColors): Record<string, ThemeColors> => {
    const next = { ...settings.themeOverrides };
    if (Object.keys(nextColors).length === 0) delete next[themeId];
    else next[themeId] = nextColors;
    return next;
  };

  const setTokenColor = (token: ThemeToken, value: string) => {
    const color = value.toLowerCase();
    if (activeCustom) {
      void updateSettings({
        customThemes: settings.customThemes.map((theme) => theme.id === activeCustom.id
          ? { ...theme, colors: { ...theme.colors, [token]: color } }
          : theme),
      });
      return;
    }
    void updateSettings({
      themeOverrides: withUpdatedOverrides(appearance.themeId, {
        ...activeOverrides,
        [token]: color,
      }),
    });
  };

  const resetTokenColor = (token: ThemeToken) => {
    const nextOverrides = { ...activeOverrides };
    delete nextOverrides[token];
    if (activeCustom) {
      const colors = { ...activeCustom.colors };
      delete colors[token];
      void updateSettings({
        customThemes: settings.customThemes.map((theme) => theme.id === activeCustom.id ? { ...theme, colors } : theme),
        themeOverrides: withUpdatedOverrides(activeCustom.id, nextOverrides),
      });
      return;
    }
    void updateSettings({ themeOverrides: withUpdatedOverrides(appearance.themeId, nextOverrides) });
  };

  const resetAllColors = () => {
    if (activeCustom) {
      void updateSettings({
        customThemes: settings.customThemes.map((theme) => theme.id === activeCustom.id ? { ...theme, colors: {} } : theme),
        themeOverrides: withUpdatedOverrides(activeCustom.id, {}),
      });
      return;
    }
    void updateSettings({ themeOverrides: withUpdatedOverrides(appearance.themeId, {}) });
  };

  const textContrast = shownColors ? contrastRatio(shownColors.text, shownColors.background) : MIN_CONTRAST;
  const selectedContrast = shownColors ? contrastRatio(shownColors.selectedRowText, shownColors.selectedRow) : MIN_CONTRAST;
  const contrastWarnings = [
    textContrast < MIN_CONTRAST
      ? `Text on background is ${textContrast.toFixed(1)}:1`
      : null,
    selectedContrast < MIN_CONTRAST
      ? `Selected row text is ${selectedContrast.toFixed(1)}:1`
      : null,
  ].filter((entry): entry is string => entry !== null);

  const startNamingTheme = () => {
    setThemeName(activeCustom ? `${activeCustom.name} copy` : `${themeOptionLabel(appearance.themeId, settings.customThemes)} copy`);
    setIsNamingTheme(true);
  };

  const saveAsTheme = () => {
    const name = cleanThemeName(themeName);
    if (!name) return;
    const colors = resolvedThemeColors(settings.customThemes, settings.themeOverrides, appearance.themeId);
    const id = newCustomThemeId(settings.customThemes.map((theme) => theme.id));
    const theme: CustomTheme = {
      id,
      name,
      base: appearance.baseTheme,
      scheme: appearance.scheme,
      colors,
    };
    const customThemes = [...settings.customThemes, theme].slice(0, MAX_CUSTOM_THEMES);
    const selectTheme: Partial<UserSettings> = appearance.scheme === "light"
      ? { lightTheme: theme.id }
      : { darkTheme: theme.id };
    void updateSettings({ customThemes, ...selectTheme });
    setIsNamingTheme(false);
    setThemeName("");
  };

  const renameTheme = (id: string) => {
    const name = cleanThemeName(renameValue);
    if (!name) return;
    void updateSetting("customThemes", settings.customThemes.map((theme) => theme.id === id ? { ...theme, name } : theme));
    setRenamingId(null);
    setRenameValue("");
  };

  const deleteTheme = (theme: CustomTheme) => {
    const nextOverrides = { ...settings.themeOverrides };
    delete nextOverrides[theme.id];
    void updateSettings({
      customThemes: settings.customThemes.filter((entry) => entry.id !== theme.id),
      themeOverrides: nextOverrides,
      ...(settings.lightTheme === theme.id ? { lightTheme: theme.base } : {}),
      ...(settings.darkTheme === theme.id ? { darkTheme: theme.base } : {}),
    });
    setImportStatus(null);
  };

  const exportThemes = () => {
    const payload = JSON.stringify(buildThemesFile(settings.customThemes, settings.themeOverrides), null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "jump-themes.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const result = importThemes(text, {
        customThemes: settings.customThemes,
        themeOverrides: settings.themeOverrides,
      });
      await updateSettings({
        customThemes: result.customThemes,
        themeOverrides: result.themeOverrides,
      });
      setImportStatus({
        kind: "ok",
        message: result.importedCount === 1 ? "Imported 1 theme." : `Imported ${result.importedCount} themes.`,
      });
    } catch (error) {
      setImportStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not import that file.",
      });
    }
  };

  const renderThemeSelect = (scheme: ColorScheme, label: string) => {
    const presets = presetOptions(scheme);
    const groups = groupByFamily(presets);
    const customs = settings.customThemes.filter((theme) => theme.scheme === scheme);
    const value = themeSlotId(settings, scheme);
    const hasValue = presets.some((option) => option.id === value) || customs.some((theme) => theme.id === value);
    return (
      <label className="popup-theme-select-wrap">
        <span className="popup-field-label">{label}</span>
        <select
          className="popup-theme-select"
          value={hasValue ? value : ""}
          onChange={(event) => {
            const next = event.target.value;
            if (next) chooseTheme(scheme, next as ThemeId);
          }}
        >
          {!hasValue && <option value="">Choose a theme…</option>}
          {groups.map((group) => group.name === "" ? (
            group.options.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))
          ) : (
            <optgroup key={group.name} label={group.name}>
              {group.options.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </optgroup>
          ))}
          {customs.length > 0 && (
            <optgroup label="Custom">
              {customs.map((theme) => (
                <option key={theme.id} value={theme.id}>{theme.name}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
    );
  };

  const customThemes = settings.customThemes;

  return (
    <main
      className="popup-container"
      ref={rootRef}
      data-theme={appearance.baseTheme}
      data-scheme={appearance.scheme}
      style={appearance.cssVars}
    >
      <header className="popup-header">
        <div className="popup-brand">
          <span className="popup-mark" aria-hidden="true">
            <CommandIcon size={14} />
          </span>
          <div className="popup-brand-text">
            <div className="popup-title-row">
              <h1 className="popup-title">Jump</h1>
              <span className="popup-version-pill">v{version}</span>
            </div>
            <p className="popup-tagline">Fast tab search &amp; switcher</p>
          </div>
        </div>
      </header>

      <section className="popup-section" aria-labelledby="appearance-label">
        <div className="popup-section-heading">
          <span id="appearance-label">Appearance</span>
          <span className="popup-section-context">Light, dark or system</span>
        </div>
        <div className="popup-segmented is-triple" role="group" aria-label="Color scheme">
          {(["light", "dark", "auto"] as const satisfies readonly AppearanceScheme[]).map((scheme) => (
            <button
              key={scheme}
              type="button"
              className={`popup-segmented-item ${settings.colorScheme === scheme ? "active" : ""}`}
              aria-pressed={settings.colorScheme === scheme}
              onClick={() => chooseScheme(scheme)}
            >
              <span>{scheme === "dark" ? "Dark" : scheme === "light" ? "Light" : "Auto"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="popup-section" aria-labelledby="theme-label">
        <div className="popup-section-heading">
          <span id="theme-label">Theme</span>
          <span className="popup-section-context">
            {settings.colorScheme === "auto" ? "Follows system" : settings.colorScheme === "light" ? "Light palettes" : "Dark palettes"}
          </span>
        </div>
        {settings.colorScheme === "auto" ? (
          <div className="popup-theme-stack">
            {renderThemeSelect("dark", "Dark theme")}
            {renderThemeSelect("light", "Light theme")}
          </div>
        ) : (
          renderThemeSelect(settings.colorScheme, "Theme")
        )}
      </section>

      <section className="popup-section popup-colors" aria-labelledby="colors-label">
        <div className="popup-section-heading">
          <span id="colors-label">Colors</span>
          <span className="popup-section-context">{themeOptionLabel(appearance.themeId, settings.customThemes)}</span>
        </div>
        <div className="popup-color-list">
          {THEME_TOKENS.map((token) => (
            <div key={token} className="popup-color-row">
              <span className="popup-color-label">{TOKEN_LABELS[token]}</span>
              <input
                className="popup-color-input"
                type="color"
                value={shownColors?.[token] ?? "#000000"}
                aria-label={`${TOKEN_LABELS[token]} color`}
                onChange={(event) => setTokenColor(token, event.target.value)}
              />
              {isTokenOverridden(token) && (
                <button
                  type="button"
                  className="popup-color-reset"
                  aria-label={`Reset ${TOKEN_LABELS[token]}`}
                  title={`Reset ${TOKEN_LABELS[token]}`}
                  onClick={() => resetTokenColor(token)}
                >
                  Reset
                </button>
              )}
            </div>
          ))}
        </div>
        {contrastWarnings.length > 0 && (
          <p className="popup-contrast-warning" role="alert">
            <InfoIcon size={13} />
            <span>{contrastWarnings.join(". ")}. Aim for {MIN_CONTRAST}:1 or higher.</span>
          </p>
        )}
        <div className="popup-color-actions">
          <button type="button" className="popup-mini-btn" onClick={resetAllColors}>Reset all</button>
          <button type="button" className="popup-mini-btn" onClick={startNamingTheme}>Save as theme…</button>
        </div>
        {isNamingTheme && (
          <div className="popup-inline-form">
            <input
              className="popup-text-input"
              type="text"
              value={themeName}
              maxLength={40}
              placeholder="Theme name"
              aria-label="New theme name"
              onChange={(event) => setThemeName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveAsTheme();
                if (event.key === "Escape") setIsNamingTheme(false);
              }}
            />
            <button type="button" className="popup-mini-btn is-primary" onClick={saveAsTheme}>Save</button>
            <button type="button" className="popup-mini-btn" onClick={() => setIsNamingTheme(false)}>Cancel</button>
          </div>
        )}
        {customThemes.length > 0 && (
          <ul className="popup-custom-list">
            {customThemes.map((theme) => (
              <li key={theme.id} className="popup-custom-row">
                {renamingId === theme.id ? (
                  <>
                    <input
                      className="popup-text-input"
                      type="text"
                      value={renameValue}
                      maxLength={40}
                      aria-label={`Rename ${theme.name}`}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") renameTheme(theme.id);
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                    <button type="button" className="popup-mini-btn is-primary" onClick={() => renameTheme(theme.id)}>Save</button>
                    <button type="button" className="popup-mini-btn" onClick={() => setRenamingId(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="popup-custom-name" title={theme.name}>{theme.name}</span>
                    <span className="popup-custom-badge">{theme.scheme === "light" ? "Light" : "Dark"}</span>
                    <button
                      type="button"
                      className="popup-mini-btn"
                      onClick={() => {
                        setRenamingId(theme.id);
                        setRenameValue(theme.name);
                      }}
                    >
                      Rename
                    </button>
                    <button type="button" className="popup-mini-btn" onClick={() => deleteTheme(theme)}>Delete</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="popup-color-actions">
          <button type="button" className="popup-mini-btn" onClick={exportThemes}>Export</button>
          <button type="button" className="popup-mini-btn" onClick={() => fileInputRef.current?.click()}>Import</button>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            aria-label="Import themes"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void importFile(file);
            }}
          />
        </div>
        {importStatus && (
          <p className={`popup-import-status ${importStatus.kind === "error" ? "is-error" : ""}`} role="status">
            {importStatus.message}
          </p>
        )}
      </section>

      <section className="popup-section" aria-labelledby="opacity-label">
        <div className="popup-section-heading">
          <span id="opacity-label">Opacity</span>
          <span className="popup-section-context">Panel background</span>
        </div>
        <label className="popup-range-row">
          <span className="sr-only">Panel background opacity</span>
          <input
            className="popup-range"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.paletteOpacity}
            onChange={(event) => void updateSetting("paletteOpacity", Number(event.target.value))}
          />
          <output>{Math.round(settings.paletteOpacity * 100)}%</output>
        </label>
      </section>

      <section className="popup-section" aria-labelledby="blur-label">
        <div className="popup-section-heading">
          <span id="blur-label">Blur</span>
          <span className="popup-section-context">Panel background</span>
        </div>
        <label className="popup-range-row is-stacked">
          <span className="sr-only">Panel background blur in pixels</span>
          <input
            className="popup-range"
            type="range"
            min="0"
            max={MAX_PALETTE_BLUR}
            step="1"
            value={settings.paletteBlur}
            onChange={(event) => void updateSetting("paletteBlur", Number(event.target.value))}
          />
          <output>{Math.round(settings.paletteBlur)} px</output>
        </label>
      </section>

      <section className="popup-section" aria-labelledby="palette-view-label">
        <div className="popup-section-heading">
          <span id="palette-view-label">Command palette</span>
          <span className="popup-section-context">Default view</span>
        </div>
        <div className="popup-segmented" role="group" aria-label="Command palette default view">
          {(["collapsed", "expanded"] as const satisfies readonly PaletteViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`popup-segmented-item ${settings.paletteViewMode === mode ? "active" : ""}`}
              aria-pressed={settings.paletteViewMode === mode}
              onClick={() => void updateSetting("paletteViewMode", mode)}
            >
              <span>{mode === "collapsed" ? "Collapsed" : "Expanded"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="popup-section" aria-labelledby="tab-switching-label">
        <div className="popup-section-heading">
          <span id="tab-switching-label">Tab switching</span>
          <span className="popup-section-context">Cycle order</span>
        </div>
        <div className="popup-segmented" role="group" aria-label="Tab switching order">
          {(["recent", "order"] as const satisfies readonly TabSwitchMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`popup-segmented-item ${settings.tabSwitchMode === mode ? "active" : ""}`}
              aria-pressed={settings.tabSwitchMode === mode}
              onClick={() => void updateSetting("tabSwitchMode", mode)}
            >
              <span>{mode === "recent" ? "Recent" : "Tab order"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="popup-section popup-mouse-settings" aria-labelledby="mouse-settings-label">
        <div className="popup-section-heading">
          <span id="mouse-settings-label">Keyboard-only navigation</span>
          <span className="popup-section-context">Disable mouse</span>
        </div>
        <label className="popup-toggle-row">
          <span>Tab switcher</span>
          <input
            type="checkbox"
            checked={settings.disableMouseTabSwitcher}
            onChange={(event) => void updateSetting("disableMouseTabSwitcher", event.target.checked)}
          />
        </label>
        <label className="popup-toggle-row">
          <span>Command palette</span>
          <input
            type="checkbox"
            checked={settings.disableMouseCommandPalette}
            onChange={(event) => void updateSetting("disableMouseCommandPalette", event.target.checked)}
          />
        </label>
        <label className="popup-toggle-row">
          <span>Bookmarks</span>
          <input
            type="checkbox"
            checked={settings.disableMouseBookmarks}
            onChange={(event) => void updateSetting("disableMouseBookmarks", event.target.checked)}
          />
        </label>
      </section>

      <section className="popup-shortcuts" aria-label="Keyboard shortcuts">
        {shortcutsLoaded && unsetCommands.length > 0 && (
          <p className="popup-shortcut-warning" role="alert">
            <InfoIcon size={14} />
            <span>
              {unsetCommands.length === 1
                ? "Shortcut not assigned: "
                : "Shortcuts not assigned: "}
              {unsetCommands.map((row) => row.label).join(", ")}.
            </span>
            <button type="button" onClick={() => void openShortcutSettingsAndClose()}>
              Fix it
            </button>
          </p>
        )}
        {shortcutRows.map((row) => (
          <div key={row.command} className="popup-shortcut-row">
            <span>{row.label}</span>
            <span className="popup-key-group">
              <kbd className={shortcutsLoaded && !shortcuts[row.command] ? "popup-key-unset" : undefined}>
                {shortcuts[row.command] ?? (shortcutsLoaded ? "Not set" : row.fallback)}
              </kbd>
            </span>
          </div>
        ))}
        <div className="popup-shortcut-row">
          <span>Move command palette</span>
          <span className="popup-key-group">
            <kbd>{movePaletteShortcut}</kbd>
          </span>
        </div>
      </section>

      <footer className="popup-footer-bar">
        <button
          type="button"
          className="popup-settings-link"
          onClick={() => void openShortcutSettingsAndClose()}
        >
          <span>Customize shortcuts</span>
          <ArrowUpRightIcon size={11} />
        </button>
      </footer>
    </main>
  );
}
