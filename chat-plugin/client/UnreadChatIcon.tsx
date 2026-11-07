import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";

// One fade out and back takes 1.4 s: well under WCAG's three flashes a second.
const halfCycleMs = 700;

// The workspace header's Chat icon while messages wait unread: accent-coloured and pulsing. With
// reduced motion on, it holds still and the accent colour alone marks the unread messages.
export function UnreadChatIcon({ size, theme, layout }: PluginButtonIconProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => { if (active) setReduceMotion(enabled); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (reduceMotion) { opacity.setValue(1); return; }
    const fade = (toValue: number) => Animated.timing(opacity, {
      toValue, duration: halfCycleMs, easing: Easing.inOut(Easing.ease), useNativeDriver: layout.platform !== "web",
    });
    const pulse = Animated.loop(Animated.sequence([fade(0.3), fade(1)]));
    pulse.start();
    return () => { pulse.stop(); opacity.setValue(1); };
  }, [reduceMotion, layout.platform]);

  return <Animated.View style={{ opacity }}>
    <Icon name="MessagesSquare" size={size} color={theme.colors.accent} />
  </Animated.View>;
}
