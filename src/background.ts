import { parsePreviewEntries, retainOpenTabPreviews, type PreviewEntry } from "./previewCache";
import { getStoredSettings, pinnedTabIdentity, saveStoredSettings } from "./settings";
import type { BookmarkItem, BrowserMessage, PaletteTab, TabList, TabPreview, UserSettings } from "./types";

const LEGACY_PREVIEW_CACHE_KEY = "recent-tab-previews";
const LEGACY_PREVIEW_CACHE_PREFIX = "tab-preview:";
const PREVIEW_CACHE_PREFIX = "tab-preview-v2:";
const PREVIEW_CAPTURE_INTERVAL_MS = 550;
const PREVIEW_MAX_WIDTH = 640;
const PREVIEW_MAX_HEIGHT = 400;
const HISTORY_CACHE_LIMIT = 100;

type HistoryResult = {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  lastVisitTime?: number;
};

const historyCache = new Map<string, HistoryResult[]>();
const historyRequests = new Map<string, Promise<HistoryResult[]>>();
function invalidateHistoryCache() {
  historyCache.clear();
}
let pinUpdateQueue = Promise.resolve();

function enqueuePinUpdate(update: () => Promise<void>) {
  const operation = pinUpdateQueue.catch(() => undefined).then(update);
  pinUpdateQueue = operation.catch(() => undefined);
  return operation;
}

const previewCache = new Map<number, PreviewEntry>();
const overlayTabIds = new Set<number>();
let lastPreviewCaptureStartedAt = 0;

function hostnameFor(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^[a-z]+:\/\//i, "").split("/")[0];
  }
}

