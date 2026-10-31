/**
 * Shim-swap test fixture (issue #1010): imports the REAL desktop
 * browser-pane-contents module by path. The gate plugin must redirect that
 * resolution to the headless shim — so this bundle builds even though the
 * desktop file imports Electron at runtime, and calling through the swapped
 * exports degrades the way shims/README.md documents (factory throws on first
 * pane; partition clear is inert). Proves the swap map actually covers the
 * desktop path, not just that electron stayed out.
 */
import {
  clearBrowserPanePartition,
  makeElectronPaneFactory,
} from "../../../../desktop/src/main/browser-pane-contents";

export { clearBrowserPanePartition, makeElectronPaneFactory };
