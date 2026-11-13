import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { BrowserMessage, UserSettings } from "./types";
import { useMountEffect } from "./hooks/useMountEffect";
import { DEFAULT_SETTINGS, getStoredSettings, subscribeToSettings } from "./settings";
import { useResolvedAppearance } from "./appearance";
import "./styles.css";

function NewTabPage() {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<"search" | "switcher" | "bookmarks">("search");
  const [activeTabId, setActiveTabId] = useState<number | undefined>();
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const appearance = useResolvedAppearance(settings);

  useMountEffect(() => {
    void getStoredSettings().then(setSettings).catch(() => undefined);
    return subscribeToSettings(setSettings);
  });

  useMountEffect(() => {
    const handleMessage = (message: BrowserMessage) => {
      if (message.type === "open-palette") {
        setMode(message.mode || "search");
        setActiveTabId(message.activeTabId);
        setIsOpen(true);
      }
    };
    if (chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleMessage);
      return () => chrome.runtime.onMessage.removeListener(handleMessage);
    }
  });

  useMountEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpenRef.current) {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          setMode("search");
          setIsOpen(true);
        } else if (e.altKey && e.key.toLowerCase() === "q") {
          e.preventDefault();
          setMode("switcher");
          setIsOpen(true);
        } else if (e.altKey && e.key.toLowerCase() === "b") {
          e.preventDefault();
          setMode("bookmarks");
          setIsOpen(true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  });

  if (!isOpen) {
    return (
      <div
        className="newtab-canvas"
        data-theme={appearance.baseTheme}
        data-scheme={appearance.scheme}
        style={appearance.cssVars}
      />
    );
  }

  return (
    <App
      key={mode}
      initialMode={mode}
      initialActiveTabId={activeTabId}
      onClose={() => setIsOpen(false)}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NewTabPage />
  </StrictMode>,
);
