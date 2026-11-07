import { Platform } from "react-native";

// Closes a menu on Escape, or on a press anywhere outside `inside` (the menu's element), until the returned function is
// called. A document listener, because a press outside lands on views that know nothing of the menu. A no-op on iOS and
// Android, where picking an item or the menu button closes it.

interface KeyEvent { key: string }
interface PressEvent { target: unknown }

declare const document: {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  addEventListener(type: "pointerdown", listener: (event: PressEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "pointerdown", listener: (event: PressEvent) => void, capture: boolean): void;
};

export function onDismiss(close: () => void, inside: unknown): () => void {
  if (Platform.OS !== "web") return () => {};
  const keydown = (event: KeyEvent) => { if (event.key === "Escape") close(); };
  const pointerdown = (event: PressEvent) => { if (!contains(inside, event.target)) close(); };
  document.addEventListener("keydown", keydown);
  document.addEventListener("pointerdown", pointerdown, true);
  return () => {
    document.removeEventListener("keydown", keydown);
    document.removeEventListener("pointerdown", pointerdown, true);
  };
}

function contains(node: unknown, target: unknown): boolean {
  return typeof node === "object" && node !== null && "contains" in node
    && typeof node.contains === "function" && node.contains(target) === true;
}
