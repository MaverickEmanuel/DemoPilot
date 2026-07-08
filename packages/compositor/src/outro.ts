// The outro freeze-hold is shared across four places that must agree on the
// rendered composition length: the motion plan (camera-track length), the
// composition metadata (Root.tsx), the video freeze/fade (Demo.tsx), and the
// audio track length (audio.ts). It lives in this dependency-free leaf module so
// it can be imported from both the browser-bundled modules (extensionless
// imports) and the Node-only render/audio path (NodeNext `.js` imports) without
// pulling either graph into the other.

/** Freeze-hold appended past the recording so the final frame rests under a
 * settled camera. Sized to give the outro's full zoom-out (camera.ts) room to
 * ease all the way back out and settle before the final fade. */
export const OUTRO_HOLD_MS = 1500;
/** Final fade length, anchored to the extended composition end. */
export const OUTRO_FADE_MS = 500;

/** The rendered composition length (ms): the recording plus the freeze-hold. */
export function outputDurationMs(durationMs: number): number {
  return durationMs + OUTRO_HOLD_MS;
}
