import type { ProjectOpenAvailability, ProjectOpenTarget } from "@omp-ui/core";
import { app, shell } from "electron";

const VSCODE_PROTOCOL_URL = "vscode://file/";

export interface ProjectOpenHost {
  getApplicationNameForProtocol(url: string): string;
  openExternal(url: string): Promise<void>;
  openPath(projectPath: string): Promise<string>;
}

const electronHost: ProjectOpenHost = {
  getApplicationNameForProtocol: (url) => app.getApplicationNameForProtocol(url),
  openExternal: (url) => shell.openExternal(url),
  openPath: (projectPath) => shell.openPath(projectPath),
};

/** Builds a stable-VS-Code protocol URL without treating any path segment as URL syntax. */
export function vscodeProjectUrl(projectPath: string): string {
  let normalized = projectPath.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;

  const segments = normalized.split("/").map((segment, index) => {
    if (index === 1 && /^[A-Za-z]:$/.test(segment)) {
      return `${segment[0].toLowerCase()}:`;
    }
    return encodeURIComponent(segment);
  });

  return `vscode://file${segments.join("/")}`;
}


export class ProjectOpener {
  private vsCodeAvailable: boolean | undefined;

  constructor(private readonly host: ProjectOpenHost = electronHost) {}

  availability(): ProjectOpenAvailability {
    if (this.vsCodeAvailable === undefined) {
      try {
        this.vsCodeAvailable =
          this.host.getApplicationNameForProtocol(VSCODE_PROTOCOL_URL) !== "";
      } catch {
        this.vsCodeAvailable = false;
      }
    }
    return { vsCode: this.vsCodeAvailable };
  }

  async open(projectPath: string, target: ProjectOpenTarget): Promise<void> {
    switch (target) {
      case "vscode":
        await this.openInVsCode(projectPath);
        return;
      case "files":
        await this.openInFiles(projectPath);
        return;
      default:
        throw new Error(`Unknown project open target: ${String(target)}`);
    }
  }

  private async openInVsCode(projectPath: string): Promise<void> {
    if (!this.availability().vsCode) {
      throw new Error(
        `VS Code is not available to open "${projectPath}". Open the project in Files instead.`,
      );
    }

    const url = vscodeProjectUrl(projectPath);
    let firstCause: unknown;
    try {
      await this.host.openExternal(url);
      return;
    } catch (cause) {
      firstCause = cause;
    }

    this.vsCodeAvailable = undefined;
    if (this.availability().vsCode) {
      try {
        await this.host.openExternal(url);
        return;
      } catch (cause) {
        this.vsCodeAvailable = undefined;
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Could not open "${projectPath}" in VS Code: ${detail}. Open the project in Files instead.`,
          { cause },
        );
      }
    }

    this.vsCodeAvailable = undefined;
    const detail = firstCause instanceof Error ? firstCause.message : String(firstCause);
    throw new Error(
      `Could not open "${projectPath}" in VS Code: ${detail}. Open the project in Files instead.`,
      { cause: firstCause },
    );
  }

  private async openInFiles(projectPath: string): Promise<void> {
    let failure: string;
    try {
      failure = await this.host.openPath(projectPath);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Could not open "${projectPath}" in the system file manager: ${detail}.`,
        { cause },
      );
    }
    if (failure !== "") {
      throw new Error(
        `Could not open "${projectPath}" in the system file manager: ${failure}.`,
      );
    }
  }
}
