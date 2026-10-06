import type { ReactNode } from "react";
import { Label } from "./ui";

/** One titled block of an inspector rail pane. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <Label className="min-w-0 flex-1 truncate">{title}</Label>
        {action}
      </div>
      {children}
    </section>
  );
}
