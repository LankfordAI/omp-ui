import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { backdropFloors, type BackdropFloors } from "@omp-ui/core/theme-backdrop";
import { loadBackdropAsset, type BackdropAsset } from "../../lib/backdrop";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { Theme } from "../../lib/themes";
import { Chip, Dot, ProgressRing } from "../ui";

/**
 * Inline tokens scope every Tailwind colour utility inside the subtree to
 * `theme`: Tailwind v4 utilities dereference the @theme custom properties
 * (lib/themes.ts applyTheme comment), so bg-raised / text-ink / border-line
 * below paint the candidate theme, not the active one. Code and terminal
 * colours come from theme.code / theme.term because shiki and xterm do not
 * read CSS variables.
 */
export function specimenStyle(theme: Theme): CSSProperties {
  return { ...theme.tokens, colorScheme: theme.dark ? "dark" : "light" } as CSSProperties;
}

/** undefined asset: load the stored backdrop by hash; null: no backdrop; an asset: use it (the editor's draft). */
function useSpecimenAsset(theme: Theme, asset: BackdropAsset | null | undefined): BackdropAsset | null {
  const hash = asset === undefined ? (theme.backdrop?.assetHash ?? null) : null;
  const [loaded, setLoaded] = useState<{ hash: string; asset: BackdropAsset } | null>(null);
  useEffect(() => {
    if (hash === null) return;
    let live = true;
    loadBackdropAsset(hash).then(
      (next) => {
        if (live) setLoaded({ hash, asset: next });
      },
      () => {
        // Lite host or pruned asset: paint without it.
        if (live) setLoaded(null);
      },
    );
    return () => {
      live = false;
    };
  }, [hash]);
  if (asset !== undefined) return asset;
  return loaded !== null && loaded.hash === hash ? loaded.asset : null;
}

/** A plane's fill over the backdrop: its own colour at the reading floor, else nothing inline. */
function planeStyle(plane: "void" | "sunken" | "surface", floor: number | null): CSSProperties | undefined {
  if (floor === null) return undefined;
  return { backgroundColor: `color-mix(in srgb, var(--color-${plane}) ${floor}%, transparent)` };
}

/**
 * The backdrop's still frame, blurred once and dimmed by the void scrim:
 * style.css's .backdrop-layer / .backdrop-scrim, with this theme's values.
 * Never the animated scene: samples do not move (ADR-0094 §6, ADR-0096 §7).
 */
function SpecimenBackdrop({ stillUrl, dim, blur }: { stillUrl: string; dim: number; blur: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <img
        alt=""
        src={stillUrl}
        className="absolute max-w-none object-cover"
        style={{
          inset: `${-3 * blur}px`,
          width: `calc(100% + ${6 * blur}px)`,
          height: `calc(100% + ${6 * blur}px)`,
          filter: `blur(${blur}px)`,
        }}
      />
      <div
        className="absolute inset-0"
        style={{ backgroundColor: `color-mix(in srgb, var(--color-void) ${dim}%, transparent)` }}
      />
    </div>
  );
}

/** The card sample's one line of code, every span from theme.code (shiki reads no CSS variables). */
function CodeLine({ code }: { code: Theme["code"] }) {
  return (
    <>
      <span style={{ color: code.keyword }}>const</span>{" "}
      <span style={{ color: code.property }}>size</span>{" "}
      <span style={{ color: code.punctuation }}>=</span>{" "}
      <span style={{ color: code.function }}>measure</span>
      <span style={{ color: code.punctuation }}>(</span>
      <span style={{ color: code.string }}>&quot;card&quot;</span>
      <span style={{ color: code.punctuation }}>, </span>
      <span style={{ color: code.constant }}>42</span>
      <span style={{ color: code.punctuation }}>);</span>{" "}
      <span style={{ color: code.comment }}>
        {"// "}
        <span style={{ color: code.type }}>Size</span>
      </span>
    </>
  );
}

/** lib/themes.ts setThemePreview, five lines, coloured with every code role. */
function CodeBlock({ code }: { code: Theme["code"] }) {
  const c = (role: keyof Theme["code"], text: ReactNode) => <span style={{ color: code[role] }}>{text}</span>;
  return (
    <pre
      className="overflow-hidden rounded-lg border border-line-soft bg-sunken px-3 py-2 font-mono text-xs leading-5"
      style={{ color: code.foreground }}
    >
      {c("comment", "// Paints `theme` until cleared.")}
      {"\n"}
      {c("keyword", "export function")} {c("function", "setThemePreview")}
      {c("punctuation", "(")}theme{c("punctuation", ":")} {c("type", "Theme")} {c("punctuation", "|")}{" "}
      {c("constant", "null")}
      {c("punctuation", "):")} {c("type", "void")} {c("punctuation", "{")}
      {"\n"}
      {"  "}preview {c("punctuation", "=")} theme{c("punctuation", ";")}
      {"\n"}
      {"  "}
      {c("keyword", "if")} {c("punctuation", "(")}theme{c("punctuation", ".")}
      {c("property", "id")} {c("punctuation", "!==")} {c("string", '"graphite"')}
      {c("punctuation", ")")} {c("function", "applyTheme")}
      {c("punctuation", "(")}theme{c("punctuation", ");")}
      {"\n"}
      {c("punctuation", "}")}
    </pre>
  );
}

