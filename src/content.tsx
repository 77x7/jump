import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { EventRootContext } from "./eventRoot";
import { paletteGuardState } from "./paletteGuardState";
import type { BrowserMessage } from "./types";
import cssText from "./styles.css?inline";

type OpenMessage = Extract<BrowserMessage, { type: "open-palette" }>;
type PaletteMode = NonNullable<OpenMessage["mode"]>;

/**
 * One palette: a shadow host with a rendered App. Standby palettes are built
 * ahead of time while the page is idle, hidden and inert; an open only
 * reveals one. Each palette is used once: closing destroys it and a fresh
 * standby is built for the next open.
 */
type Palette = {
  mode: PaletteMode;
  host: HTMLDivElement;
  shadow: ShadowRoot;
  point: HTMLDivElement;
  root: Root;
  openHandlerRef: { current?: (message: OpenMessage) => void };
  activateRef: { current?: (message: OpenMessage) => void };
};

// Modes kept ready in standby. Bookmarks is rarer and builds on demand.
const STANDBY_MODES: PaletteMode[] = ["search", "switcher"];

// Shared with keyGuard.ts (document_start), which keeps the page from seeing
// or stealing palette keystrokes while these fields are set (only for the
// palette that is showing, never for a standby one).
const guardState = paletteGuardState();
const standby = new Map<PaletteMode, Palette>();
let active: Palette | undefined;

// Parsed once per page and shared by every palette shadow root.
let paletteSheet: CSSStyleSheet | undefined;
function paletteStyles() {
  if (!paletteSheet) {
    paletteSheet = new CSSStyleSheet();
    paletteSheet.replaceSync(cssText);
  }
  return paletteSheet;
}

function render(palette: Palette, message?: OpenMessage) {
  palette.root.render(
    <EventRootContext.Provider value={palette.shadow}>
      <App
        onClose={() => closePalette(palette)}
        initialMode={palette.mode}
        initialActiveTabId={message?.activeTabId}
        initialTabs={message?.tabs}
        initialTabsVersion={message?.tabsVersion}
        initialSettings={message?.settings}
        startInStandby={!message}
        activateRef={palette.activateRef}
        openHandlerRef={palette.openHandlerRef}
      />
    </EventRootContext.Provider>,
  );
}

function createPalette(mode: PaletteMode, message?: OpenMessage): Palette {
  const host = document.createElement("div");
  // A standby palette is fully styled and laid out, but moved off-screen by a
  // transform on the host. Revealing changes only that transform: no restyle
  // and no layout of the palette (visibility or display would restyle every
  // element). Off-screen it cannot be clicked; tabindex=-1 keeps its shadow
  // tree out of Tab order and aria-hidden keeps it from screen readers.
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;transform:translateX(0);";
  if (!message) {
    host.style.transform = "translateX(-200vw)";
    host.tabIndex = -1;
    host.classList.add("jump-standby");
    host.setAttribute("aria-hidden", "true");
  }
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [paletteStyles()];
  const point = document.createElement("div");
  shadow.append(point);
  document.documentElement.append(host);
  const palette: Palette = { mode, host, shadow, point, root: createRoot(point), openHandlerRef: {}, activateRef: {} };
  if (message) {
    guardPalette(palette);
    revealPalette(palette);
  }
  render(palette, message);
  return palette;
}

// Route keystrokes to this palette (keyGuard.ts reads these fields), and make
// it focusable from the page again. tabindex must go before focus moves in:
// removing it from the host while focus is inside would blur the palette.
function guardPalette(palette: Palette) {
  active = palette;
  palette.host.removeAttribute("tabindex");
  guardState.host = palette.host;
  guardState.shadowRoot = palette.shadow;
  guardState.mountPoint = palette.point;
  guardState.lastFocus = undefined;
}

// Move the host on-screen. Called after the palette took focus: focus() has to
// bring style up to date first, which is free while nothing has changed yet,
// so the reveal costs one style update (in the next frame) instead of two.
function revealPalette(palette: Palette) {
  palette.host.id = "jump-command-palette";
  palette.host.style.transform = "translateX(0)";
  palette.host.classList.remove("jump-standby");
  palette.host.removeAttribute("aria-hidden");
}

function closePalette(palette: Palette) {
  palette.root.unmount();
  palette.host.remove();
  if (active !== palette) return;
  active = undefined;
  guardState.host = undefined;
  guardState.shadowRoot = undefined;
  guardState.mountPoint = undefined;
  guardState.lastFocus = undefined;
  scheduleStandby();
}

function openPalette(message: OpenMessage) {
  if (active) {
    // Already showing: the palette handles cycling and mode changes itself.
    active.openHandlerRef.current?.(message);
    return;
  }
  const mode = message.mode ?? "search";
  const ready = standby.get(mode);
  if (ready) {
    standby.delete(mode);
    // No render unless the data sent with the open changed.
    guardPalette(ready);
    ready.activateRef.current?.(message);
    revealPalette(ready);
  } else {
    createPalette(mode, message);
  }
  scheduleStandby();
}

let standbyScheduled = false;

function scheduleStandby() {
  if (standbyScheduled) return;
  standbyScheduled = true;
  const build = () => {
    standbyScheduled = false;
    for (const mode of STANDBY_MODES) {
      // Never build behind a showing palette's back: wait until it closes.
      if (active || standby.has(mode)) continue;
      standby.set(mode, createPalette(mode));
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(build, { timeout: 2000 });
  else setTimeout(build, 200);
}

// Loaded at document_idle on every page (and injected on demand into tabs
// opened before the extension). A second injection must not add a second
// listener or a second set of standby palettes.
if (!guardState.paletteLoaded) {
  guardState.paletteLoaded = true;
  chrome.runtime.onMessage.addListener((message: BrowserMessage) => {
    if (message.type === "open-palette") openPalette(message);
  });
  scheduleStandby();
}
