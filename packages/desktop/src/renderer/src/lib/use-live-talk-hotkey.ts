import { useEffect } from "react";
import { useStore } from "../store";
import { isTypingTarget } from "./hotkeys";
import { DICTATION_HOTKEY_KEY } from "./use-dictation-hotkey";

/**
 * Hold-to-talk for live voice (ADR-0070): the #707 bare-R gesture. Dictation's
 * listener is suppressed while a call is open (#805), so a press never
 * reaches both. Same guards: no modifiers, no auto-repeat, no composition,
 * never from a text field; the release lands from anywhere, and window blur
 * or teardown releases a held key (no keyup arrives after alt-Tab).
 */
export function useLiveTalkHotkey(tabId: string, viewed: boolean): void {
  const enabled = useStore((s) => {
    const live = s.rpc[tabId]?.live;
    return viewed && s.activeTabId === tabId && s.liveVoice[tabId]?.armed === true &&
      live != null && !live.ended;
  });
  const setLiveTalking = useStore((s) => s.setLiveTalking);
  useEffect(() => {
    if (!enabled) return;
    let held = false;
    const isR = (e: KeyboardEvent): boolean =>
      !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey &&
      e.key.toLowerCase() === DICTATION_HOTKEY_KEY;
    const release = (): void => {
      if (!held) return;
      held = false;
      void setLiveTalking(tabId, false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (held || e.repeat || e.shiftKey || !isR(e) || isTypingTarget(e.target)) return;
      held = true;
      void setLiveTalking(tabId, true);
    };
    const onKeyUp = (e: KeyboardEvent): void => { if (isR(e)) release(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      release();
    };
  }, [enabled, setLiveTalking, tabId]);
}
