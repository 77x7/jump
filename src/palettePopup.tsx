import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { BrowserMessage } from "./types";
import "./styles.css";

/**
 * The palette in the toolbar popup. Chrome does not let extensions draw on its
 * own pages (New Tab, Settings, Extensions, the Web Store), so on those the
 * shortcut opens the palette here instead (see openInToolbarPopup in
 * background.ts).
 */
type OpenMessage = Extract<BrowserMessage, { type: "open-palette" }>;
type PaletteMode = NonNullable<OpenMessage["mode"]>;

const params = new URLSearchParams(location.search);
const requestedMode = params.get("mode");
const mode: PaletteMode = requestedMode === "switcher" || requestedMode === "bookmarks" ? requestedMode : "search";
const activeTabId = Number(params.get("activeTabId")) || undefined;

// While this port is open the background sends later opens (such as another
// press of the switcher shortcut, which cycles it) here instead of a tab.
const openHandlerRef: { current?: (message: OpenMessage) => void } = {};
const port = chrome.runtime.connect({ name: "palette-popup" });
port.onMessage.addListener((message: BrowserMessage) => {
  if (message.type === "open-palette") openHandlerRef.current?.(message);
});

createRoot(document.getElementById("root")!).render(
  <App
    initialMode={mode}
    initialActiveTabId={activeTabId}
    openHandlerRef={openHandlerRef}
    onClose={() => window.close()}
  />,
);