function previewStorageKey(tabId: number) {
  return `${PREVIEW_CACHE_PREFIX}${tabId}`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function compactPreview(dataUrl: string) {
  try {
    const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / source.width, PREVIEW_MAX_HEIGHT / source.height);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      source.close();
      return null;
    }
    context.drawImage(source, 0, 0, width, height);
    source.close();
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    return `data:image/webp;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } catch {
    return null;
  }
}

async function persistPreview(entry: PreviewEntry) {
  try {
    await chrome.storage.session.set({ [previewStorageKey(entry.tabId)]: entry });
  } catch {
    // The in-memory cache remains usable if session storage is unavailable.
  }
}

const previewCacheReady = chrome.storage.session
  .get(null)
  .then(async (stored) => {
    const keyedEntries = Object.entries(stored).flatMap(([key, value]) =>
      key.startsWith(PREVIEW_CACHE_PREFIX) ? parsePreviewEntries([value]) : []
    );
    keyedEntries.forEach((entry) => previewCache.set(entry.tabId, entry));

    // Version 1 previews may contain the palette itself and used a much lower
    // quality encode. Drop them instead of carrying bad images forward.
    const obsoletePreviewKeys = Object.keys(stored).filter((key) =>
      key === LEGACY_PREVIEW_CACHE_KEY || key.startsWith(LEGACY_PREVIEW_CACHE_PREFIX)
    );
    if (obsoletePreviewKeys.length > 0) {
      await chrome.storage.session.remove(obsoletePreviewKeys);
    }
  })
  .catch(() => {});

async function removeCachedPreview(tabId: number) {
  await previewCacheReady;
  previewCache.delete(tabId);
  await chrome.storage.session.remove(previewStorageKey(tabId)).catch(() => undefined);
}

async function capturePreview(tabId: number, windowId: number) {
  await previewCacheReady;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (overlayTabIds.has(tabId) || !tab.active || tab.discarded || !tab.url) return null;

    const capturedDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const currentTab = await chrome.tabs.get(tabId);
    if (overlayTabIds.has(tabId) || !capturedDataUrl || currentTab.url !== tab.url || !currentTab.active) return null;

    const capturedAt = Date.now();
    const entry = {
      tabId,
      url: tab.url,
      dataUrl: capturedDataUrl,
      capturedAt,
    };
    previewCache.set(tabId, entry);

    // Make the raw preview available immediately. Compression and storage are
    // background work so they cannot delay the switcher or its repeat rate.
    void compactPreview(capturedDataUrl).then(async (dataUrl) => {
      if (dataUrl === null) return;
      const currentEntry = previewCache.get(tabId);
      if (currentEntry?.capturedAt !== capturedAt || currentEntry.url !== tab.url) return;
      const compactedEntry = { ...entry, dataUrl };
      previewCache.set(tabId, compactedEntry);
      await persistPreview(compactedEntry);
    }).catch(() => undefined);
    return entry;
  } catch {
    // Restricted browser pages and closed tabs cannot be captured.
    return null;
  }
}

// Previews are captured ahead of time, while a tab is on screen without the
// palette: shortly after it becomes active, finishes loading, or the palette
// closes over it. Opening the switcher then never waits for a capture (one
// takes ~20 ms), and a capture never shows the palette itself.
const PREVIEW_SETTLE_MS = 300;
const previewCaptureTimers = new Map<number, ReturnType<typeof setTimeout>>();

function schedulePreviewCapture(windowId: number, delay = PREVIEW_SETTLE_MS) {
  const pending = previewCaptureTimers.get(windowId);
  if (pending !== undefined) clearTimeout(pending);
  previewCaptureTimers.set(windowId, setTimeout(() => {
    previewCaptureTimers.delete(windowId);
    // Chrome allows two captures a second; wait out the interval, don't skip.
    const wait = lastPreviewCaptureStartedAt + PREVIEW_CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) {
      schedulePreviewCapture(windowId, wait);
      return;
    }
    void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
      if (tab?.id === undefined || overlayTabIds.has(tab.id)) return;
      lastPreviewCaptureStartedAt = Date.now();
      return capturePreview(tab.id, windowId);
    }).catch(() => undefined);
  }, delay));
}

chrome.tabs.onActivated.addListener(({ windowId }) => schedulePreviewCapture(windowId));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) schedulePreviewCapture(tab.windowId);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) schedulePreviewCapture(windowId);
});

// The palette bundle (~330 KB) is not a declared content script: pages only
// carry the 2 KB keyboard guard, and the palette is injected into a tab the
// first time it is opened there. It runs in the same isolated world as the
// guard, so they share state.
const PALETTE_SCRIPT = "assets/content.js";

// One injection per tab at a time: a second open that arrives while the first
// injection is still running waits for it instead of evaluating the bundle twice.
const pendingInjections = new Map<number, Promise<boolean>>();

function injectPalette(tabId: number) {
  const pending = pendingInjections.get(tabId);
  if (pending) return pending;
  const injection = chrome.scripting.executeScript({ target: { tabId }, files: [PALETTE_SCRIPT] })
    .then(() => true, () => false) // Browser-owned pages (chrome://, the Web Store) cannot host the palette.
    .finally(() => pendingInjections.delete(tabId));
  pendingInjections.set(tabId, injection);
  return injection;
}

async function sendToTab(tab: chrome.tabs.Tab, message: BrowserMessage, { inject = false } = {}) {
  if (tab.id === undefined) return false;
  // A previous open's injection may still be running.
  await pendingInjections.get(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  } catch {
    // No palette in this tab yet ("Receiving end does not exist").
  }
  if (!inject || !(await injectPalette(tab.id))) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  } catch {
    return false;
  }
}

function searchHistory(query: string, maxResults: number) {
  const key = query.trim().toLowerCase();
  const cached = historyCache.get(key);
  if (cached) return Promise.resolve(cached.slice(0, maxResults));

  const allHistory = historyCache.get("");
  const activeRequest = historyRequests.get(key);
  if (activeRequest) return activeRequest.then((items) => items.slice(0, maxResults));

  const request = chrome.history.search({ text: key, maxResults: HISTORY_CACHE_LIMIT })
    .then((items) => items
      .filter((item): item is chrome.history.HistoryItem & { id: string; url: string } =>
        typeof item.id === "string" && typeof item.url === "string" && item.url !== ""
      )
      .map((item) => ({
        id: item.id,
        url: item.url,
        title: item.title?.trim() || item.url,
        faviconUrl: "faviconUrl" in item && typeof item.faviconUrl === "string" ? item.faviconUrl : undefined,
        lastVisitTime: item.lastVisitTime,
      }))
    );
  historyRequests.set(key, request);
  void request.then((items) => {
    historyCache.set(key, items);
    historyRequests.delete(key);
  }, () => historyRequests.delete(key));
  return request.then((items) => items.slice(0, maxResults));
}

async function sendToActiveTab(message: BrowserMessage, options?: { inject?: boolean }) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await sendToTab(tab, message, options);
}

// Settings and the tab list are kept ready in memory and sent with every
// open, so the palette's first render already shows the user's theme and
// tabs instead of waiting for two round trips. Both are rebuilt when they
// change; a service worker that was asleep rebuilds them on first use.
let settingsCache: Promise<UserSettings> | undefined;
let tabsCache: Promise<TabList> | undefined;
// Versions are unique across service worker restarts, and a version always
// stands for one list content: comparing the list here, once per rebuild,
// spares every page from comparing it on open.
const tabsVersionPrefix = crypto.randomUUID();
let tabsVersionCount = 0;
let lastTabList: { json: string; version: string } | undefined;
let tabsRebuildTimer: ReturnType<typeof setTimeout> | undefined;

function cachedSettings() {
  settingsCache ??= getStoredSettings().catch((error: unknown) => {
    settingsCache = undefined;
    throw error;
  });
  return settingsCache;
}

function cachedTabs() {
  tabsCache ??= getTabs().then((tabs) => {
    const json = JSON.stringify(tabs);
    if (lastTabList?.json !== json) lastTabList = { json, version: `${tabsVersionPrefix}:${++tabsVersionCount}` };
    return { tabs, version: lastTabList.version };
  }).catch((error: unknown) => {
    tabsCache = undefined;
    throw error;
  });
  return tabsCache;
}

function invalidateTabs() {
  tabsCache = undefined;
  if (tabsRebuildTimer !== undefined) clearTimeout(tabsRebuildTimer);
  // Rebuild soon after a burst of tab events, so the next open finds it ready.
  tabsRebuildTimer = setTimeout(() => {
    tabsRebuildTimer = undefined;
    void cachedTabs().catch(() => undefined);
  }, 60);
}

[
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onActivated,
  chrome.tabs.onMoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onReplaced,
  chrome.tabs.onRemoved,
  chrome.windows.onFocusChanged,
  chrome.windows.onRemoved,
].forEach((event) => (event as { addListener(callback: () => void): void }).addListener(invalidateTabs));

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "sync" && areaName !== "local") return;
  settingsCache = undefined;
  invalidateTabs();
});

async function openPaletteData() {
  const [tabs, settings] = await Promise.all([
    cachedTabs().catch(() => undefined),
    cachedSettings().catch(() => undefined),
  ]);
  return { ...(tabs ? { tabs: tabs.tabs, tabsVersion: tabs.version } : {}), ...(settings ? { settings } : {}) };
}

async function getTabs(): Promise<PaletteTab[]> {
  const [tabs, windows, settings] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ populate: false }),
    cachedSettings(),
    previewCacheReady,
  ]);
  const browserTabs = tabs.filter(
    (tab): tab is chrome.tabs.Tab & { id: number; windowId: number } => tab.id !== undefined,
  );
  const pinnedTabs = settings.pinnedTabs.flatMap((pinnedTab) => {
    if (pinnedTab.identity) return [pinnedTab];
    const matchingTab = browserTabs.find((tab) => tab.id === pinnedTab.tabId);
    if (!matchingTab?.url) return [];
    return [{
      ...pinnedTab,
      identity: pinnedTabIdentity(matchingTab.url),
      url: matchingTab.url,
      title: matchingTab.title?.trim() || pinnedTab.title,
      hostname: hostnameFor(matchingTab.url),
      ...(matchingTab.favIconUrl ? { faviconUrl: matchingTab.favIconUrl } : {}),
    }];
  });
  if (JSON.stringify(pinnedTabs) !== JSON.stringify(settings.pinnedTabs)) {
    void enqueuePinUpdate(async () => {
      const latestSettings = await getStoredSettings();
      const migratedTabs = latestSettings.pinnedTabs.flatMap((pinnedTab) => {
        if (pinnedTab.identity) return [pinnedTab];
        const matchingTab = browserTabs.find((tab) => tab.id === pinnedTab.tabId);
        if (!matchingTab?.url) return [];
        return [{
          ...pinnedTab,
          identity: pinnedTabIdentity(matchingTab.url),
          url: matchingTab.url,
          title: matchingTab.title?.trim() || pinnedTab.title,
          hostname: hostnameFor(matchingTab.url),
          ...(matchingTab.favIconUrl ? { faviconUrl: matchingTab.favIconUrl } : {}),
        }];
      });
      await saveStoredSettings({ pinnedTabs: migratedTabs });
    });
  }
  const retainedPreviews = retainOpenTabPreviews(previewCache.values(), browserTabs);
  const retainedTabIds = new Set(retainedPreviews.map((entry) => entry.tabId));
  const staleTabIds = [...previewCache.keys()].filter((tabId) => !retainedTabIds.has(tabId));
  staleTabIds.forEach((tabId) => previewCache.delete(tabId));
  if (staleTabIds.length > 0) {
    void chrome.storage.session.remove(staleTabIds.map(previewStorageKey)).catch(() => undefined);
  }

  const focusedWindows = new Set(windows.filter((window) => window.focused).map((window) => window.id));

  return browserTabs
    .map((tab) => {
      return {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title?.trim() || "Untitled tab",
        url: tab.url || "",
        hostname: hostnameFor(tab.url),
        index: tab.index,
        faviconUrl: tab.favIconUrl,
        active: Boolean(tab.active),
        windowFocused: focusedWindows.has(tab.windowId),
        pinned: pinnedTabs.some((pinnedTab) => {
          if (pinnedTab.identity !== pinnedTabIdentity(tab.url || "")) return false;
          const liveIdMatch = browserTabs.some((candidate) => candidate.id === pinnedTab.tabId);
          return !liveIdMatch || pinnedTab.tabId === tab.id;
        }),
        audible: Boolean(tab.audible),
        muted: Boolean(tab.mutedInfo?.muted),
        lastAccessed: tab.lastAccessed,
      };
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (settings.tabSwitchMode === "order") return a.index - b.index;
      if (a.windowFocused !== b.windowFocused) return a.windowFocused ? -1 : 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    });
}

chrome.history.onVisited.addListener(invalidateHistoryCache);
chrome.history.onVisitRemoved.addListener(invalidateHistoryCache);

chrome.tabs.onRemoved.addListener((tabId) => {
  overlayTabIds.delete(tabId);
  void removeCachedPreview(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
    overlayTabIds.delete(tabId);
    void removeCachedPreview(tabId);
  }
});

function bookmarkFaviconUrl(url: string) {
  try {
    return url.startsWith("http")
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(url).hostname)}&sz=32`
      : undefined;
  } catch {
    return undefined;
  }
}

