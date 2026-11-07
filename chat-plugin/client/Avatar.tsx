import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { Presence } from "../shared/chat";
import { avatarHue, initials } from "./chat-list";
import { fontWeight } from "./paseo-theme";

// A person's initials on their own color, with a presence dot unless `presence` is left out: green when active,
// amber when AFK, grey when offline. `ring` is the background the avatar sits on, so the dot looks cut out of it.
export function Avatar({ colors, handle, size, presence, ring }: {
  colors: PluginTheme["colors"]; handle: string; size: number; presence?: Presence; ring: string;
}) {
  const dot = Math.max(8, Math.round(size * 0.3));
  return <View style={{ width: size, height: size }}>
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: `hsl(${avatarHue(handle)}, 45%, 42%)` }}>
      <Text style={{ color: "#fff", fontWeight: fontWeight.medium, fontSize: Math.round(size * 0.36) }}>{initials(handle)}</Text>
    </View>
    {presence === undefined ? null : <View style={{
      position: "absolute", right: -1, bottom: -1, width: dot, height: dot, borderRadius: dot / 2, borderWidth: size < 28 ? 1.5 : 2,
      backgroundColor: presenceColor(colors, presence), borderColor: ring,
    }} />}
  </View>;
}

export function presenceColor(colors: PluginTheme["colors"], presence: Presence): string {
  return presence === "active" ? colors.statusSuccess : presence === "afk" ? colors.statusWarning : colors.foregroundMuted;
}
