import { useEffect, useState } from "react";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import { LIVE_VOICE_SETTING_GROUP } from "@omp-ui/core/omp-settings-keys";
import { useT } from "../../lib/i18n";
import { Label } from "../ui";
import { Row, SettingControl, layerBadge } from "./rows";
import arborSample from "../../assets/live-voice/arbor.mp3?url";
import breezeSample from "../../assets/live-voice/breeze.mp3?url";
import coveSample from "../../assets/live-voice/cove.mp3?url";
import emberSample from "../../assets/live-voice/ember.mp3?url";
import juniperSample from "../../assets/live-voice/juniper.mp3?url";
import mapleSample from "../../assets/live-voice/maple.mp3?url";
import solSample from "../../assets/live-voice/sol.mp3?url";
import spruceSample from "../../assets/live-voice/spruce.mp3?url";
import valeSample from "../../assets/live-voice/vale.mp3?url";

/**
 * Bundled previews for the nine GPT-Live realtime voices (#813). The names
 * are ChatGPT's proprietary voices; no public sample audio exists (the TTS
 * endpoint and `omp say` reject them), so short clips were rendered once
 * through the realtime API and committed beside this file. A curated map,
 * not a glob: an omp voice list that drifts from the nine degrades to the
 * dropdown alone — an option with no entry here gets no play button.
 */
const SAMPLE_BY_VOICE: Record<string, string> = {
  arbor: arborSample,
  breeze: breezeSample,
  cove: coveSample,
  ember: emberSample,
  juniper: juniperSample,
  maple: mapleSample,
  sol: solSample,
  spruce: spruceSample,
  vale: valeSample,
};

// One clip at a time across every mount of this section: starting a sample
// stops the previous one, which is the behavior a list of buttons needs.
const previewAudio = new Audio();

/**
 * The omp page's "Live voice" section (#802, #813): the generic enum row for
 * `live.voice` plus a play button per voice with a bundled sample, so a
 * picking user hears the timbre before committing it through `omp config
 * set`. Playback is local static audio only — no getUserMedia, no autoplay,
 * and omp-ui never touches the realtime API here (the #778 shape).
 */
export function LiveVoiceSection({
  entry,
  pendingKey,
  commit,
}: {
  /** The live.voice snapshot entry; undefined when omp predates the key. */
  entry: OmpSettingEntry | undefined;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
}) {
  const t = useT();
  const [playing, setPlaying] = useState<string | null>(null);

  // A section unmount (navigating away from Settings) ends the clip; a clip
  // that simply runs out clears the stop button's state.
  useEffect(() => {
    const ended = (): void => setPlaying(null);
    previewAudio.addEventListener("ended", ended);
    return () => {
      previewAudio.removeEventListener("ended", ended);
      previewAudio.pause();
    };
  }, []);

  if (entry === undefined) return null;

  const samples = (entry.options ?? []).filter(
    (option) => SAMPLE_BY_VOICE[option] !== undefined,
  );

  const toggle = (voice: string): void => {
    if (playing === voice) {
      previewAudio.pause();
      setPlaying(null);
      return;
    }
    previewAudio.pause();
    previewAudio.src = SAMPLE_BY_VOICE[voice];
    previewAudio.currentTime = 0;
    setPlaying(voice);
    void previewAudio.play().catch(() => setPlaying(null));
  };

  return (
    <section className="px-4 pt-3">
      <Label>{LIVE_VOICE_SETTING_GROUP.title}</Label>
      <div className="mt-1 divide-y divide-line-soft">
        <Row
          title={entry.key}
          hint={entry.description}
          badge={layerBadge(entry.layer)}
        >
          <SettingControl entry={entry} pendingKey={pendingKey} commit={commit} />
        </Row>
        {samples.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 py-2.5">
            {samples.map((voice) => (
              <button
                key={voice}
                type="button"
                onClick={() => toggle(voice)}
                title={t(
                  playing === voice
                    ? "settings.omp.liveVoiceStop"
                    : "settings.omp.liveVoicePlay",
                  { voice },
                )}
                className={
                  "h-6 rounded-md border px-2 text-[11px] transition-colors duration-150 " +
                  (playing === voice
                    ? "border-line-strong bg-raised text-ink"
                    : "border-line bg-transparent text-ink-mid hover:border-line-strong hover:text-ink")
                }
              >
                {playing === voice ? `■ ${voice}` : `▶ ${voice}`}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