function CardSpecimen({ theme }: { theme: Theme }) {
  const t = useT();
  return (
    <>
      <div className="max-w-[80%] shrink-0 self-end truncate rounded-lg border border-iris-dim bg-iris-wash px-2 py-0.5">
        {t("settings.appearance.specimenUser")}
      </div>
      <p className="shrink-0 truncate text-ink-mid">{t("settings.appearance.specimenReply")}</p>
      <pre
        className="shrink-0 overflow-hidden whitespace-nowrap rounded bg-sunken px-2 py-1 font-mono text-[11px] leading-4"
        style={{ color: theme.code.foreground }}
      >
        <CodeLine code={theme.code} />
      </pre>
      <div className="mt-auto flex shrink-0 items-center justify-between rounded-md border border-line bg-raised px-2 py-1 text-ink-faint">
        <span className="truncate">{t("settings.appearance.specimenComposer")}</span>
        <Dot tone="signal" pulse />
      </div>
    </>
  );
}

function FullSpecimen({ theme, floors }: { theme: Theme; floors: BackdropFloors | null }) {
  const t = useT();
  const term = theme.term;
  const toolRow = "flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-xs";
  const sessionRow = "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs";
  return (
    <>
      <div
        className="relative col-span-full flex items-center gap-3 border-b border-line bg-void px-4"
        style={planeStyle("void", floors?.void ?? null)}
      >
        <span className="chrome-label text-ink-faint">omp-ui</span>
        <span className="truncate font-semibold">{t("settings.appearance.specimenSession")}</span>
        <span className="hidden truncate font-mono text-xs text-ink-dim sm:inline">~/Repos/omp-ui</span>
        <span className="flex-1" />
        <ProgressRing fraction={0.38} className="size-4" />
        <span className="text-xs text-ink-mid">38% · $0.42</span>
        <Chip>opus</Chip>
      </div>

      <div
        className="relative hidden flex-col gap-0.5 border-r border-line bg-sunken p-2 md:flex"
        style={planeStyle("sunken", floors?.sunken ?? null)}
      >
        <div className="mb-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-faint">
          {t("settings.appearance.search")}
        </div>
        <div className={cn(sessionRow, "bg-raised text-ink")}>
          <Dot tone="signal" pulse />
          <span className="truncate">{t("settings.appearance.specimenSession")}</span>
        </div>
        <div className={cn(sessionRow, "text-ink-mid")}>
          <Dot tone="copper" />
          <span className="truncate">{t("settings.appearance.specimenSessionPlan")}</span>
        </div>
        <div className={cn(sessionRow, "text-ink-mid")}>
          <Dot tone="neutral" />
          <span className="truncate">{t("settings.appearance.specimenSessionTests")}</span>
        </div>
        <div className={cn(sessionRow, "text-ink-mid")}>
          <Dot tone="rose" />
          <span className="truncate">{t("settings.appearance.specimenSessionFailed")}</span>
        </div>
      </div>

      <div
        className="relative flex min-h-0 min-w-0 flex-col bg-surface"
        style={planeStyle("surface", floors?.reading ?? null)}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-[56rem] flex-1 flex-col gap-3 overflow-hidden px-6 py-5">
          <div className="self-end max-w-[80%] rounded-xl border border-iris-dim bg-iris-wash px-3 py-2">
            {t("settings.appearance.specimenUser")}
          </div>
          <p className="border-l-2 border-think-cool pl-3 italic text-ink-dim">
            {t("settings.appearance.specimenThinking")}
          </p>
          <p className="text-ink">
            {t("settings.appearance.specimenReply")}{" "}
            <code className="rounded bg-hover px-1 font-mono text-xs">AppearancePage.tsx</code>
          </p>
          <div className={toolRow}>
            <span className="text-signal">✓</span>
            <span className="font-medium">read</span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-dim">settings/AppearancePage.tsx</span>
            <span className="font-mono text-ink-faint">668</span>
          </div>
          <div className={toolRow}>
            <Dot tone="signal" pulse />
            <span className="font-medium">bash</span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-dim">npm test</span>
            <span className="font-mono text-ink-faint">12s</span>
          </div>
          <CodeBlock code={theme.code} />
          <div className="overflow-hidden rounded-lg border border-line font-mono text-xs">
            <div className="bg-raised px-3 py-1 text-ink-dim">lib/themes.ts</div>
            <div className="bg-rose-wash px-3 py-0.5">- if (theme !== current) applyTheme(theme);</div>
            <div className="bg-signal-wash px-3 py-0.5">+ if (theme.rev !== current.rev) applyTheme(theme);</div>
          </div>
          <div className="rounded-lg border border-copper-dim bg-copper-wash px-3 py-2">
            {t("settings.appearance.specimenAttention")}
          </div>
          <p className="text-rose">{t("settings.appearance.specimenFailed")}</p>
        </div>
        <div className="mx-auto mb-3 w-[calc(100%-3rem)] max-w-[56rem] rounded-xl border border-line bg-raised px-3 py-2">
          <p className="text-ink-faint">{t("settings.appearance.specimenComposer")}</p>
          <div className="mt-2 flex items-center gap-2">
            <Chip>opus</Chip>
            <Chip tone="iris">{t("settings.appearance.specimenPlan")}</Chip>
            <span
              className="h-1.5 w-20 rounded-full"
              style={{ background: "linear-gradient(90deg, var(--color-think-cool), var(--color-think-warm))" }}
            />
            <span className="flex-1" />
            <span className="flex size-6 items-center justify-center rounded-full bg-ink text-surface">↑</span>
          </div>
        </div>
        <div
          className="h-[4.5rem] shrink-0 border-t border-line px-4 py-2 font-mono text-xs leading-5"
          style={{ background: term.background, color: term.foreground }}
        >
          <div>
            <span style={{ color: term.green }}>✓ 214 passed</span>{" "}
            <span style={{ color: term.red }}>✗ 1 failed</span>{" "}
            <span style={{ color: term.yellow }}>3 skipped</span>
          </div>
          <div>
            <span style={{ color: term.blue }}>~/Repos/omp-ui</span>{" "}
            <span style={{ color: term.magenta }}>main</span>{" "}
            <span style={{ color: term.cyan }}>$</span> npm run dev:headless
          </div>
        </div>
      </div>

      <div
        className="relative hidden flex-col gap-1 border-l border-line bg-sunken p-3 text-xs lg:flex"
        style={planeStyle("sunken", floors?.sunken ?? null)}
      >
        <p className="line-through text-ink-faint">✓ {t("settings.appearance.specimenTodoRead")}</p>
        <p className="flex items-center gap-2 text-ink">
          <Dot tone="copper" />
          {t("settings.appearance.specimenTodoBuild")}
        </p>
        <p className="text-ink-mid">○ {t("settings.appearance.specimenTodoPlan")}</p>
      </div>
    </>
  );
}

