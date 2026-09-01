/**
 * Cap on listed project files; the mention picker's footer reports
 * truncation past this.
 *
 * Node-free on purpose: `project-files.ts` needs node builtins for the walk,
 * but the renderer only displays the cap, and the web bundle (ADR-0002)
 * cannot include node imports. Both sides import the constant from here.
 */
export const MAX_PROJECT_FILES = 10_000;
