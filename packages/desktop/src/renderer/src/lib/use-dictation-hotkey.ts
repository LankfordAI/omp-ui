import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { isTypingTarget } from "./hotkeys";
import type { Dictation } from "./use-dictation";

/** The push-to-talk key. Bare `r`; every modifier disqualifies the press. */
export const DICTATION_HOTKEY_KEY = "r";

/**
 * Push-to-talk dictation (issue #707): hold `r` to capture, release to
 * transcribe. Deliberately NOT a `useHotkeys` map entry — that registry only
 * listens for keydown, while push-to-talk needs keyup, blur, and auto-repeat
 * guards; and registering bare `r` there would make `isAppHotkey` claim it and
 * steal the letter from the browser pane (issue #519). The suppression rules
 * (typing-target check, composition guard) are reused from hotkeys.ts.
 *
 * `suppressed` parks the listener while omp's native live voice holds the
 * microphone (issue #805): the capture path would fail on `getUserMedia` and
 * no affordance would signal the conflict — the mic is replaced by the live
 * capsule there, or disabled in the transient gate-drop case. Pass the live
 * session state, never the version gate: push-to-talk stays alive whenever
 * the microphone is free.
 */
export function useDictationHotkey(
  tabId: string,
  voice: Dictation,
  suppressed = false,
): void {
  const enabled = useStore(
    (s) =>
      s.activeTabId === tabId &&
      s.state?.voiceInputEnabled === true &&
      navigator.mediaDevices !== undefined,
  );
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const active = enabled && !suppressed;

  useEffect(() => {
    if (!active) return;
    const isVoicePhase = (p: string): boolean => p === "recording" || p === "requesting";
    const bareR = (e: KeyboardEvent): boolean =>
      !e.repeat &&
      !e.isComposing &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === DICTATION_HOTKEY_KEY &&
      !isTypingTarget(e.target);
    const onKeyDown = (e: KeyboardEvent): void => {
      const v = voiceRef.current;
      if (e.key === "Escape" && !isTypingTarget(e.target) && isVoicePhase(v.phase)) {
        // Window-level twin of the composer textarea's Escape branch: while
        // holding R the focus sits on document.body, so that branch never runs.
        v.cancel();
        return;
      }
      if (bareR(e) && (v.phase === "off" || v.phase === "error")) v.toggle();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      const v = voiceRef.current;
      // No typing-target guard: the release must land even if focus moved into
      // a text field mid-hold; the take stops from wherever the key comes up.
      if (
        !e.isComposing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === DICTATION_HOTKEY_KEY &&
        isVoicePhase(v.phase)
      ) {
        v.stop();
      }
    };
    const onBlur = (): void => {
      // No keyup ever arrives after alt-Tab; discard, never leave the LED on.
      const v = voiceRef.current;
      if (isVoicePhase(v.phase)) v.cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);
}
