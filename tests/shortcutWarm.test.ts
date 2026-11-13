import assert from "node:assert/strict";
import test from "node:test";
import { completesShortcutModifiers, parseShortcutModifiers, parseStoredModifierSets, uniqueModifierSets } from "../src/shortcutWarm.ts";

const none = { ctrl: false, shift: false, alt: false, meta: false };

test("parses Windows/Linux shortcut strings, including user-chosen ones", () => {
  assert.deepEqual(parseShortcutModifiers("Ctrl+Shift+P"), { ...none, ctrl: true, shift: true });
  assert.deepEqual(parseShortcutModifiers("Alt+Q"), { ...none, alt: true });
  assert.deepEqual(parseShortcutModifiers("Ctrl+T"), { ...none, ctrl: true });
  assert.deepEqual(parseShortcutModifiers("Ctrl+Alt+Shift+9"), { ...none, ctrl: true, alt: true, shift: true });
});

test("parses macOS symbol shortcuts", () => {
  assert.deepEqual(parseShortcutModifiers("⇧⌘P"), { ...none, shift: true, meta: true });
  assert.deepEqual(parseShortcutModifiers("⌃⌥K"), { ...none, ctrl: true, alt: true });
});

test("unset or modifier-less shortcuts give nothing", () => {
  assert.equal(parseShortcutModifiers(""), null);
  assert.equal(parseShortcutModifiers(undefined), null);
  assert.equal(parseShortcutModifiers("F5"), null);
});

test("a modifier keydown completes only an exact set", () => {
  const sets = uniqueModifierSets([parseShortcutModifiers("Ctrl+T"), parseShortcutModifiers("Ctrl+T")]);
  assert.equal(sets.length, 1);
  assert.equal(completesShortcutModifiers({ key: "Control", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, sets), true);
  assert.equal(completesShortcutModifiers({ key: "Shift", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, sets), false);
  assert.equal(completesShortcutModifiers({ key: "t", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, sets), false);
  const ctrlShift = [parseShortcutModifiers("Ctrl+Shift+P")!];
  assert.equal(completesShortcutModifiers({ key: "Control", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, ctrlShift), false);
  assert.equal(completesShortcutModifiers({ key: "Shift", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, ctrlShift), true);
  assert.equal(completesShortcutModifiers({ key: "Control", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, []), false);
});

test("stored sets are sanitised", () => {
  assert.deepEqual(parseStoredModifierSets([{ ctrl: true, shift: "yes" }, null, 3]), [{ ...none, ctrl: true }]);
  assert.deepEqual(parseStoredModifierSets("nope"), []);
});
