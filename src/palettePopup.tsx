import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { EventRootContext } from "./eventRoot";
import { paletteStyles } from "./paletteStyles";
import type { BrowserMessage } from "./types";

/**
 * The palette in the toolbar popup. Chrome does not let extensions draw on its
 * own pages (New Tab, Settings, Extensions, the Web Store), so on those the
 * shortcut opens the palette here instead (see openInToolbarPopup in
 * background.ts). It is the overlay's palette, mounted the same way as in
 * content.tsx: a shadow root with the same stylesheet, rendered from the same
 * open message (tab list and settings included).
 */
type OpenMessage = Extract<BrowserMessage, { type: "open-palette" }>;

const host = document.createElement("div");
host.className = "palette-popup";
const shadow = host.attachShadow({ mode: "open" });
shadow.adoptedStyleSheets = [paletteStyles()];
const point = document.createElement("div");
shadow.append(point);
document.body.append(host);

let root: Root | undefined;
const openHandlerRef: { current?: (message: OpenMessage) => void } = {};
const messageHandlerRef: { current?: (message: BrowserMessage) => void } = {};

// The background sends the open message once this port connects, and later
// opens (such as another press of the switcher shortcut, which cycles it) the
// same way while the popup stays open.
const port = chrome.runtime.connect({ name: "palette-popup" });
port.onMessage.addListener((message: BrowserMessage) => {
  if (message.type !== "open-palette") {
    // Commands for the open palette (close or pin the selected tab).
    messageHandlerRef.current?.(message);
    return;
  }
  if (root) {
    openHandlerRef.current?.(message);
    return;
  }
  root = createRoot(point);
  root.render(
    <EventRootContext.Provider value={shadow}>
      <App
        initialMode={message.mode ?? "search"}
        initialActiveTabId={message.activeTabId}
        initialTabs={message.tabs}
        initialTabsVersion={message.tabsVersion}
        initialSettings={message.settings}
        openHandlerRef={openHandlerRef}
        messageHandlerRef={messageHandlerRef}
        onClose={() => window.close()}
      />
    </EventRootContext.Provider>,
  );
});
