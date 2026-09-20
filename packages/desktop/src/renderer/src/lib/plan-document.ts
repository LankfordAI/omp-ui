/**
 * The HTML plan document pipeline (issue #312, ADR-0022, amended by the
 * issue #312 follow-up): prepare authored source into a prepared document via
 * source-range composition, verify structurally, probe real layout, and hand
 * machine diagnostics to whichever surface (or verifier) asked.
 *
 * The input contract is AUTHORED SOURCE ONLY. The prepared result is a
 * separate typed value and must never be fed back through preparation —
 * reuse the prepared document instead of preparing its generated HTML again.
 * Byte-string idempotence is deliberately gone; the authored/prepared split
 * is what keeps a plan that documents this pipeline's own markers ordinary
 * source (issue #331's text scan is retired with the marker protocol).
 *
 * Diagnostics are machine data (see `@omp-ui/core/plan`): stable codes,
 * source locations, bounded detail. Localized prose lives at the presentation
 * boundary (`PlanReview`, `PlanCard`), never in the pipeline.
 */
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import { parse } from "parse5";
import { planHighlightTransform } from "./plan-highlight";
import { planDiagramTransform, renderMermaid } from "./plan-diagrams";
import {
  childNodesOf,
  composePlanSource,
  insertAt,
  parsePlanSource,
  type DefaultElement,
  type DefaultNode,
  type DefaultTextNode,
  type ParsedPlanSource,
  type PlanReplacement,
} from "./plan-source";
import { currentThemeId, resolveTheme, type Theme } from "./themes";
import {
  CSP_META,
  GUARDRAIL_ID,
  PLAN_DOCUMENT_CSP,
  guardrailStylesheet,
} from "./plan-guardrails";


/** The plan document's typed prepared result — never authored input (§2). */
export interface PreparedPlanDocument {
  doc: string;
  diagnostics: PlanDiagnostic[];
}

/* -------------------------------------------------------------------------- */
/* Resource discovery (§2): authored external dependencies fail as source      */
/* diagnostics instead of letting the verifier navigate or fetch them.         */
/* -------------------------------------------------------------------------- */

const URL_ATTRS: Record<string, Record<string, string>> = {
  script: { src: "script resource" },
  link: { href: "stylesheet or link resource" },
  img: { src: "image resource" },
  audio: { src: "audio resource", poster: "audio poster" },
  video: { src: "video resource", poster: "video poster" },
  source: { src: "media source" },
  track: { src: "media track" },
  embed: { src: "embed resource" },
  object: { data: "object resource" },
  iframe: { src: "nested document" },
};

/** `data:` and fragment targets need no network; everything else fetches. */
function isSelfContainedUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("data:")) return true;
  return false;
}

function walkAll(node: DefaultNode, visit: (el: DefaultElement) => void): void {
  for (const child of childNodesOf(node)) {
    const el = child as DefaultElement;
    if (el.tagName === undefined) {
      walkAll(child, visit);
      continue;
    }
    // Template CONTENT is inert; parse5 keeps it off childNodes, and foreign
    // subtrees still expose their own resource elements (svg image/script).
    visit(el);
    walkAll(child, visit);
    // parse5 attaches template content as a `content` member the default
    // tree adapter type does not expose structurally.
    const content = (el as Partial<{ content: DefaultNode }>).content;
    if (content !== undefined) walkAll(content, visit);
  }
}

/** Scan a url()-bearing declaration value; data: values are allowed. */
function declaredUrls(style: string): string[] {
  const urls: string[] = [];
  const pattern = /url\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(style)) !== null) {
    const raw = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!isSelfContainedUrl(raw)) urls.push(raw);
  }
  return urls;
}

/**
 * The CSS dependency scan uses the browser's parsed rules (imports and
 * declarations alike) and reports at the OWNING style block or style
 * attribute — never a guessed token column (§2).
 */
