import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { hovered, type Colors } from "./chat-ui";
import { onDismiss } from "./dismiss";
import { controlHeight, fontSize, iconSize, paseoColors, radius, spacing } from "./paseo-theme";

// The ⋯ button at the end of a list row and its menu, which opens under it and closes on a pick or a press outside.
// The row that holds an open menu draws above the rows after it (`zIndex`), which the menu overlaps.

export type MenuEntry = { icon: string; label: string; onSelect: () => void };

export function RowMenu({ colors, title, open, onToggle, entries }: {
  colors: Colors; title: string; open: boolean; onToggle: (open: boolean) => void; entries: MenuEntry[];
}) {
  const box = useRef<View>(null);
  useEffect(() => open ? onDismiss(() => onToggle(false), box.current) : undefined, [open, onToggle]);
  const highlight = paseoColors(colors).interactionHighlight;
  return <View ref={box}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Thao tác: ${title}`} accessibilityState={{ expanded: open }}
      onPress={() => onToggle(!open)} hitSlop={6}
      style={state => ({
        width: controlHeight.tight, height: controlHeight.tight, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
        backgroundColor: open || state.pressed || hovered(state) ? highlight : "transparent",
      })}>
      <Icon name="Ellipsis" size={iconSize.sm} color={colors.foregroundMuted} />
    </Pressable>
    {open ? <View accessibilityRole="menu" style={{
      position: "absolute", top: controlHeight.tight + spacing[1], right: 0, minWidth: 180, paddingVertical: spacing[1],
      borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1,
    }}>
      {entries.map(({ icon, label, onSelect }) => <Pressable key={label} accessibilityRole="menuitem" onPress={() => { onToggle(false); onSelect(); }}
        style={state => ({
          flexDirection: "row", alignItems: "center", gap: spacing[2], minHeight: controlHeight.tight,
          marginHorizontal: spacing[1], paddingHorizontal: spacing[2], borderRadius: radius.md,
          backgroundColor: state.pressed || hovered(state) ? highlight : "transparent",
        })}>
        <Icon name={icon} size={iconSize.sm} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foreground, fontSize: fontSize.base }}>{label}</Text>
      </Pressable>)}
    </View> : null}
  </View>;
}
