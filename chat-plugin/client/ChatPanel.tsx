import { useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  conversationId, dmOf, isDm, projectRoom, threadTitle,
  type ChatSummary, type Presence,
} from "../shared/chat";
import { AssistantRow } from "./AssistantSetting";
import { AttentionRows, needsYouCount, useAttention } from "./AttentionList";
import { Avatar, presenceColor } from "./Avatar";
import {
  agentsLabel, byKind, byPresence, lastAuthorLabel, oneToOneByPartner, partnerOf, plainPreview, presenceLabel, shortTime, splitUnread,
  teamActivity, teamActivityLabel,
} from "./chat-list";
import { CountBadge, ErrorLine, hovered, Segmented, type Colors } from "./chat-ui";
import { fontSize, iconSize, paseoColors, radius, spacing } from "./paseo-theme";
import { useInbox } from "./useInbox";
import { useOpenConversation } from "./useOpenConversation";
import { WorkspaceOwner } from "./WorkspaceOwner";

// A list row in a panel (style guide §7.3).
const rowHeight = 36;

type Tab = "people" | "messages" | "groups" | "attention";
type Listed = Pick<ChatSummary, "id" | "conversation" | "title" | "unread" | "mentioned" | "last">;

// Chat beside the work: the AI Assistant's row, then lists in four tabs: **Thành viên**, everyone in chat; **Tin nhắn**, one-to-one
// conversations; **Nhóm**, rooms and groups; **Cần lưu ý**, what the AI Assistant noted you must not miss. The
// conversation tabs show what is unread apart from the rest.
// Picking one opens the conversation in its Paseo tab in the middle of the window, where Paseo's own
// timeline and composer show it.
export function ChatPanel({ theme, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const project = useWorkspace(workspaceId, workspace => workspace.projectDisplayName);
  const { inbox, error } = useInbox();
  const attention = useAttention();
  const { open: openId, opening, error: openError } = useOpenConversation(navigation);
  const [tab, setTab] = useState<Tab>("people");
  const colors = theme.colors;
  if (!project || !inbox) return error ? <View style={{ padding: spacing[3] }}><ErrorLine colors={colors} message={error} /></View> : <Loading />;

  const me = inbox.me;
  const open = (conversation: ChatSummary["conversation"]) => openId(conversationId(conversation));

  const people = byPresence(inbox.people.filter(person => person.handle !== me));
  const presence = new Map(people.map(person => [person.handle, person.presence]));
  const withPerson = oneToOneByPartner(inbox.conversations, me);
  const room = projectRoom(project);
  const roomId = conversationId(room);
  // The project's room is listed even before anyone writes in it, so the team always has a place to meet.
  const listed: Listed[] = inbox.conversations.some(summary => summary.id === roomId) ? inbox.conversations
    : [...inbox.conversations, { id: roomId, conversation: room, title: threadTitle(room), unread: 0, mentioned: false, last: null }];
  const { direct, groups } = byKind(listed, me);
  const unreadIn = (list: readonly Listed[]) => list.reduce((total, summary) => total + summary.unread, 0);
  const counted = (label: string, count: number) => count ? `${label} · ${count > 99 ? "99+" : count}` : label;
  const badge = (summary: Pick<ChatSummary, "unread" | "mentioned"> | undefined) =>
    summary && summary.unread > 0 ? <CountBadge colors={colors} count={summary.unread} mention={summary.mentioned} /> : null;

  const body = tab === "attention"
    ? <AttentionRows colors={colors} attention={attention} openAgent={navigation ? input => navigation.openAgent(input) : undefined} openConversation={id => { void openId(id); }} />
    : tab === "people"
    ? (people.length
      ? [<Hint key="activity" colors={colors}>{teamActivityLabel(teamActivity(people))}</Hint>, ...people.map(person => {
        const summary = withPerson.get(person.handle);
        const count = summary?.unread ?? 0;
        const status = presenceLabel(person);
        const agents = agentsLabel(person.agents);
        return <ListRow key={person.handle} colors={colors} label={person.handle} detail={[agents, ...person.projects].filter(Boolean).join(" · ")}
          strong={person.presence !== "offline" || person.agents > 0 || count > 0}
          busy={opening === conversationId(dmOf([me, person.handle]))}
          accessibilityLabel={[`Nhắn riêng ${person.handle}`, status, agents, count ? `${count} tin chưa đọc` : ""].filter(Boolean).join(", ")}
          leading={<Avatar colors={colors} handle={person.handle} size={24} presence={person.presence} ring={colors.surface0} />}
          trailing={badge(summary) ?? (person.presence === "active" ? null
            : <Text style={{ color: presenceColor(colors, person.presence), fontSize: fontSize.sm }}>{status}</Text>)}
          onPress={() => { void open(dmOf([me, person.handle])); }} />;
      })]
      : <Hint colors={colors}>Người dùng hiện ở đây khi họ chọn tên trên một client của daemon này.</Hint>)
    : <ConversationList colors={colors} me={me} presence={presence} opening={opening} badge={badge}
      conversations={tab === "messages" ? direct : groups} empty={tab === "messages" ? "Chưa có tin nhắn riêng. Chọn một thành viên để bắt đầu." : "Chưa có nhóm nào."}
      onOpen={summary => { void open(summary.conversation); }} />;

  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ paddingHorizontal: spacing[2], paddingVertical: spacing[2], gap: spacing[2], borderBottomWidth: 1, borderColor: colors.border }}>
      <AssistantRow colors={colors} openAgent={navigation ? input => navigation.openAgent(input) : undefined} />
      <WorkspaceOwner colors={colors} workspaceId={workspaceId} />
      <Segmented<Tab> colors={colors} value={tab} onChange={setTab} options={[
        { value: "people", label: "Thành viên" },
        { value: "messages", label: counted("Tin nhắn", unreadIn(direct)) },
        { value: "groups", label: counted("Nhóm", unreadIn(groups)) },
        { value: "attention", label: counted("Cần lưu ý", needsYouCount(attention.items)) },
      ]} />
    </View>
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: spacing[2] }}>
      {openError ? <View style={{ paddingHorizontal: spacing[2], paddingBottom: spacing[3] }}><ErrorLine colors={colors} message={openError} /></View> : null}
      {body}
    </ScrollView>
  </View>;
}

