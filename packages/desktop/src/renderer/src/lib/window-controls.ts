import { IS_MAC, IS_WINDOWS } from "./platform";

// The native overlay rect is composited over the strip's right end; reserve
// its width so bar content never slides under the min/max/close buttons.
// 138 = 3×46px Windows caption buttons. On Linux the GTK theme paints them
// (~44px each under adwaita) and no API reports the width, so 132 is a
// visual-fit value — if a theme draws wider buttons, adjust this one line.
// macOS paints no overlay; its traffic lights sit top-left, so the inset
// moves to the left edge instead.
// Both insets are Electron-only: the remote web client (#37) serves this same
// bundle to a browser tab, where there are no caption buttons to avoid, so
// every use is gated on IS_ELECTRON (#122).
// Full-window top-layer dialogs (the Artifacts library's expanded preview, an
// expanded managed transcript artifact) sit under the same overlay and reserve
// the same inset for their controls.
export const OVERLAY_INSET = IS_MAC ? 0 : IS_WINDOWS ? 138 : 132;
export const TRAFFIC_LIGHT_INSET = IS_MAC ? 78 : 0;
