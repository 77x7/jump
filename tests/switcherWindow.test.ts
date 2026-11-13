import assert from "node:assert/strict";
import test from "node:test";
import { SWITCHER_ITEM_PITCH, SWITCHER_OVERSCAN, switcherWindow } from "../src/switcherWindow.ts";

const windowFor = (overrides: Partial<Parameters<typeof switcherWindow>[0]> = {}) =>
  switcherWindow({
    count: 40,
    activeIndex: 0,
    scrollLeft: 0,
    viewportWidth: 0,
    itemWidth: SWITCHER_ITEM_PITCH,
    overscan: SWITCHER_OVERSCAN,
    ...overrides,
  });

test("renders every card when the count is within two overscans plus one", () => {
  for (const count of [0, 1, 2, 7, 13]) {
    assert.deepEqual(windowFor({ count, activeIndex: Math.max(0, count - 1), viewportWidth: 1000, scrollLeft: 4000 }), {
      start: 0,
      end: count,
    });
  }
});

test("selection at the first card starts at zero", () => {
  assert.deepEqual(windowFor({ activeIndex: 0 }), { start: 0, end: 7 });
});

test("selection in the middle is centred on it", () => {
  assert.deepEqual(windowFor({ activeIndex: 20 }), { start: 14, end: 27 });
});

test("selection at the last card stops at the count", () => {
  assert.deepEqual(windowFor({ activeIndex: 39 }), { start: 33, end: 40 });
});

test("visible cards widen the selection window when the scroll area is elsewhere", () => {
  // Four cards fit in a 1000px track: 0-4 at the start, 20-24 at scroll 4880.
  assert.deepEqual(windowFor({ activeIndex: 20, viewportWidth: 1000, scrollLeft: 0 }), { start: 0, end: 27 });
  assert.deepEqual(windowFor({ activeIndex: 0, viewportWidth: 1000, scrollLeft: 20 * SWITCHER_ITEM_PITCH }), { start: 0, end: 31 });
});

test("a visible area overlapping the selection gives one contiguous window", () => {
  // Cards 19-23 visible, selection at 20: widened once, not twice.
  assert.deepEqual(windowFor({ activeIndex: 20, viewportWidth: 1000, scrollLeft: 19 * SWITCHER_ITEM_PITCH }), { start: 13, end: 30 });
});

test("clamps to the tab list at both ends", () => {
  assert.deepEqual(windowFor({ count: 20, activeIndex: 19, scrollLeft: 0, viewportWidth: 0 }), { start: 13, end: 20 });
  // A scroll offset past the end of the track cannot push the window out.
  assert.deepEqual(windowFor({ count: 20, activeIndex: 0, scrollLeft: 1e6, viewportWidth: 1000 }), { start: 0, end: 20 });
  // A negative scroll offset (elastic overscroll) reads as the start.
  assert.deepEqual(windowFor({ activeIndex: 30, scrollLeft: -500, viewportWidth: 488 }), { start: 0, end: 37 });
  assert.deepEqual(windowFor({ activeIndex: 30, scrollLeft: -500, viewportWidth: 0 }), { start: 24, end: 37 });
});

test("a zero viewport still renders the selection window", () => {
  // A standby palette can be measured before it is revealed.
  assert.deepEqual(windowFor({ activeIndex: 5, viewportWidth: 0, scrollLeft: 0 }), { start: 0, end: 12 });
});

test("an out-of-range selection is clamped into the tab list", () => {
  assert.deepEqual(windowFor({ activeIndex: 999 }), { start: 33, end: 40 });
  assert.deepEqual(windowFor({ activeIndex: -4 }), { start: 0, end: 7 });
});

test("falls back to the CSS card pitch when no item width was measured", () => {
  assert.equal(SWITCHER_ITEM_PITCH, 244);
  assert.deepEqual(windowFor({ itemWidth: 0, activeIndex: 0, viewportWidth: 1000 }), { start: 0, end: 11 });
  assert.deepEqual(windowFor({ itemWidth: Number.NaN, activeIndex: 0, viewportWidth: 1000 }), { start: 0, end: 11 });
});
