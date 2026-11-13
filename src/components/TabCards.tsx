import { PinIcon } from "../icons";
import type { PaletteTab } from "../types";
import { TabFavicon, TabSoundIndicator } from "./TabVisuals";

type CardProps = {
  tab: PaletteTab;
  index: number;
  isSelected: boolean;
  previewUrl?: string;
  /** Total number of options, for assistive tech (the list is windowed). */
  setSize?: number;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onToggleMute?: () => void;
  /** Middle click: close the tab. */
  onCloseTab?: () => void;
};

/**
 * Middle click closes a tab, as on Chrome's own tab strip. Its mouse down and
 * mouse up are cancelled too: the down would start autoscroll, and on Linux
 * the up pastes the selected text into the focused search box.
 */
export function middleClickProps(onMiddleClick?: () => void) {
  if (!onMiddleClick) return {};
  const cancelMiddle = (event: { button: number; preventDefault(): void }) => {
    if (event.button === 1) event.preventDefault();
  };
  return {
    onMouseDown: cancelMiddle,
    onMouseUp: cancelMiddle,
    onAuxClick: (event: { button: number; preventDefault(): void; stopPropagation(): void }) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onMiddleClick();
    },
  };
}

export function SwitcherCard({ tab, isSelected, previewUrl, index, setSize, onClick, onMouseEnter, onToggleMute, onCloseTab }: CardProps) {
  const effectivePreview = previewUrl;
  return (
    <div
      data-switcher-index={index}
      className={`switcher-card ${isSelected ? "is-selected" : ""}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      {...middleClickProps(onCloseTab)}
      role="option"
      aria-selected={isSelected}
      aria-setsize={setSize}
      aria-posinset={index + 1}
    >
      <div className="switcher-plate">
        <div className="switcher-thumbnail">
          {effectivePreview ? <img src={effectivePreview} alt="" className="switcher-thumbnail-image" loading="eager" decoding="async" /> : (
            <div className="switcher-placeholder">
              <div className="switcher-placeholder-icon"><TabFavicon tab={tab} size={32} /></div>
              <span className="switcher-placeholder-domain">{tab.hostname || "Web Page"}</span>
            </div>
          )}
        </div>
        <div className="switcher-card-footer">
          <TabFavicon tab={tab} size={16} />
          <span className="switcher-card-title">{tab.title}</span>
          {tab.pinned && <PinIcon className="tab-pinned-icon" size={12} />}
          <TabSoundIndicator tab={tab} onToggleMute={onToggleMute} />
        </div>
      </div>
    </div>
  );
}

export function GalleryCard({ tab, index, isSelected, previewUrl, onClick, onMouseEnter, onToggleMute, onCloseTab }: CardProps) {
  const effectivePreview = previewUrl;
  return (
    <div data-index={index} className={`gallery-card ${isSelected ? "selected" : ""}`} onClick={onClick} onMouseEnter={onMouseEnter} {...middleClickProps(onCloseTab)} role="option" aria-selected={isSelected}>
      <div className="gallery-thumbnail">
        {effectivePreview ? <img src={effectivePreview} alt="" className="gallery-thumbnail-image" loading="eager" decoding="async" /> : (
          <div className="gallery-placeholder">
            <TabFavicon tab={tab} size={28} />
            <span className="gallery-placeholder-domain">{tab.hostname || "Web Page"}</span>
          </div>
        )}
      </div>
      <div className="gallery-meta">
        <div className="gallery-meta-left">
          <TabFavicon tab={tab} size={15} />
          <span className="gallery-title">{tab.title}</span>
          {tab.pinned && <PinIcon className="tab-pinned-icon" size={12} />}
          <TabSoundIndicator tab={tab} onToggleMute={onToggleMute} />
        </div>
        {tab.hostname && <span className="gallery-domain">{tab.hostname}</span>}
      </div>
    </div>
  );
}
