import {
  CH,
  type AudioDevicesSnapshot,
  type Registry,
  type RequestHandlers,
} from "@omp-ui/core";
import {
  applyAudioDevice,
  execPactlRunner,
  readAudioDevices,
  type AudioDeviceRole,
  type AudioDeviceRunner,
} from "./audio-devices";

type AudioHandlerChannels = typeof CH.readAudioDevices | typeof CH.setAudioDevice;

interface AudioHandlerDependencies {
  registry: Registry;
  broadcast: () => Promise<void>;
  /** pactl seam; defaults to the real binary (issue #855). */
  run?: AudioDeviceRunner;
  /** Injectable for tests; the real platform decides the Linux-only v1 gate. */
  platform?: NodeJS.Platform;
}

const UNSUPPORTED_ERROR = "device selection is not yet supported on this platform";

/**
 * The app-wide audio devices by role (issue #857): the persisted card labels
 * are the intent, the OS default source/sink is the mechanism. Reads never
 * reject — `supported` and `error` say when pactl is absent or the platform
 * is unsupported, exactly the readSttModels probe contract. Writes commit
 * the registry before applying, so a crash mid-apply still persists intent
 * for the next start's best-effort re-apply.
 */
export function registerAudioHandlers(
  deps: AudioHandlerDependencies,
): Pick<RequestHandlers, AudioHandlerChannels> {
  const run = deps.run ?? execPactlRunner();
  const platform = deps.platform ?? process.platform;

  return {
    [CH.readAudioDevices]: async (): Promise<AudioDevicesSnapshot> => {
      if (platform !== "linux") {
        return {
          devices: [],
          currentInput: deps.registry.getSetting("audioInputDevice"),
          currentOutput: deps.registry.getSetting("audioOutputDevice"),
          supported: false,
          error: UNSUPPORTED_ERROR,
        };
      }
      try {
        return {
          devices: await readAudioDevices(run),
          currentInput: deps.registry.getSetting("audioInputDevice"),
          currentOutput: deps.registry.getSetting("audioOutputDevice"),
          supported: true,
          error: null,
        };
      } catch (err) {
        return {
          devices: [],
          currentInput: deps.registry.getSetting("audioInputDevice"),
          currentOutput: deps.registry.getSetting("audioOutputDevice"),
          supported: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [CH.setAudioDevice]: async (role: AudioDeviceRole, deviceId: string | null): Promise<void> => {
      deps.registry.setSetting(
        role === "input" ? "audioInputDevice" : "audioOutputDevice",
        deviceId,
      );
      await deps.broadcast();
      // Commit before apply: an apply failure must not undo the persisted
      // choice — the renderer surfaces the failure, the next start retries.
      await applyAudioDevice(run, deviceId, role);
    },
  };
}
