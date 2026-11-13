import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { EventRootContext } from "./eventRoot";
import { paletteGuardState } from "./paletteGuardState";
import type { BrowserMessage } from "./types";
import cssText from "./styles.css?inline";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
// Shared with keyGuard.ts (document_start), which keeps the page from seeing
// or stealing palette keystrokes while these fields are set.
const guardState = paletteGuardState();

// Parsed once per page and shared by every palette shadow root, instead of a
// <style> element whose text is re-parsed on each open.
let paletteSheet: CSSStyleSheet | undefined;
function paletteStyles() {
  if (!paletteSheet) {
    paletteSheet = new CSSStyleSheet();
    paletteSheet.replaceSync(cssText);
  }
  return paletteSheet;
}

function appendHost(hostElement: HTMLDivElement) {
  const parent = document.documentElement ?? document.body;
  if (parent) {
    parent.append(hostElement);
    return;
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (host !== hostElement) return;
    (document.documentElement ?? document.body)?.append(hostElement);
  }, { once: true });
}

function closePalette() {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  guardState.host = undefined;
  guardState.shadowRoot = undefined;
  guardState.mountPoint = undefined;
  guardState.lastFocus = undefined;
}

function openPalette(message: Extract<BrowserMessage, { type: "open-palette" }> = { type: "open-palette" }) {
  if (host) {
    // Already mounted: chrome.runtime.onMessage inside App will handle cycling/mode
    return;
  }
  const hostElement = document.createElement("div");
  hostElement.id = "jump-command-palette";
  hostElement.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";

  const shadow = hostElement.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [paletteStyles()];
  const point = document.createElement("div");
  shadow.append(point);
  shadow.addEventListener("focusin", (focusEvent) => {
    if (focusEvent.target instanceof HTMLElement) guardState.lastFocus = focusEvent.target;
  });

  host = hostElement;
  guardState.host = hostElement;
  guardState.shadowRoot = shadow;
  guardState.mountPoint = point;

  appendHost(hostElement);
  root = createRoot(point);
  root.render(
    <EventRootContext.Provider value={shadow}>
      <App
        onClose={closePalette}
        initialMode={message.mode}
        initialActiveTabId={message.activeTabId}
      />
    </EventRootContext.Provider>,
  );
}

// The background injects this bundle on first open; a second injection (two
// quick opens) must not add a second listener and mount a second palette.
if (!guardState.paletteLoaded) {
  guardState.paletteLoaded = true;
  chrome.runtime.onMessage.addListener((message: BrowserMessage) => {
    if (message.type === "open-palette") openPalette(message);
  });
}
