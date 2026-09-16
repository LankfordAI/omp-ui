// Vite's `?raw` import (used by the browser pane smoke entry to inline its test page).
declare module "*.html?raw" {
  const content: string;
  export default content;
}
