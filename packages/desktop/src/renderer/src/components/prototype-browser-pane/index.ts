// PROTOTYPE (#527) — throwaway. Three variants of the browser pane inside the
// live rpc-ui tab, switchable via ?variant=A|B|C and the floating bar: A split
// beside the transcript, B sixth inspector-rail pane, C full-column view.
export { BrowserPaneBody, IconBrowserPaths } from "./pane";
export {
  PROTOTYPE_ACTIVE,
  setPaneOpen,
  toggleBrowserPane,
  useBrowserPane,
  usePrototypeVariant,
} from "./state";
export { PrototypeSwitcher } from "./switcher";
export { BrowserPaneSheetAction, BrowserPaneToggle } from "./toggles";
export { BrowserColumnView, BrowserSplit } from "./variants";
