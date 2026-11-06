/**
 * The chat's short send sound (assets/sounds/make-send.py). It follows the phone's silent setting:
 * iOS's ambient session goes quiet with the switch, and on Android expo-audio plays nothing unless the
 * ringer is normal. It joins whatever else is playing. Everything is guarded and optional: a sound
 * must never stop a send, and a build from before expo-audio has no native module for it.
 */
type Player = { seekTo(seconds: number): Promise<void>; play(): void };

let player: Player | undefined;
let tried = false;

/** Loaded before the first press, so that one is not late too. */
export function prepareSend(): void {
  if (tried) return;
  tried = true;
  try {
    const audio = require("expo-audio") as typeof import("expo-audio");
    void audio.setAudioModeAsync({ playsInSilentMode: false, interruptionMode: "mixWithOthers" }).catch(() => undefined);
    player = audio.createAudioPlayer(require("../assets/sounds/send.wav"));
  } catch {}
}

export function playSend(): void {
  prepareSend();
  try {
    void player?.seekTo(0).catch(() => undefined);
    player?.play();
  } catch {}
}
