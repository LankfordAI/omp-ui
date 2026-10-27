import type {
  AsyncJobWidget,
  AsyncJobWidgetBlock,
  AsyncJobWidgetHeadline,
  AsyncJobWidgetMark,
} from "@omp-ui/core/async-jobs";
import { JOB_WIDGET_GLANCE_POINTS, JOB_WIDGET_TONE, isJobWidgetBlock, jobWidgetFigure } from "../lib/async-jobs";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import type { Tone } from "../lib/tone";
import { Dot } from "./ui";
import { TONE_DOT, TONE_TEXT } from "./ui/tone";

/** A spark series as a polyline in its own [min, max] frame; marks are dashed rules. */
export function JobSparkline({
  values,
  min,
  max,
  marks = [],
  tone,
  label,
  className,
}: {
  values: readonly number[];
  min: number;
  max: number;
  marks?: readonly AsyncJobWidgetMark[];
  tone: Tone;
  label: string;
  className?: string;
}) {
  const span = max - min;
  const y = (value: number): number => 24 - ((Math.min(max, Math.max(min, value)) - min) / span) * 24;
  const points =
    values.length === 1
      ? `0,${y(values[0]!).toFixed(2)} 100,${y(values[0]!).toFixed(2)}`
      : values.map((value, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label={label} className={cn("block", TONE_TEXT[tone], className)}>
      {marks.map((mark, i) => (
        <line key={i} x1={0} x2={100} y1={y(mark.value)} y2={y(mark.value)} stroke="currentColor" strokeOpacity={0.45}
          strokeDasharray="3 3" vectorEffect="non-scaling-stroke">
          <title>{mark.label}</title>
        </line>
      ))}
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A fixed-hue fill bar. Not ui/Meter: Meter escalates to rose past 90%,
 *  which reads a nearly finished job as an alarm. */
function WidgetBar({ fraction, tone, className }: { fraction: number; tone: Tone; className?: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div className={cn("relative h-1 w-full overflow-hidden rounded-full bg-line", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", TONE_DOT[tone])} style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/** A subagent's own completion estimate: copper ring plus the number. */
export function CompletionRing({ percent }: { percent: number }) {
  const t = useT();
  const label = t("rail.jobs.completion", { percent });
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const fraction = Math.min(100, Math.max(0, percent)) / 100;
  return (
    <span className="inline-flex items-center gap-0.5" title={label}>
      <svg viewBox="0 0 16 16" role="img" aria-label={label} className="size-3 shrink-0 -rotate-90">
        <circle cx="8" cy="8" r={r} fill="none" strokeWidth={2} className="stroke-line" />
        {fraction > 0 && (
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth={2} strokeLinecap="round" className="stroke-copper"
            strokeDasharray={`${fraction * circumference} ${circumference}`} />
        )}
      </svg>
      {percent}%
    </span>
  );
}

function WidgetFigure({ figure }: { figure: AsyncJobWidgetHeadline }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      {figure.label !== null && <span className="truncate text-ink-faint">{figure.label}</span>}
      <span className="shrink-0 font-mono font-semibold text-ink">{figure.text}</span>
      {figure.trend !== null && (
        <span className={cn("shrink-0 font-mono", TONE_TEXT[JOB_WIDGET_TONE[figure.trend.tone]])}>{figure.trend.text}</span>
      )}
    </span>
  );
}

/** The collapsed row's glance: figure plus the first spark (last 16 points), else the first meter. */
export function JobWidgetGlance({ widget }: { widget: AsyncJobWidget }) {
  const figure = jobWidgetFigure(widget);
  const spark = widget.blocks.find(isJobWidgetBlock("spark")) ?? null;
  const meter = spark === null ? (widget.blocks.find(isJobWidgetBlock("meter")) ?? null) : null;
  if (figure === null && spark === null && meter === null) return null;
  return (
    <div data-job-widget-glance title={widget.title} className="mt-1 flex min-w-0 items-center gap-1.5 pl-3 text-[10px]">
      {figure !== null && <WidgetFigure figure={figure} />}
      {spark !== null && (
        <JobSparkline values={spark.values.slice(-JOB_WIDGET_GLANCE_POINTS)} min={spark.min} max={spark.max}
          tone={JOB_WIDGET_TONE[spark.tone ?? "accent"]} label={`${spark.label} ${spark.last}`} className="h-3 w-16 shrink-0" />
      )}
      {meter !== null && (
        <span className="w-16 shrink-0" title={`${meter.label} ${meter.text}`}>
          <WidgetBar fraction={meter.value} tone={JOB_WIDGET_TONE[meter.tone ?? "accent"]} />
        </span>
      )}
    </div>
  );
}

function BlockHead({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[10px]">
      <span className="truncate text-ink-faint">{label}</span>
      {value !== undefined && <span className="shrink-0 font-mono text-ink-mid">{value}</span>}
    </div>
  );
}

function WidgetBlock({ block }: { block: AsyncJobWidgetBlock }) {
  switch (block.kind) {
    case "spark":
      return (
        <div>
          <BlockHead label={block.label} value={block.last} />
          <JobSparkline values={block.values} min={block.min} max={block.max} marks={block.marks}
            tone={JOB_WIDGET_TONE[block.tone ?? "accent"]} label={`${block.label} ${block.last}`} className="h-6 w-full" />
        </div>
      );
    case "bars":
      return (
        <div>
          <BlockHead label={block.label} />
          <ul className="space-y-0.5">
            {block.items.map((item, i) => (
              <li key={i} className="grid grid-cols-[minmax(0,6rem)_1fr_auto] items-center gap-1.5 text-[10px]">
                <span className="truncate text-ink-dim" title={item.label}>{item.label}</span>
                <WidgetBar fraction={item.value / block.max} tone={JOB_WIDGET_TONE[item.tone ?? "accent"]} />
                <span className="font-mono text-ink-mid">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "meter":
      return (
        <div>
          <BlockHead label={block.label} value={block.text} />
          <WidgetBar fraction={block.value} tone={JOB_WIDGET_TONE[block.tone ?? "accent"]} />
        </div>
      );
    case "stat":
      return (
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
          {block.items.map((item, i) => (
            <div key={i} className="flex items-baseline gap-1">
              <dt className="text-ink-faint">{item.label}</dt>
              <dd className="font-mono text-ink">
                {item.text}
                {item.trend !== null && (
                  <span className={cn("ml-1", TONE_TEXT[JOB_WIDGET_TONE[item.trend.tone]])}>{item.trend.text}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "grid":
      return (
        <div>
          <BlockHead label={block.label} />
          <ul className="flex flex-wrap gap-1">
            {block.items.map((item, i) => (
              <li key={i} title={`${item.label}: ${item.text}`}
                className="flex max-w-full items-center gap-1 rounded border border-line px-1 text-[10px]">
                <Dot tone={JOB_WIDGET_TONE[item.tone]} />
                <span className="truncate text-ink-dim">{item.label}</span>
                <span className="truncate font-mono text-ink-mid">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "text":
      return <p className="whitespace-pre-wrap break-words text-[10px] text-ink-mid">{block.text}</p>;
  }
}

/** The expanded row: the widget's title and every block, in omp's order. */
export function JobWidgetBlocks({ widget }: { widget: AsyncJobWidget }) {
  return (
    <section data-job-widget aria-label={widget.title} className="mt-1 space-y-1.5 pl-3">
      <h4 className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">{widget.title}</h4>
      {widget.blocks.map((block, index) => (
        <WidgetBlock key={`${index}-${block.kind}`} block={block} />
      ))}
    </section>
  );
}