function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], folderPath: string[] = []): BookmarkItem[] {
  return nodes.flatMap((node) => {
    const nextPath = node.title ? [...folderPath, node.title] : folderPath;
    if (node.url) {
      return [{
        id: node.id,
        title: node.title.trim() || node.url,
        url: node.url,
        folderPath,
        dateAdded: node.dateAdded,
        ...(bookmarkFaviconUrl(node.url) ? { faviconUrl: bookmarkFaviconUrl(node.url) } : {}),
      }];
    }
    return node.children ? flattenBookmarks(node.children, nextPath) : [];
  });
}

async function getBookmarks(): Promise<BookmarkItem[]> {
  const tree = await chrome.bookmarks.getTree();
  return flattenBookmarks(tree).sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0));
}

async function openSearchPalette() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;

  // Search mode does not need a fresh screenshot. Open it immediately and let
  // the switcher own screenshot capture, so the command never feels delayed.
  if (tab.id !== undefined) overlayTabIds.add(tab.id);
  const opened = await sendToTab(tab, { type: "open-palette", mode: "search", ...(await openPaletteData()) }, { inject: true });
  if (!opened && tab.id !== undefined) overlayTabIds.delete(tab.id);
}

let switcherOpenInFlight = false;

async function openTabSwitcher() {
  if (switcherOpenInFlight) return;
  switcherOpenInFlight = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;

    // No capture here: previews are captured ahead of time (see
    // schedulePreviewCapture). Overlapping shortcut events are dropped instead
    // of queued for delivery after Alt is released. The message carries only
    // the active tab's preview stamp; the palette fetches the image when the
    // one it holds is older.
    if (tab.id !== undefined) overlayTabIds.add(tab.id);
    await previewCacheReady;
    const activePreview = tab.id !== undefined ? previewCache.get(tab.id) : undefined;
    const opened = await sendToTab(tab, {
      type: "open-palette",
      mode: "switcher",
      activeTabId: tab.id,
      ...(activePreview && activePreview.url === tab.url ? { activePreviewAt: activePreview.capturedAt } : {}),
      ...(await openPaletteData()),
    }, { inject: true });
    if (!opened && tab.id !== undefined) overlayTabIds.delete(tab.id);
  } finally {
    switcherOpenInFlight = false;
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-palette") void openSearchPalette();
  if (command === "open-tab-switcher") void openTabSwitcher();
  if (command === "pin-tab") void sendToActiveTab({ type: "request-pin-selected-tab" });
  if (command === "open-bookmarks") {
    void openPaletteData().then((data) => sendToActiveTab({ type: "open-palette", mode: "bookmarks", ...data }, { inject: true }));
  }
});

