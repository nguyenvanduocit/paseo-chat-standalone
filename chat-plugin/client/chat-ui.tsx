import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown, TextInput } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import {
  ActivityIndicator, Pressable, Text, View,
  type NativeSyntheticEvent, type PressableStateCallbackType, type TextInputKeyPressEventData,
} from "react-native";
import type { ChatMessageView, Conversation } from "../shared/chat";
import {
  messageClock, myMessageText, replyOf, theirMessage, type MessageRow, type MyMessage, type Quote, type SenderLine, type TheirMessage,
} from "../shared/message-text";
import { Avatar } from "./Avatar";
import { draftBody, MentionOffers, MentionPills, useMentionOffers, type MentionDraft } from "./MentionField";
import { controlHeight, disabledOpacity, fontSize, fontWeight, iconSize, lineHeight, paseoColors, pressedOpacity, radius, spacing } from "./paseo-theme";

// The pieces every chat surface (screen, panel, notification window) builds with, drawn as Paseo draws its
// own: the agent timeline's message items and composer, segmented control, buttons and badges. Colors the
// plugin SDK does not carry (`surface3`, `interactionHighlight`) come from `paseoColors` (style guide §3.2).

export type Colors = PluginTheme["colors"];

// react-native-web reports hover on Pressable; native platforms leave it undefined.
export const hovered = (state: PressableStateCallbackType) => (state as { hovered?: boolean }).hovered === true;

// A conversation's rows as Discord and Slack lay them out: a line for each day and messages grouped by
// sender, a group's messages closer together than the groups.
export function MessageList({ colors, rows, me }: { colors: Colors; rows: readonly MessageRow[]; me: string }) {
  return <>{rows.map((row, at) => {
    const marginTop = at === 0 ? 0 : row.kind === "message" && row.continued ? spacing[1] : spacing[4];
    return <View key={row.key} style={{ marginTop }}>
      {row.kind === "day"
        ? <DayLine colors={colors} label={row.label} />
        : <ChatMessage colors={colors} message={row.message} mine={row.message.author === me} continued={row.continued} endsGroup={row.endsGroup} />}
    </View>;
  })}</>;
}

function DayLine({ colors, label }: { colors: Colors; label: string }) {
  const line = <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />;
  return <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
    {line}
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>{label}</Text>
    {line}
  </View>;
}

// Mine is the bubble on the right, with its time under the last of a group; theirs is the same bubble on the
// left beside their avatar, under their name and time.
function ChatMessage({ colors, message, mine, continued, endsGroup }: {
  colors: Colors; message: ChatMessageView; mine: boolean; continued: boolean; endsGroup: boolean;
}) {
  if (!mine) return <TheirMessageBubble colors={colors} message={theirMessage(message, [], continued)} />;
  const reply = replyOf(message);
  return <View style={{ alignItems: "flex-end", gap: spacing[1] }}>
    {reply ? <ReplyLine colors={colors} reply={reply} /> : null}
    <MyMessageBubble colors={colors} message={{ markdown: myMessageText(message) }} />
    {endsGroup ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>{messageClock(message.createdAt)}</Text> : null}
  </View>;
}

// Paseo's user bubble on the right, holding Markdown. A conversation tab draws my messages with it in place
// of Paseo's own bubble, which draws text as typed; what my agent sent is marked as sent by AI.
export function MyMessageBubble({ colors, message }: { colors: Colors; message: MyMessage }) {
  const body = <View style={[bubble(colors, "right"), { alignSelf: "flex-end" }]}><Markdown>{message.markdown}</Markdown></View>;
  if (!message.byAgent) return body;
  return <View style={{ alignItems: "flex-end", gap: spacing[1] }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[1], maxWidth: "100%" }}>
      <Icon name="Bot" size={iconSize.xs} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.sm }}>Sent by AI</Text>
    </View>
    {body}
  </View>;
}

// What a message answers, one line above it.
function ReplyLine({ colors, reply }: { colors: Colors; reply: Quote }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[1], maxWidth: "100%" }}>
    <Icon name="CornerUpLeft" size={iconSize.xs} color={colors.foregroundMuted} />
    <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.sm }}>
      <Text style={{ fontWeight: fontWeight.medium }}>{reply.author}</Text>{` ${reply.text}`}
    </Text>
  </View>;
}

// Their avatar sits beside the first message of a group; the rest line up under its text.
const avatarSize = 28;

