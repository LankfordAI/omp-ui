import { compareVersions } from "@omp-ui/core";

export interface CommonUpdateState {
  status: string;
  latestVersion: string | null;
  progress: number | null;
  error: string | null;
}

export interface UpdateControllerDeps<T extends CommonUpdateState> {
  getDismissed: () => string | null;
  setDismissed: (version: string | null) => void;
  send: (channel: string, state: T) => void;
  channel: string;
}

/** Shared state publication and exact-version dismissal policy for updaters. */
export abstract class UpdateController<T extends CommonUpdateState> {
  state: T;

  protected constructor(
    initial: T,
    private readonly updateDeps: UpdateControllerDeps<T>,
  ) {
    this.state = initial;
  }

  protected set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch };
    this.updateDeps.send(this.updateDeps.channel, this.state);
  }

  protected offerIsDismissed(version: string, manual: boolean): boolean {
    return !manual && this.updateDeps.getDismissed() === version;
  }

  protected reapDismissed(installedVersion: string | null): void {
    if (installedVersion === null) return;
    const dismissed = this.updateDeps.getDismissed();
    if (dismissed !== null && compareVersions(dismissed, installedVersion) <= 0) {
      this.updateDeps.setDismissed(null);
    }
  }

  protected dismissState(version: string, remember: boolean, patch: Partial<T>): void {
    if (remember && version !== "") this.updateDeps.setDismissed(version);
    this.set(patch);
  }
}
