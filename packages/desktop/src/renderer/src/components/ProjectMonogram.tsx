import { cn } from "../lib/cn";
import { initials } from "../lib/initials";
import { monogramColors, projectHue } from "../lib/project-colors";

/**
 * A project's monogram box (ADR-0004 identity colour): the project's icon
 * when it has one (issue #1000), else its initials on the identity fill. An
 * icon keeps the identity hue as a ring, so two projects sharing a favicon
 * still read as different repositories.
 */
export function ProjectMonogram({
  seed,
  name,
  icon,
  className,
}: {
  /** The identity seed the hue derives from (the quick-open row id). */
  seed: string;
  name: string;
  /** `data:` URL from the owning instance, or null for initials. */
  icon: string | null;
  /** Size and corner classes; defaults to the quick-open row's box. */
  className?: string;
}) {
  const box = "grid size-6 shrink-0 place-items-center rounded-md";
  if (icon === null) {
    return (
      <span style={monogramColors(seed)} className={cn(box, "font-display text-[10px] font-semibold", className)}>
        {initials(name)}
      </span>
    );
  }
  return (
    <span
      data-project-icon
      style={{ boxShadow: `0 0 0 1.5px hsl(${projectHue(seed)} 60% 55%)` }}
      className={cn(box, "overflow-hidden bg-raised", className)}
    >
      <img src={icon} alt="" draggable={false} className="size-full object-contain" />
    </span>
  );
}