chrome.action.onClicked.addListener(() => void openSearchPalette());

chrome.runtime.onMessage.addListener((message: BrowserMessage, sender, sendResponse) => {
  if (message.type === "palette-opened") {
    if (sender.tab?.id !== undefined) overlayTabIds.add(sender.tab.id);
    return false;
  }

  if (message.type === "palette-closed") {
    if (sender.tab?.id !== undefined) overlayTabIds.delete(sender.tab.id);
    // Refresh the preview once the closing animation has finished.
    if (sender.tab?.active) schedulePreviewCapture(sender.tab.windowId, 400);
    return false;
  }

  if (message.type === "get-tabs") {
    void cachedTabs().then(sendResponse, () => sendResponse({ tabs: [], version: "" } satisfies TabList));
    return true;
  }

  if (message.type === "get-bookmarks") {
    void getBookmarks().then(sendResponse);
    return true;
  }

  if (message.type === "get-tab-previews") {
    const tabIds = message.tabIds
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0)
      .slice(0, 12);
    void previewCacheReady.then(() => {
      sendResponse(Object.fromEntries(tabIds.flatMap((tabId) => {
        const preview = previewCache.get(tabId);
        return preview ? [[String(tabId), { dataUrl: preview.dataUrl, capturedAt: preview.capturedAt } satisfies TabPreview]] : [];
      })));
    });
    return true;
  }

  if (message.type === "search-history") {
    void searchHistory(message.query, Math.min(message.maxResults ?? 8, 8)).then(sendResponse);
    return true;
  }

  if (message.type === "activate-tab") {
    void chrome.tabs.update(message.tab.id, { active: true })
      .then(() => chrome.windows.update(message.tab.windowId, { focused: true }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "toggle-tab-muted") {
    void chrome.tabs.update(message.tabId, { muted: message.muted })
      .then(() => sendResponse({ ok: true, muted: message.muted }), () => sendResponse({ ok: false, muted: false }));
    return true;
  }

  if (message.type === "set-tab-pinned") {
    const operation = enqueuePinUpdate(async () => {
      const settings = await getStoredSettings();
      const pinnedTabs = settings.pinnedTabs.filter((tab) => tab.identity !== message.tab.identity);
      if (message.pinned) pinnedTabs.push(message.tab);
      await saveStoredSettings({ pinnedTabs });
    });
    void operation.then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "open-bookmark") {
    void chrome.tabs.create({ url: message.url }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "open-url") {
    void chrome.tabs.create({ url: message.url, openerTabId: message.openerTabId })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "search-web") {
    void chrome.search.query({ text: message.query, disposition: "NEW_TAB" })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "open-shortcut-settings") {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
