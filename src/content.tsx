import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { EventRootContext } from "./eventRoot";
import type { BrowserMessage } from "./types";
import cssText from "./styles.css?inline";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let shadowRoot: ShadowRoot | undefined;
let mountPoint: HTMLDivElement | undefined;

const CLIPBOARD_EVENT_TYPES = new Set(["paste", "copy", "cut"]);
const KEY_EVENT_TYPES = new Set(["keydown", "keyup", "keypress"]);

const FORWARDED_EVENT_TYPES = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "focusin",
  "focusout",
  "paste",
  "copy",
  "cut",
] as const;

function modifierStateInit(event: KeyboardEvent) {
  return {
    modifierAltGraph: event.getModifierState("AltGraph"),
    modifierCapsLock: event.getModifierState("CapsLock"),
    modifierFn: event.getModifierState("Fn"),
    modifierFnLock: event.getModifierState("FnLock"),
    modifierHyper: event.getModifierState("Hyper"),
    modifierNumLock: event.getModifierState("NumLock"),
    modifierScrollLock: event.getModifierState("ScrollLock"),
    modifierSuper: event.getModifierState("Super"),
    modifierSymbol: event.getModifierState("Symbol"),
    modifierSymbolLock: event.getModifierState("SymbolLock"),
  };
}

// A clone keeps the palette's own handlers working after the original event has
// been stopped at the window. `composed: false` keeps the clone inside the
// shadow tree, so the page never observes it.
function cloneForwardedEvent(event: Event): Event | undefined {
  const init = { bubbles: event.bubbles, cancelable: event.cancelable, composed: false };
  if (event instanceof KeyboardEvent) {
    return new KeyboardEvent(event.type, {
      ...init,
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      isComposing: event.isComposing,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ...modifierStateInit(event),
    });
  }
  if (event instanceof InputEvent) {
    return new InputEvent(event.type, {
      ...init,
      inputType: event.inputType,
      data: event.data,
      isComposing: event.isComposing,
    });
  }
  if (event instanceof CompositionEvent) {
    return new CompositionEvent(event.type, { ...init, data: event.data });
  }
  if (event instanceof FocusEvent) {
    return new FocusEvent(event.type, { ...init, relatedTarget: event.relatedTarget });
  }
  return undefined;
}

// Registered at document_start, before any page script, so these window capture
// listeners run before the page's own global shortcuts. Events from inside the
// closed shadow root are retargeted to `host` here; stopping them at the window
// keeps page capture listeners from ever seeing palette keystrokes.
function handlePageEvent(event: Event) {
  if (!host || !shadowRoot || !mountPoint) return;

  const fromPalette = event.target === host;
  if (!fromPalette && !KEY_EVENT_TYPES.has(event.type)) return;

  event.stopImmediatePropagation();

  if (!fromPalette) {
    // Page focus lingered (switcher mode, or focus not yet moved). Keep the page
    // from acting on the key and deliver it to the palette instead.
    event.preventDefault();
    const forwarded = cloneForwardedEvent(event);
    if (forwarded) mountPoint.dispatchEvent(forwarded);
    return;
  }

  // Clipboard events must keep their native behaviour; only hide them from the page.
  if (CLIPBOARD_EVENT_TYPES.has(event.type)) return;

  const forwarded = cloneForwardedEvent(event);
  if (!forwarded) return;
  const target = shadowRoot.activeElement ?? mountPoint;
  target.dispatchEvent(forwarded);
  // Native typing is never cancelled: only a handler that vetoed the clone
  // should veto the real event.
  if (forwarded.defaultPrevented) event.preventDefault();
}

for (const type of FORWARDED_EVENT_TYPES) {
  window.addEventListener(type, handlePageEvent, { capture: true });
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
  shadowRoot = undefined;
  mountPoint = undefined;
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
  const style = document.createElement("style");
  style.textContent = cssText;
  shadow.append(style);
  const point = document.createElement("div");
  shadow.append(point);

  host = hostElement;
  shadowRoot = shadow;
  mountPoint = point;

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

chrome.runtime.onMessage.addListener((message: BrowserMessage) => {
  if (message.type === "open-palette") openPalette(message);
});