function cssDependencyDiagnostics(parsed: ParsedPlanSource): PlanDiagnostic[] {
  const out: PlanDiagnostic[] = [];
  const located = (
    el: DefaultElement,
    detail: string,
    message: string,
  ): PlanDiagnostic => {
    const loc = el.sourceCodeLocation;
    const diag: PlanDiagnostic = {
      code: "EXTERNAL_RESOURCE",
      stage: "source",
      repair: "source",
      severity: "error",
      message,
      detail,
    };
    if (loc && loc.startOffset >= 0) {
      diag.location = {
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
        line: loc.startLine,
        column: loc.startCol,
      };
    }
    return diag;
  };
  const urlsOfParsedSheet = (text: string): string[] => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      const found: string[] = [];
      const visitRules = (rules: Iterable<CSSRule>): void => {
        for (const rule of rules) {
          if (rule instanceof CSSImportRule) {
            if (!isSelfContainedUrl(rule.href)) found.push(rule.href);
            if (rule.styleSheet) visitRules(rule.styleSheet.cssRules);
            continue;
          }
          if (rule instanceof CSSStyleRule) {
            const style = rule.style;
            for (let i = 0; i < style.length; i += 1) {
              const prop = style.item(i);
              const value = style.getPropertyValue(prop);
              found.push(...declaredUrls(`${prop}: ${value}`));
            }
          }
          if ("cssRules" in rule) {
            // Grouped rules (media/container layers) hold nested rules; the
            // CSSOM type for that is not inferrable from the union member.
            const grouping = rule as CSSGroupingRule;
            visitRules(grouping.cssRules);
          }
        }
      };
      visitRules(sheet.cssRules);
      return found;
    } catch {
      // No parsable sheet (jsdom without the CSSOM constructor): fall back to
      // a raw scan of the block text, which misses nothing plan authors write.
      return declaredUrls(text);
    }
  };
  walkAll(parsed.document, (el) => {
    if (el.tagName === "style" && el.sourceCodeLocation) {
      const text = (el.childNodes ?? [])
        .map((c) => (c.nodeName === "#text" ? (c as DefaultTextNode).value : ""))
        .join("");
      const urls = urlsOfParsedSheet(text);
      for (const url of urls) {
        out.push(
          located(el, `url(${url})`, "a stylesheet references a resource the plan document cannot fetch"),
        );
      }
      return;
    }
    const styleAttr = (el.attrs ?? []).find((a) => a.name === "style");
    if (styleAttr !== undefined) {
      for (const url of urlsOfParsedSheet(styleAttr.value)) {
        out.push(
          located(el, `url(${url})`, "an inline style references a resource the plan document cannot fetch"),
        );
      }
    }
  });
  return out;
}

