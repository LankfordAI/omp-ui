import { execFile } from "node:child_process";

/**
 * GNOME's two switches that silence our synthesized cue before it ever
 * reaches the speakers: Do-Not-Disturb (notifications `show-banners` off)
 * and this app's per-app sound-alerts toggle. Both are read with `gsettings`;
 * when `gsettings` is missing or errors — non-GNOME desktops, a registry
 * without our app entry — the gate defaults to allowing playback, because
 * those cases have no GNOME muting in effect.
 */

/** Results are cached briefly: every notification must not fork two more processes. */
const CACHE_TTL_MS = 5_000;

const SHOW_BANNERS_ARGS = ["get", "org.gnome.desktop.notifications", "show-banners"];
const APP_SOUND_ALERTS_ARGS = [
  "get",
  "org.gnome.desktop.notifications.application:/org/gnome/desktop/notifications/application/ai-lankford-omp-ui/",
  "enable-sound-alerts",
];

export interface GnomeSoundGateOptions {
  /** Overridable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Runs `gsettings` with these arguments and resolves stdout. Rejects on failure. */
  execGsettings?: (args: string[]) => Promise<string>;
}

/** Resolves whether GNOME currently lets omp-ui make notification sounds. */
export type GnomeSoundGate = () => Promise<boolean>;

function runGsettings(args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("gsettings", args, { timeout: 2_000 }, (err, stdout) => {
    if (err !== null) reject(err);
    else resolve(stdout);
  });
  return promise;
}

/** `boolean false` is the only mute; `boolean true` and anything unexpected allow. */
function denies(out: string): boolean {
  return out.trim() === "boolean false";
}

export function createGnomeSoundGate(opts: GnomeSoundGateOptions = {}): GnomeSoundGate {
  const platform = opts.platform ?? process.platform;
  const exec = opts.execGsettings ?? runGsettings;
  let cache: { value: boolean; expiresAt: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (platform !== "linux") return Promise.resolve(true);
    if (cache !== null && cache.expiresAt > Date.now()) return Promise.resolve(cache.value);
    if (inflight !== null) return inflight;
    inflight = (async (): Promise<boolean> => {
      let value = true;
      try {
        for (const args of [SHOW_BANNERS_ARGS, APP_SOUND_ALERTS_ARGS]) {
          if (denies(await exec(args))) {
            value = false;
            break;
          }
        }
      } catch {
        // No gsettings, no app entry, GNOME-less desktop: assume unmuted.
        value = true;
      }
      cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      inflight = null;
      return value;
    })();
    return inflight;
  };
}
