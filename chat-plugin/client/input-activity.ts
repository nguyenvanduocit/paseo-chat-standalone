// How long ago the person used this Paseo window, which tells others whether they are at their keyboard.
import { AppState, Platform } from "react-native";

type Listener = () => void;
declare const document: {
  addEventListener(type: string, listener: Listener, options: { capture: boolean; passive: boolean }): void;
  removeEventListener(type: string, listener: Listener, options: { capture: boolean }): void;
};

// Input anywhere in the window, Paseo's own views included, so document listeners rather than the plugin's own views.
const inputEvents = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];

// `idleMs` is undefined until the window has had input, so a window that merely reopened (a reload, a rollout)
// does not count as the person being there. On iOS and Android, an app in the foreground is in use.
export function watchInput(now: () => number = Date.now): { idleMs(): number | undefined; stop(): void } {
  if (Platform.OS !== "web") {
    return { idleMs: () => AppState.currentState === "active" ? 0 : undefined, stop: () => {} };
  }
  let last: number | undefined;
  const seen = () => { last = now(); };
  for (const type of inputEvents) document.addEventListener(type, seen, { capture: true, passive: true });
  return {
    idleMs: () => last === undefined ? undefined : Math.max(0, now() - last),
    stop: () => { for (const type of inputEvents) document.removeEventListener(type, seen, { capture: true }); },
  };
}