/** Element-level resource and refresh-meta scan of the authored document. */
function elementResourceDiagnostics(parsed: ParsedPlanSource): PlanDiagnostic[] {
  const out: PlanDiagnostic[] = [];
  walkAll(parsed.document, (el) => {
    const loc = el.sourceCodeLocation;
    const push = (detail: string, message: string): void => {
      const diag: PlanDiagnostic = {
        code: "EXTERNAL_RESOURCE",
        stage: "source",
        repair: "source",
        severity: "error",
        message,
        detail,
      };
      if (loc && loc.startOffset >= 0) {
        diag.location = {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          line: loc.startLine,
          column: loc.startCol,
        };
      }
      out.push(diag);
    };
    const attrs = el.attrs ?? [];
    if (el.tagName === "meta") {
      const equiv = attrs.find((a) => a.name === "http-equiv")?.value.toLowerCase();
      if (equiv === "refresh") {
        push("meta http-equiv=refresh", "a refresh meta tag would navigate the document; navigation is not allowed");
        return;
      }
    }
    const byAttr = URL_ATTRS[el.tagName];
    if (byAttr !== undefined) {
      for (const attr of attrs) {
        const label = byAttr[attr.name];
        if (label === undefined) continue;
        if (!isSelfContainedUrl(attr.value)) {
          push(`${el.tagName}[${attr.name}]=${attr.value.slice(0, 200)}`, `the document depends on an external ${label}`);
        }
      }
    }
    // SVG hrefs fetch too (image/xlink:href, a is excluded below).
    if (el.namespaceURI !== undefined && el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      for (const attr of attrs) {
        if ((attr.name === "href" || attr.name.endsWith(":href")) && el.tagName !== "a") {
          if (!isSelfContainedUrl(attr.value)) {
            push(`${el.tagName}[${attr.name}]=${attr.value.slice(0, 200)}`, "the document depends on an external resource");
          }
        }
      }
    }
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Structure composition (§2): guardrail + CSP ride insertion ranges, never   */
/* replacement-template expansion.                                           */
/* -------------------------------------------------------------------------- */

function structureReplacements(
  parsed: ParsedPlanSource,
  stylesheet: string,
): PlanReplacement[] {
  const { structure } = parsed;
  if (structure.closingHeadOffset !== null) {
    // Both generated parts before the explicit `</head>`; the guardrail
    // stays the final stylesheet of the head (§ guardrail note).
    return [insertAt(structure.closingHeadOffset, CSP_META + stylesheet)];
  }
  const out: PlanReplacement[] = [];
  const styleAt = structure.closingBodyOffset ?? structure.eofOffset;
  out.push(insertAt(styleAt, stylesheet));
  if (structure.hasExplicitHtml && structure.afterHtmlOpen !== null) {
    out.push(insertAt(structure.afterHtmlOpen, `<head>${CSP_META}</head>`));
  } else {
    // A bare fragment: prepend the generated head before any authored bytes.
    out.push(insertAt(0, `<head>${CSP_META}</head>`));
  }
  return out;
}

/**
 * Structural verification of a PREPARED document (§3): the generated policy
 * and style are verified by querying the parsed result — not by searching
 * prose for their ids — plus the no-visible-content catch that used to read
 * raw bytes. Returns diagnostics; empty means the document is structurally
 * sound and the surfaces may show it (pending layout).
 */
export function verifyPlanStructure(prepared: string): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  let doc: DefaultNode;
  try {
    doc = parse(prepared, { scriptingEnabled: false });
  } catch (err) {
    return [
      {
        code: "RENDER_INVARIANT",
        stage: "prepare",
        repair: "application",
        severity: "error",
        message: "the prepared document does not parse",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      },
    ];
  }
  let cspSeen = false;
  let guardrailSeen = false;
  let visibleText = false;
  let mediaSeen = false;
  const skip = new Set(["script", "style", "template", "noscript"]);
  const walk = (node: DefaultNode): void => {
    for (const child of childNodesOf(node)) {
      const el = child as DefaultElement;
      if (el.tagName !== undefined) {
        const attrs = el.attrs ?? [];
        if (el.tagName === "style" && attrs.some((a) => a.name === "id" && a.value === GUARDRAIL_ID)) {
          guardrailSeen = true;
        }
        if (
          el.tagName === "meta" &&
          attrs.some((a) => a.name === "http-equiv" && a.value.toLowerCase() === "content-security-policy") &&
          attrs.some((a) => a.name === "content" && a.value === PLAN_DOCUMENT_CSP)
        ) {
          cspSeen = true;
        }
        if (["svg", "img", "canvas", "video"].includes(el.tagName)) mediaSeen = true;
        if (skip.has(el.tagName)) continue;
        walk(child);
        continue;
      }
      if (child.nodeName === "#text" && (child as DefaultTextNode).value.trim() !== "") {
        visibleText = true;
      }
    }
  };
  walk(doc);
  if (!cspSeen) {
    diagnostics.push({
      code: "RENDER_INVARIANT",
      stage: "prepare",
      repair: "application",
      severity: "error",
      message: "the prepared document is missing the plan CSP",
    });
  }
  if (!guardrailSeen) {
    diagnostics.push({
      code: "RENDER_INVARIANT",
      stage: "prepare",
      repair: "application",
      severity: "error",
      message: "the prepared document is missing the readability guardrail",
    });
  }
  if (!visibleText && !mediaSeen) {
    // Catches content swallowed by an unclosed comment and content the parser
    // relocated away from the body: the two observed blank-frame classes.
    diagnostics.push({
      code: "EMPTY_DOCUMENT",
      stage: "prepare",
      repair: "source",
      severity: "error",
      message: "the document body has no visible content",
    });
  }
  return diagnostics;
}

/**
 * Prepares an authored HTML plan: parse once, splice highlighted code and
 * rendered diagrams onto their original ranges, insert the guardrail and the
 * plan CSP as composition parts, and verify the composed result structurally.
 * Never rejects: every failure mode is a diagnostic; unchanged source slices
 * survive byte-for-byte and transformed code keeps its decoded text — dollar
 * sequences, Unicode, and trailing newlines included (issue #412).
 */
export async function preparePlanDocument(
  html: string,
  theme: Theme = resolveTheme(currentThemeId()),
): Promise<PreparedPlanDocument> {
  let parsed: ParsedPlanSource;
  try {
    parsed = parsePlanSource(html);
  } catch (err) {
    return {
      doc: "",
      diagnostics: [
        {
          code: "RENDER_INVARIANT",
          stage: "prepare",
          repair: "application",
          severity: "error",
          message: "the authored document could not be parsed",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        },
      ],
    };
  }
  const resources = [
    ...elementResourceDiagnostics(parsed),
    ...cssDependencyDiagnostics(parsed),
  ];
  const [highlight, diagrams] = await Promise.all([
    planHighlightTransform(parsed, theme),
    planDiagramTransform(parsed, renderMermaid, {
      dark: theme.dark,
      surface: theme.tokens["--color-surface"],
      ink: theme.tokens["--color-ink"],
    }),
  ]);
  const stylesheet = guardrailStylesheet(theme, highlight.tokenCss);
  const replacements = [
    ...highlight.replacements,
    ...diagrams.replacements,
    ...structureReplacements(parsed, stylesheet),
  ];
  let doc: string;
  try {
    doc = composePlanSource(html, replacements);
  } catch (err) {
    return {
      doc: "",
      diagnostics: parsed.diagnostics.concat(resources, diagrams.diagnostics, [
        {
          code: "RENDER_INVARIANT",
          stage: "prepare",
          repair: "application",
          severity: "error",
          message: "document composition failed",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        },
      ]),
    };
  }
  return {
    doc,
    diagnostics: [
      ...parsed.diagnostics,
      ...resources,
      ...diagrams.diagnostics,
      ...verifyPlanStructure(doc),
    ],
  };
}

/** Prepared-document state exposed to the plan surfaces (§3). */
export type PreparedPlanState =
  | { status: "pending" }
  | { status: "ready"; doc: string; diagnostics: PlanDiagnostic[]; identity?: string }
  | { status: "failed"; doc: string | null; diagnostics: PlanDiagnostic[]; identity?: string }
  | {
      status: "unavailable";
      doc: string | null;
      diagnostics: PlanDiagnostic[];
      identity?: string;
    };



