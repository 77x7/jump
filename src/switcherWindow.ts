/**
 * Which tab-switcher cards are worth rendering.
 *
 * A switcher palette is built ahead of time in every page (standby palettes in
 * content.tsx), so rendering a card for every tab costs every open page hundreds
 * of DOM nodes and megabytes of heap for cards nobody ever sees. The rendered
 * window is the union of the cards around the selection (so the selected card
 * is always mountable and `scrollIntoView` finds it) and the cards intersecting
 * the visible scroll area, widened by an overscan of cards on each side so a
 * scroll in either direction reveals content before it is needed. The two are
 * separate ranges when far apart: scrolling far from the selection must not
 * render every card in between.
 *
 * Pure: no DOM access, so it is unit tested directly.
 */

/** Cards rendered beyond each end of the selection and the visible area. */
export const SWITCHER_OVERSCAN = 6;

/** `.switcher-card` width in src/styles.css. */
export const SWITCHER_CARD_WIDTH = 228;

/** `.switcher-track` gap in src/styles.css. */
export const SWITCHER_TRACK_GAP = 16;

/** Card pitch (width + gap) used until the first card is measured. */
export const SWITCHER_ITEM_PITCH = SWITCHER_CARD_WIDTH + SWITCHER_TRACK_GAP;

export type SwitcherWindowInput = {
  /** Number of tabs (cards) in total. */
  count: number;
  /** Index of the selected tab. */
  activeIndex: number;
  /** Track scroll offset in pixels. */
  scrollLeft: number;
  /** Track viewport width in pixels. */
  viewportWidth: number;
  /** Card width plus track gap in pixels. */
  itemWidth: number;
  /** Cards rendered beyond the selection and the visible area. */
  overscan: number;
};

export type SwitcherWindowRange = {
  /** First rendered card index. */
  start: number;
  /** One past the last rendered card index. */
  end: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function switcherWindow(input: SwitcherWindowInput): SwitcherWindowRange[] {
  const { count, overscan } = input;
  const total = Math.max(0, Math.floor(count));
  if (total === 0) return [];
  const pad = Math.max(0, Math.floor(overscan));
  // Few enough cards that rendering them all is the same as rendering a window:
  // keep the exact markup the switcher has always had.
  if (total <= 2 * pad + 1) return [{ start: 0, end: total }];

  const pitch = input.itemWidth > 0 ? input.itemWidth : SWITCHER_ITEM_PITCH;
  const active = clamp(Math.floor(input.activeIndex), 0, total - 1);
  const ranges = [{ start: active - pad, end: active + pad + 1 }];
  const width = Math.max(0, input.viewportWidth);
  if (width > 0) {
    const left = Math.max(0, input.scrollLeft);
    ranges.push({ start: Math.floor(left / pitch) - pad, end: Math.floor((left + width) / pitch) + pad + 1 });
  }

  // Clamp, sort, and merge ranges that overlap or touch.
  const merged: SwitcherWindowRange[] = [];
  for (const range of ranges
    .map(({ start, end }) => ({ start: clamp(start, 0, total), end: clamp(end, 0, total) }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

/** Identifies a window, to tell when a scroll changed it. */
export function switcherWindowKey(ranges: SwitcherWindowRange[]) {
  return ranges.map(({ start, end }) => `${start}-${end}`).join(",");
}
