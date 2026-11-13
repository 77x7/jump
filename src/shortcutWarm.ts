/**
 * Modifier sets of the user's own palette shortcuts, used to load the palette
 * while the modifiers are held, before the shortcut's last key arrives.
 *
 * Shortcuts are whatever the user set at chrome://extensions/shortcuts, so
 * nothing here assumes a key. The background reads them with
 * chrome.commands.getAll() and stores the modifier sets; the keyboard guard
 * compares each modifier keydown against them.
 */
export type ModifierSet = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };

export const WARM_MODIFIERS_KEY = "jumpWarmModifiers";

/** Commands that open the palette (pin-tab only acts on an open palette). */
export const PALETTE_COMMANDS = new Set(["open-palette", "open-tab-switcher", "open-bookmarks"]);

/**
 * Parses a shortcut as chrome.commands reports it: "Ctrl+Shift+P", "Alt+Q",
 * "Ctrl+T" on Windows/Linux, or symbols such as "⇧⌘P" / "⌃⌥K" on macOS.
 * Returns null for an empty shortcut or one with no modifier.
 */
export function parseShortcutModifiers(shortcut: string | undefined): ModifierSet | null {
  if (!shortcut) return null;
  const set: ModifierSet = { ctrl: false, shift: false, alt: false, meta: false };
  const symbols: Record<string, keyof ModifierSet> = { "⌘": "meta", "⇧": "shift", "⌥": "alt", "⌃": "ctrl" };
  for (const char of shortcut) {
    const modifier = symbols[char];
    if (modifier) set[modifier] = true;
  }
  for (const token of shortcut.split("+").map((part) => part.trim().toLowerCase())) {
    if (token === "ctrl" || token === "macctrl" || token === "control") set.ctrl = true;
    else if (token === "shift") set.shift = true;
    else if (token === "alt" || token === "option") set.alt = true;
    else if (token === "command" || token === "cmd" || token === "meta" || token === "search") set.meta = true;
  }
  return set.ctrl || set.shift || set.alt || set.meta ? set : null;
}

export function sameModifiers(a: ModifierSet, b: ModifierSet) {
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;
}

export function uniqueModifierSets(sets: (ModifierSet | null)[]): ModifierSet[] {
  const unique: ModifierSet[] = [];
  for (const set of sets) {
    if (set && !unique.some((existing) => sameModifiers(existing, set))) unique.push(set);
  }
  return unique;
}

export function parseStoredModifierSets(value: unknown): ModifierSet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ModifierSet[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { ctrl, shift, alt, meta } = entry as Record<string, unknown>;
    return [{ ctrl: ctrl === true, shift: shift === true, alt: alt === true, meta: meta === true }];
  });
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * True when this keydown is a modifier key that completes one of the
 * shortcut modifier sets (the event's flags include the key just pressed).
 */
export function completesShortcutModifiers(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  sets: ModifierSet[],
) {
  if (!MODIFIER_KEYS.has(event.key)) return false;
  const held: ModifierSet = { ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey };
  return sets.some((set) => sameModifiers(set, held));
}