// A conversation tab's list: **Chưa đọc** above **Gần đây**, each newest first.
function ConversationList({ colors, me, presence, opening, badge, conversations, empty, onOpen }: {
  colors: Colors; me: string; presence: ReadonlyMap<string, Presence>; opening: string | null; badge(summary: Listed): ReactNode;
  conversations: readonly Listed[]; empty: string; onOpen(summary: Listed): void;
}) {
  if (!conversations.length) return <Hint colors={colors}>{empty}</Hint>;
  const { unread, read } = splitUnread(conversations);
  const items = (list: readonly Listed[]) => list.map(summary => <ConversationItem key={summary.id} colors={colors} me={me} summary={summary}
    presence={presence} busy={opening === summary.id} badge={badge(summary)} onPress={() => onOpen(summary)} />);
  return <>
    {unread.length ? <Section colors={colors} title="Chưa đọc">{items(unread)}</Section> : null}
    {read.length ? <Section colors={colors} title="Gần đây">{items(read)}</Section> : null}
  </>;
}

// Paseo's section title (style guide §7.2): small, muted, normal weight.
function Section({ colors, title, children }: { colors: Colors; title: string; children: ReactNode }) {
  return <View style={{ marginBottom: spacing[4] }}>
    <Text accessibilityRole="header" style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, paddingHorizontal: spacing[2], paddingTop: spacing[1], paddingBottom: spacing[1] }}>{title}</Text>
    {children}
  </View>;
}

// A conversation: its name and when it last moved, then who wrote last and what, so the list shows what
// each one is about. Unread reads in the foreground with the unread count, the rest muted, so the eye
// lands on what needs reading.
function ConversationItem({ colors, me, summary, presence, busy, badge, onPress }: {
  colors: Colors; me: string; summary: Listed; presence: ReadonlyMap<string, Presence>; busy: boolean; badge: ReactNode; onPress(): void;
}) {
  const partner = partnerOf(summary.conversation, me);
  const unread = summary.unread > 0;
  const last = summary.last;
  const author = lastAuthorLabel(summary, me);
  const text = unread ? colors.foreground : colors.foregroundMuted;
  return <Pressable accessibilityRole="button" disabled={busy} onPress={onPress}
    accessibilityLabel={`${summary.title}${unread ? `, ${summary.unread} tin chưa đọc` : ""}`}
    style={state => ({
      flexDirection: "row", alignItems: "center", gap: spacing[2], minHeight: rowHeight, paddingVertical: spacing[1], paddingHorizontal: spacing[2], borderRadius: radius.lg,
      backgroundColor: state.pressed || hovered(state) || busy ? paseoColors(colors).interactionHighlight : "transparent",
    })}>
    {partner
      ? <Avatar colors={colors} handle={partner} size={32} presence={presence.get(partner) ?? "offline"} ring={colors.surface0} />
      : <View style={{ width: 32, height: 32, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 }}>
        <Icon name={isDm(summary.conversation) ? "UsersRound" : "Hash"} size={iconSize.sm} color={colors.foregroundMuted} />
      </View>}
    <View style={{ flex: 1, minWidth: 0, gap: spacing[0.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
        <Text numberOfLines={1} style={{ flex: 1, color: text, fontSize: fontSize.base, textAlign: "left" }}>{summary.title}</Text>
        {last ? <Text style={{ color: unread ? colors.accent : colors.foregroundMuted, fontSize: fontSize.sm }}>{shortTime(last.createdAt)}</Text> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
        <Text numberOfLines={1} style={{ flex: 1, color: text, fontSize: fontSize.sm, textAlign: "left" }}>
          {last ? `${author ? `${author}: ` : ""}${plainPreview(last.preview)}` : "Chưa có tin nhắn"}
        </Text>
        {busy ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : badge}
      </View>
    </View>
  </Pressable>;
}

// A panel list row (style guide §7.3): the whole row opens it; what is unread or online reads in the
// foreground, the rest muted, so the eye goes to what needs it. `detail` is a muted second line.
function ListRow({ colors, label, detail, leading, trailing, strong, busy, accessibilityLabel, onPress }: {
  colors: Colors; label: string; detail?: string; leading: ReactNode; trailing: ReactNode; strong: boolean; busy: boolean; accessibilityLabel: string; onPress(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={busy} onPress={onPress}
    style={state => ({
      flexDirection: "row", alignItems: "center", gap: spacing[2], minHeight: rowHeight, paddingVertical: spacing[1], paddingHorizontal: spacing[2], borderRadius: radius.lg,
      backgroundColor: state.pressed || hovered(state) || busy ? paseoColors(colors).interactionHighlight : "transparent",
    })}>
    <View style={{ width: 24, alignItems: "center" }}>{leading}</View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: strong ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.base, textAlign: "left" }}>{label}</Text>
      {detail ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "left" }}>{detail}</Text> : null}
    </View>
    {busy ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : trailing}
  </Pressable>;
}

function Hint({ colors, children }: { colors: Colors; children: ReactNode }) {
  return <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, paddingHorizontal: spacing[2], paddingVertical: spacing[1] }}>{children}</Text>;
}
