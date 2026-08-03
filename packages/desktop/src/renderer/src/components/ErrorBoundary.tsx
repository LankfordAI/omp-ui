import { Component, type ReactNode } from "react";

/**
 * React unmounts the entire root when a render error goes uncaught — one bad
 * block in one message blanks the whole window. Boundaries fence that blast
 * radius: the transcript wraps each row so a poisoned message degrades to a
 * broken-row card, and main.tsx wraps the root as the last resort.
 *
 * Deliberately no reset/retry: a row that threw once will throw again on the
 * same props, and the transcript remounts rows by key on session switch anyway.
 */
export class ErrorBoundary extends Component<
  { fallback: (error: Error) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(thrown: unknown): { error: Error } {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