/**
 * A live sample of the app painted in `theme` (the theme wall's cards, the
 * theme preview and the editor's sample). Decorative: it holds no focusable
 * element, because the card variant sits inside a <button>. Only plain plane
 * utilities: glass-, chrome- and stage- utilities read root-only variables
 * that belong to the active theme.
 */
export function ThemeSpecimen(props: {
  theme: Theme;
  variant: "card" | "full";
  asset?: BackdropAsset | null;
  className?: string;
}): ReactElement {
  const { theme, variant, className } = props;
  const asset = useSpecimenAsset(theme, props.asset);
  const backdrop = asset !== null ? theme.backdrop : null;
  const floors = backdrop !== null ? backdropFloors(theme.tokens, backdrop.dim) : null;
  const layer =
    backdrop !== null && asset !== null ? (
      <SpecimenBackdrop stillUrl={asset.stillUrl} dim={backdrop.dim} blur={backdrop.blur} />
    ) : null;

  if (variant === "card") {
    return (
      <div
        aria-hidden="true"
        style={specimenStyle(theme)}
        className={cn("relative h-28 overflow-hidden rounded-md border border-line bg-void text-xs text-ink", className)}
      >
        {layer}
        <div
          className="relative flex h-full flex-col gap-1 bg-surface px-2 py-1.5"
          style={planeStyle("surface", floors?.reading ?? null)}
        >
          <CardSpecimen theme={theme} />
        </div>
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      style={specimenStyle(theme)}
      className={cn(
        "relative grid h-full grid-cols-1 grid-rows-[2.5rem_minmax(0,1fr)] overflow-hidden bg-void text-sm text-ink",
        "md:grid-cols-[14rem_minmax(0,1fr)] lg:grid-cols-[14rem_minmax(0,1fr)_15rem]",
        className,
      )}
    >
      {layer}
      <FullSpecimen theme={theme} floors={floors} />
    </div>
  );
}
