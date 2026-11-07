import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

// Paseo's theme scale and the colors plugins do not receive, per docs/plugin-style-guide.md (§3–§8), from
// getpaseo/paseo main a91bb4d: packages/app/src/styles/theme.ts and components/ui/control-geometry.ts.
// The plugin SDK hands plugins the colors only (`PluginTheme`), so plugin surfaces read the rest from here
// and never pick their own numbers. Paseo scales `fontSize` by the person's font-size setting, which plugins
// cannot read; these are the unscaled values.

export const spacing = {
  0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 3.5: 14, 4: 16, 6: 24, 7: 28, 8: 32, 12: 48, 16: 64,
} as const;
export const fontSize = { sm: 12, base: 14, content: 15, lg: 16, xl: 18, "2xl": 20, code: 12 } as const;
// Paseo's charter has two weights inside a surface: "500" names a surface or group, "normal" is content.
export const fontWeight = { normal: "normal", medium: "500" } as const;
export const radius = { sm: 2, base: 4, md: 6, lg: 8, xl: 12, "2xl": 16, full: 9999 } as const;
export const iconSize = { xs: 12, sm: 14, md: 16, lg: 20 } as const;
export const touchIconSize = { xs: 14, sm: 18, md: 20, lg: 24 } as const;
// tight: `sm` control, pointer. compact: `md` control pointer, `sm` touch. field: `md` control touch.
export const controlHeight = { tight: 28, compact: 32, field: 44 } as const;
export const disabledOpacity = 0.5;
export const pressedOpacity = 0.85;

export const monoFontFamily = Platform.select({
  ios: "ui-monospace",
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  default: "monospace",
});

// Paseo's line height for running text: 1.4 times the font size.
export const lineHeight = (size: number) => Math.round(size * 1.4);

/** Paseo picks touch sizing on compact layouts or touch screens; plugins only know the platform. */
export function isTouchSized(layout: PluginHostProps["layout"]): boolean {
  return layout.compact || layout.platform !== "web";
}

/** `#rrggbb` plus a two-digit alpha. Other formats come back unchanged. */
function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alphaHex}` : color;
}

export function isDark(colors: PluginTheme["colors"]): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colors.surface0);
  if (!match) return true;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** The colors plugins receive, plus the app colors they do not, derived as the style guide (§3.2) measures. */
export function paseoColors(c: PluginTheme["colors"]) {
  const dark = isDark(c);
  const tint = dark ? "29" : "1f";
  return {
    ...c,
    surface3: withAlpha(c.foreground, "26"),
    borderAccent: withAlpha(c.foreground, "1c"),
    interactionHighlight: dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)",
    destructive: c.statusDanger,
    // White on dark statusDanger is 2.8:1; surface0 is 5.0-7.5:1 across the dark themes.
    destructiveForeground: dark ? c.surface0 : "#ffffff",
    statusSuccessTint: withAlpha(c.statusSuccess, tint),
    statusWarningTint: withAlpha(c.statusWarning, tint),
    statusDangerTint: withAlpha(c.statusDanger, tint),
  };
}

export type PaseoColors = ReturnType<typeof paseoColors>;
