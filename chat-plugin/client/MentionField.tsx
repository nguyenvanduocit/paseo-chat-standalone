import { useMyRpc } from "./me";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { mentionText, type Conversation, type Mention } from "../shared/chat";
import { mentionOf, mentionToken, readMentionCandidates, type MentionCandidate } from "../shared/mentions";
import type { Colors } from "./chat-ui";
import { fontSize, fontWeight, iconSize, paseoColors, radius, spacing } from "./paseo-theme";

// What the person is writing in a composer: the people and agents picked as pills, then the text.
export interface MentionDraft { mentions: Mention[]; text: string }
export const emptyDraft: MentionDraft = { mentions: [], text: "" };
export const draftBody = (draft: MentionDraft) => [...draft.mentions.map(mentionToken), draft.text.trim()].filter(Boolean).join(" ");

const keyOf = (mention: Mention) => mention.kind === "person" ? `p:${mention.handle}` : `a:${mention.id}`;
// `@` and what follows it at the end of the text, where the person is typing.
const typedQuery = (text: string) => /(?:^|\s)@([^\s@]{0,64})$/.exec(text)?.[1] ?? null;
const shownOffers = 6;

// While the text ends in `@query`: the people and the person's own agents it matches, not yet picked.
// A pick replaces `@query` with a pill.
export function useMentionOffers(conversation: Conversation, draft: MentionDraft, onChange: (draft: MentionDraft) => void) {
  const candidates = useMyRpc(readMentionCandidates);
  const query = typedQuery(draft.text);
  const [offers, setOffers] = useState<MentionCandidate[]>([]);
  const picked = draft.mentions.map(keyOf).join(" ");

  useEffect(() => {
    if (query === null) { setOffers([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      candidates({ conversation, query })
        .then(result => { if (!cancelled) setOffers(result.candidates.filter(offer => !picked.split(" ").includes(keyOf(mentionOf(offer)))).slice(0, shownOffers)); })
        .catch(() => { if (!cancelled) setOffers([]); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, picked]);

  return {
    offers: query === null ? [] : offers,
    pick: (offer: MentionCandidate) => onChange({ mentions: [...draft.mentions, mentionOf(offer)], text: draft.text.replace(/@[^\s@]*$/, "") }),
    remove: (index: number) => onChange({ ...draft, mentions: draft.mentions.filter((_, at) => at !== index) }),
  };
}

// The offers above the composer; the first one is what Enter picks.
export function MentionOffers({ colors, offers, onPick }: { colors: Colors; offers: MentionCandidate[]; onPick(offer: MentionCandidate): void }) {
  return <View accessibilityRole="menu" style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface1, paddingVertical: spacing[1] }}>
    {offers.map((offer, index) => <Pressable key={keyOf(mentionOf(offer))} accessibilityRole="menuitem" accessibilityLabel={`Nhắc ${mentionText(mentionOf(offer))}`}
      onPress={() => onPick(offer)}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: spacing[2], paddingHorizontal: spacing[3], paddingVertical: spacing[1], backgroundColor: pressed || index === 0 ? colors.surface2 : "transparent" })}>
      <Icon name={offer.kind === "person" ? "User" : "Bot"} size={iconSize.sm} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.sm }}>{mentionText(mentionOf(offer))}</Text>
      <Text style={{ color: offer.kind === "person" && offer.online ? colors.statusSuccess : colors.foregroundMuted, fontSize: fontSize.sm }}>
        {offer.kind === "person" ? (offer.online ? "online" : "người") : "agent của bạn"}
      </Text>
    </Pressable>)}
  </View>;
}

// The picked people and agents, each a pill with its own remove button.
export function MentionPills({ colors, mentions, disabled, onRemove }: { colors: Colors; mentions: Mention[]; disabled: boolean; onRemove(index: number): void }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[1] }}>
    {mentions.map((mention, index) => <View key={keyOf(mention)} style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: spacing[2], paddingRight: spacing[1], paddingVertical: 2, borderRadius: radius.full, backgroundColor: paseoColors(colors).surface3 }}>
      <Icon name={mention.kind === "person" ? "AtSign" : "Bot"} size={iconSize.xs} color={colors.accent} />
      <Text numberOfLines={1} style={{ color: colors.accent, fontSize: fontSize.sm, fontWeight: fontWeight.medium, maxWidth: 160 }}>{mentionText(mention).slice(1)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Bỏ ${mentionText(mention)}`} disabled={disabled} onPress={() => onRemove(index)} hitSlop={6} style={{ padding: 2 }}>
        <Icon name="X" size={iconSize.xs} color={colors.foregroundMuted} />
      </Pressable>
    </View>)}
  </View>;
}
