/** Sessions revealed per page in a sidebar project section. */
export const PAGE = 8;

/**
 * The visible slice of one project's session list.
 *
 * `visible` is what the user asked for via "show more"; `activeIndex` (-1 when
 * the active session belongs to another project, or there is none) widens it.
 * The active row carries the selection highlight, so paging it out of sight
 * reads as the session having vanished rather than merely being unpaged.
 */
export function sessionWindow(
  count: number,
  visible: number,
  activeIndex: number,
): { shown: number; remaining: number } {
  const shown = Math.max(0, Math.min(count, Math.max(visible, activeIndex + 1)));
  return { shown, remaining: count - shown };
}
