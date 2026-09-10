/**
 * Browser-safe plan document toolkit (issue #442, release P): source
 * verification, preparation, diagram/code rendering, and the pure theme
 * table. Electron-free and node-free so the headless verifier page and the
 * renderer share one implementation.
 */
export {
  childNodesOf,
  composePlanSource,
  HTML_NS,
  insertAt,
  MATH_ML_NS,
  parsePlanSource,
  SVG_NS,
  type DefaultChildNode,
  type DefaultElement,
  type DefaultNode,
  type DefaultTextNode,
  type ParsedPlanSource,
  type PlanAttr,
  type PlanBlock,
  type PlanCodeBlock,
  type PlanDiagramBlock,
  type PlanElement,
  type PlanRange,
  type PlanReplacement,
  type PlanStructure,
} from "./plan-source";
export {
  decodeEntities,
  DiagramSyntaxError,
  escapeHtml,
  fitDarkPaint,
  planDiagramTransform,
  renderMermaid,
  type DiagramRenderer,
  type DiagramTransform,
  type PlanCanvas,
} from "./plan-diagrams";
export { planHighlightTransform, type CodeTokenizer, type HighlightTransform } from "./plan-highlight";
export {
  PLAN_DOCUMENT_CSP,
  PLAN_PREFLIGHT_WIDTHS,
  preparePlanDocument,
  preparePlanForReview,
  probePlanLayout,
  renderPlanPreflight,
  verifyPlanStructure,
  type LayoutProbe,
  type LayoutProbeResult,
  type PlanReviewOptions,
  type PreparedPlanDocument,
  type PreparedPlanState,
  type PreparedReviewOutcome,
} from "./plan-document";
export {
  ensureLang,
  ensureTheme,
  getHighlighterCore,
  HIGHLIGHT_CHAR_CAP,
  langFromPath,
  resolveLang,
  tokenizeCode,
} from "./highlight";
export {
  DEFAULT_THEME_ID,
  deriveCode,
  deriveTerminal,
  deriveTheme,
  mixHex,
  resolveTheme,
  THEMES,
  TOKEN_NAMES,
  type CodeTheme,
  type TerminalPalette,
  type Theme,
  type ThemeSource,
} from "./themes";