export function TheirMessageBubble({ colors, message }: { colors: Colors; message: TheirMessage }) {
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[2] }}>
    <View style={{ width: avatarSize }}>
      {message.continued ? null : <Avatar colors={colors} handle={message.author} size={avatarSize} ring={colors.surface0} />}
    </View>
    <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start", gap: spacing[1] }}>
      {message.reply ? <ReplyLine colors={colors} reply={message.reply} /> : null}
      {message.continued ? null : <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>
        <Text style={{ color: colors.foreground, fontWeight: fontWeight.medium }}>{message.author}</Text>
        {` · ${messageClock(message.createdAt)}`}
      </Text>}
      <View style={bubble(colors, "left")}><Markdown>{message.markdown}</Markdown></View>
    </View>
  </View>;
}

// My name and time above my group in a conversation tab, where Paseo's own bubble below has neither. Paseo
// draws the row in the same column as that bubble, so the name ends at the bubble's right edge. My own messages
// carry no avatar, as in other chat apps: Paseo's bubble cannot make room beside it for one.
// An empty row draws nothing.
export function MySenderLine({ colors, line }: { colors: Colors; line: SenderLine }) {
  if (!line.sender) return null;
  return <Text style={{ alignSelf: "flex-end", color: colors.foregroundMuted, fontSize: fontSize.sm }}>
    <Text style={{ color: colors.foreground, fontWeight: fontWeight.medium }}>{line.sender.author}</Text>
    {` · ${messageClock(line.sender.createdAt)}`}
  </Text>;
}

// Paseo's user bubble: `surface3`, no edge. The corner nearest the sender is the sharp one.
const bubble = (colors: Colors, side: "left" | "right") => ({
  maxWidth: "100%" as const, minWidth: 0, flexShrink: 1, backgroundColor: paseoColors(colors).surface3,
  borderRadius: radius["2xl"], [side === "right" ? "borderTopRightRadius" : "borderTopLeftRadius"]: radius.sm,
  paddingHorizontal: spacing[4], paddingVertical: spacing[4],
});

// Paseo's composer: a rounded field with the round send button at its bottom right. `@` offers people and
// the person's own agents above it, and a pick becomes a pill in the field. On the web Enter sends (or picks
// the first offer while they show) and Shift+Enter starts a new line; Backspace in empty text removes the
// last pill. Native keyboards keep their return key.
export function Composer({ colors, label, conversation, draft, onChange, onSubmit, sending, autoFocus, maxLength, minLines = 1 }: {
  colors: Colors; label: string; conversation: Conversation; draft: MentionDraft; onChange(draft: MentionDraft): void; onSubmit(): void;
  sending: boolean; autoFocus: boolean; maxLength: number; minLines?: number;
}) {
  const canSend = draftBody(draft) !== "" && !sending;
  const textLine = lineHeight(fontSize.content);
  const { offers, pick, remove } = useMentionOffers(conversation, draft, onChange);
  function onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    const key = event.nativeEvent as TextInputKeyPressEventData & { shiftKey?: boolean };
    if (key.key === "Backspace" && draft.text === "" && draft.mentions.length) return remove(draft.mentions.length - 1);
    if (key.key !== "Enter" || key.shiftKey) return;
    event.preventDefault();
    if (offers.length) pick(offers[0]);
    else if (canSend) onSubmit();
  }
  return <View style={{ gap: spacing[2] }}>
  {offers.length ? <MentionOffers colors={colors} offers={offers} onPick={pick} /> : null}
  <View style={{
    flexDirection: "row", alignItems: "flex-end", gap: spacing[2], backgroundColor: colors.surface1,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius["2xl"],
    paddingVertical: spacing[2], paddingLeft: spacing[4], paddingRight: spacing[2],
  }}>
    <View style={{ flex: 1, gap: spacing[1] }}>
    {draft.mentions.length ? <MentionPills colors={colors} mentions={draft.mentions} disabled={sending} onRemove={remove} /> : null}
    <TextInput
      multiline
      autoFocus={autoFocus}
      value={draft.text}
      onChangeText={text => onChange({ ...draft, text })}
      onKeyPress={onKeyPress}
      editable={!sending}
      maxLength={maxLength}
      placeholder={label}
      placeholderTextColor={colors.foregroundMuted}
      accessibilityLabel={label}
      style={{
        minHeight: Math.max(controlHeight.tight, textLine * minLines), maxHeight: textLine * 6, paddingVertical: spacing[1],
        color: colors.foreground, fontSize: fontSize.content, lineHeight: textLine, textAlignVertical: "top", outlineStyle: "none",
      } as object}
    />
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Gửi" disabled={!canSend} onPress={onSubmit}
      style={{ width: controlHeight.tight, height: controlHeight.tight, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent, opacity: canSend ? 1 : 0.5 }}>
      {sending ? <ActivityIndicator size="small" color={colors.accentForeground} /> : <Icon name="ArrowUp" size={iconSize.md} color={colors.accentForeground} />}
    </Pressable>
  </View>
  </View>;
}

