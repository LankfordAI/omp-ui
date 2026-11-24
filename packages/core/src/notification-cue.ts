/**
 * The synthesized desktop-notification cues (the "Velvet Chord II" set; the
 * snooze return is the "Clockwork Chime").
 * The main process names the cue when a notification posts; the Electron
 * desktop renderer synthesizes it with Web Audio. Remote web clients never
 * receive the cue event.
 */
export type NotificationCue = "turn" | "plan" | "alert" | "snooze";
