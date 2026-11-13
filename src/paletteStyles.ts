import cssText from "./styles.css?inline";

// The palette's stylesheet, parsed once per document and adopted by every
// palette shadow root: the in-page overlay (content.tsx) and the toolbar popup
// (palettePopup.tsx) render with exactly the same styles.
let paletteSheet: CSSStyleSheet | undefined;
export function paletteStyles() {
  if (!paletteSheet) {
    paletteSheet = new CSSStyleSheet();
    paletteSheet.replaceSync(cssText);
  }
  return paletteSheet;
}