// Paseo's segmented control, small size: pill segments, the selected one filled with `surface3`.
export function Segmented<Value extends string>({ colors, options, value, onChange }: {
  colors: Colors; options: readonly { value: Value; label: string }[]; value: Value; onChange(value: Value): void;
}) {
  const paseo = paseoColors(colors);
  // Tabs wrap onto a second line in a narrow panel rather than being cut off.
  return <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing[1] }}>
    {options.map(option => {
      const selected = option.value === value;
      return <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => onChange(option.value)}
        style={state => ({
          minHeight: controlHeight.tight, paddingHorizontal: spacing[3], borderRadius: radius.full, justifyContent: "center",
          backgroundColor: selected || state.pressed ? paseo.surface3 : hovered(state) ? colors.surface2 : "transparent",
        })}>
        <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.base, fontWeight: fontWeight.normal }}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

// Paseo's button (style guide §7.1): a pill; `primary` is the accent fill, `ghost` has no fill and its label
// turns from muted to foreground on hover.
// `accessibilityLabel` names what the button acts on when its label alone does not, as in a list's rows.
export function Button({ colors, label, icon, variant, onPress, disabled, stretch, accessibilityLabel }: {
  colors: Colors; label: string; icon?: string; variant: "primary" | "ghost"; onPress(): void; disabled?: boolean; stretch?: boolean; accessibilityLabel?: string;
}) {
  const primary = variant === "primary";
  const fill = primary ? colors.accent : "transparent";
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={onPress}
    style={state => ({
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing[2], alignSelf: stretch ? "stretch" : "auto",
      minHeight: controlHeight.compact, paddingHorizontal: spacing[4], borderRadius: radius.full, borderWidth: 1,
      backgroundColor: fill, borderColor: fill,
      opacity: disabled ? disabledOpacity : state.pressed ? pressedOpacity : 1,
    })}>
    {state => {
      const tint = primary ? colors.accentForeground : hovered(state) || state.pressed ? colors.foreground : colors.foregroundMuted;
      return <>
        {icon ? <Icon name={icon} size={iconSize.sm} color={tint} /> : null}
        <Text style={{ color: tint, fontSize: fontSize.base, fontWeight: fontWeight.medium }}>{label}</Text>
      </>;
    }}
  </Pressable>;
}

// An unread count; `mention` marks a count that includes a message naming the person.
export function CountBadge({ colors, count, mention }: { colors: Colors; count: number; mention?: boolean }) {
  return <View style={{
    minWidth: 18, height: 18, paddingHorizontal: spacing[1.5], borderRadius: radius.full, alignItems: "center", justifyContent: "center",
    backgroundColor: mention ? colors.statusWarning : colors.accent,
  }}>
    <Text style={{ color: colors.accentForeground, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>{mention ? "@" : ""}{count > 99 ? "99+" : count}</Text>
  </View>;
}

// Paseo's empty state: a muted icon over one centered, muted line.
export function EmptyState({ colors, icon, children }: { colors: Colors; icon: string; children: ReactNode }) {
  return <View style={{ alignItems: "center", justifyContent: "center", gap: spacing[2], paddingVertical: spacing[8], paddingHorizontal: spacing[4] }}>
    <View style={{ marginBottom: spacing[1] }}><Icon name={icon} size={iconSize.lg} color={colors.foregroundMuted} /></View>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base, textAlign: "center" }}>{children}</Text>
  </View>;
}

export function ErrorLine({ colors, message }: { colors: Colors; message: string }) {
  return <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
    <Icon name="CircleAlert" size={iconSize.sm} color={colors.statusDanger} />
    <Text style={{ flex: 1, color: colors.statusDanger, fontSize: fontSize.sm }}>{message}</Text>
  </View>;
}
