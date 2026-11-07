import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  conversationId, dmOf, isDm, maxDmMembers,
  type ChatPerson, type ChatSummary, type Presence,
} from "../shared/chat";
import { fold } from "../shared/fold";
import { AssistantAgentRows, useAssistantAgents } from "./AssistantAgents";
import { AssistantCard } from "./AssistantSetting";
import { AttentionRows, attentionCountLabel, needsYouCount, useAttention } from "./AttentionList";
import { Avatar, presenceColor } from "./Avatar";
import {
  agentsLabel, assistantActivity, assistantActivityLabel, byPresence, lastAuthorLabel, partnerOf, plainPreview, presenceLabel, shortTime, teamActivity, teamActivityLabel,
} from "./chat-list";
import { Button, CountBadge, EmptyState, ErrorLine, hovered, type Colors } from "./chat-ui";
import { controlHeight, fontSize, fontWeight, iconSize, paseoColors, radius, spacing } from "./paseo-theme";
import { useInbox } from "./useInbox";
import { useOpenConversation } from "./useOpenConversation";

// From the widest width AI, Cần lưu ý, conversations and people sit side by side. Below it AI and people share the
// first column, then Cần lưu ý, then conversations; below the next AI, Cần lưu ý and people share the left column
// beside conversations; below the narrowest everything stacks, AI first. Side columns share one width and conversations
// take twice it, so the columns stay even as the window grows; a side column never drops below sideColumnMinWidth.
const fourColumnMinWidth = 1480;
const threeColumnMinWidth = 1180;
const twoColumnMinWidth = 820;
const sideColumnMinWidth = 300;

type Styles = ReturnType<typeof makeStyles>;

// The AI (the AI Assistant: its workers answering for the person, its router and talk-to-myself tab), Cần lưu ý (what
// the assistant noted the person must not miss), conversations and people. Choosing a
// conversation or a person opens its conversation in a Paseo agent tab, where Paseo's own composer and timeline show
// it; `params.c` (a notification, or an agent asking) does the same. Choosing an agent opens its tab.
export function ChatScreen({ theme, params, navigation }: PluginScreenProps) {
  const { inbox, error } = useInbox();
  const agents = useAssistantAgents();
  const attention = useAttention();
  const { open, opening, error: openError } = useOpenConversation(navigation);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const [width, setWidth] = useState(0);
  const requested = useRef<string | null>(null);
  const colors = theme.colors;
  const s = useMemo(() => makeStyles(colors), [colors]);
  const me = inbox?.me ?? "";

  useEffect(() => {
    if (!params.c || requested.current === params.c) return;
    requested.current = params.c;
    void open(params.c);
  }, [params.c]);

  const openDm = (handles: string[]) => { void open(conversationId(dmOf([me, ...handles]))); };
  const needle = fold(filter.trim());
  const matches = (text: string) => fold(text).includes(needle);
  const others = byPresence((inbox?.people ?? []).filter(person => person.handle !== me));
  const presence = new Map(others.map(person => [person.handle, person.presence]));
  const conversations = (inbox?.conversations ?? []).filter(summary => matches(summary.title));
  const people = others.filter(person => matches(person.handle));
  const unread = (inbox?.conversations ?? []).reduce((total, summary) => total + summary.unread, 0);
  const loading = !inbox && !error;
  const wide = width >= twoColumnMinWidth;
  const three = width >= threeColumnMinWidth;
  const four = width >= fourColumnMinWidth;
  // Rows sit on the cards in two columns, on the page otherwise.
  const ring = wide ? colors.surface1 : colors.surface0;

  const conversationRows = conversations.map(summary => <ConversationRow
    key={summary.id} s={s} colors={colors} me={me} summary={summary} presence={presence} ring={ring}
    busy={opening === summary.id} onPress={() => { void open(summary.id); }}
  />);
  const personRows = people.map(person => <PersonRow
    key={person.handle} s={s} colors={colors} person={person} ring={ring}
    busy={opening === conversationId(dmOf([me, person.handle]))} onPress={() => openDm([person.handle])}
  />);
  const conversationsBody = loading
    ? <Text style={s.empty}>Đang tải...</Text>
    : conversationRows.length ? conversationRows
    : <EmptyState colors={colors} icon={filter ? "SearchX" : "MessagesSquare"}>{filter
      ? `Không có cuộc trò chuyện nào khớp "${filter.trim()}".`
      : "Chưa có cuộc trò chuyện. Chọn một người bên cạnh để bắt đầu."}</EmptyState>;
  const peopleBody = loading ? null : personRows.length ? personRows
    : <Text style={s.empty}>{filter ? "Không có ai khớp." : "Người dùng hiện ở đây khi host của họ chạy plugin chat."}</Text>;
  const conversationsTitle = <SectionTitle s={s} title="Cuộc trò chuyện" meta={unread ? `${unread > 99 ? "99+" : unread} chưa đọc` : undefined} accent />;
  const peopleTitle = <SectionTitle s={s} title="Mọi người" meta={teamActivityLabel(teamActivity(others))} />;
  const activity = agents.list ? assistantActivity(agents.list) : null;
  const aiTitle = <SectionTitle s={s} title="AI" meta={activity ? assistantActivityLabel(activity) || undefined : undefined} accent={Boolean(activity?.needs)} />;
  const openAgent = navigation ? (input: { agentId: string }) => navigation.openAgent(input) : undefined;
  const aiBody = <>
    <View style={s.assistant}>
      <AssistantCard colors={colors} openWorkspace={navigation ? input => navigation.openWorkspace(input) : undefined} openAgent={openAgent} />
    </View>
    <AssistantAgentRows colors={colors} list={agents.list} error={agents.error} openAgent={openAgent} />
  </>;
  const attentionTitle = <SectionTitle s={s} title="Cần lưu ý" meta={attentionCountLabel(attention.items)} accent={needsYouCount(attention.items) > 0} />;
  const attentionBody = <AttentionRows colors={colors} attention={attention} openAgent={openAgent} openConversation={id => { void open(id); }} />;
  const card = (title: ReactNode, body: ReactNode, style: object) => <View style={[s.card, style]}>
    {title}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.list}>{body}</ScrollView>
  </View>;

  return <View style={s.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={[s.page, wide && s.pageWide]}>
      <View style={s.header}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.heading}>Chat</Text>
          <Text style={s.subheading}>{me ? `Bạn là ${me}` : " "}</Text>
        </View>
        <Button colors={colors} variant="primary" icon="UsersRound" label="Nhóm mới" onPress={() => setPicking(true)} />
      </View>
      <SearchBox s={s} colors={colors} value={filter} onChange={setFilter} />
      {(openError ?? error) && <View style={s.alert}><ErrorLine colors={colors} message={(openError ?? error)!} /></View>}

      {four
        ? <View style={s.columns}>
          {card(aiTitle, aiBody, s.sideColumn)}
          {card(attentionTitle, attentionBody, s.sideColumn)}
          {card(conversationsTitle, conversationsBody, s.mainColumn)}
          {card(peopleTitle, peopleBody, s.sideColumn)}
        </View>
        : three
        ? <View style={s.columns}>
          <View style={[s.sideColumn, s.stack]}>
            {card(aiTitle, aiBody, { flex: 1 })}
            {card(peopleTitle, peopleBody, { flex: 1 })}
          </View>
          {card(attentionTitle, attentionBody, s.sideColumn)}
          {card(conversationsTitle, conversationsBody, s.mainColumn)}
        </View>
        : wide
        ? <View style={s.columns}>
          <View style={[s.sideColumn, s.stack]}>
            {card(aiTitle, aiBody, { flex: 1 })}
            {card(attentionTitle, attentionBody, { flex: 1 })}
            {card(peopleTitle, peopleBody, { flex: 1 })}
          </View>
          {card(conversationsTitle, conversationsBody, s.mainColumn)}
        </View>
        : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }}>
          {aiTitle}
          <View style={s.list}>{aiBody}</View>
          {attentionTitle}
          <View style={s.list}>{attentionBody}</View>
          {conversationsTitle}
          <View style={s.list}>{conversationsBody}</View>
          {peopleTitle}
          <View style={s.list}>{peopleBody}</View>
        </ScrollView>}
    </View>
    {picking && <GroupPicker s={s} colors={colors} people={others} onClose={() => setPicking(false)}
      onStart={handles => { setPicking(false); openDm(handles); }} />}
  </View>;
}

function ConversationRow({ s, colors, me, summary, presence, ring, busy, onPress }: {
  s: Styles; colors: Colors; me: string; summary: ChatSummary; presence: ReadonlyMap<string, Presence>; ring: string; busy: boolean; onPress: () => void;
}) {
  const dm = isDm(summary.conversation) ? summary.conversation : null;
  const partner = partnerOf(summary.conversation, me);
  const unread = summary.unread > 0;
  const last = summary.last;
  const author = lastAuthorLabel(summary, me);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${summary.title}${unread ? `, ${summary.unread} tin chưa đọc` : ""}`}
    onPress={onPress}
    style={state => [s.row, (hovered(state) || busy) && s.rowHover, state.pressed && s.rowPressed]}
  >
    {partner
      ? <Avatar colors={colors} handle={partner} size={40} presence={presence.get(partner) ?? "offline"} ring={ring} />
      : <GlyphAvatar s={s} colors={colors} icon={dm ? "UsersRound" : "Hash"} size={40} />}
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <View style={s.line}>
        <Text style={[s.title, unread && s.titleUnread]} numberOfLines={1}>{summary.title}</Text>
        {last && <Text style={[s.time, unread && { color: colors.accent }]}>{shortTime(last.createdAt)}</Text>}
      </View>
      <View style={s.line}>
        {last
          ? <Text style={[s.preview, unread && { color: colors.foreground }]} numberOfLines={1}>
            {author ? <Text style={s.previewAuthor}>{author}</Text> : null}
            {author ? ": " : ""}{plainPreview(last.preview)}
          </Text>
          : <Text style={s.preview} numberOfLines={1}>Chưa có tin nhắn</Text>}
        {unread && <CountBadge colors={colors} count={summary.unread} mention={summary.mentioned} />}
      </View>
    </View>
  </Pressable>;
}

function PersonRow({ s, colors, person, ring, busy, onPress }: {
  s: Styles; colors: Colors; person: ChatPerson; ring: string; busy: boolean; onPress: () => void;
}) {
  const status = presenceLabel(person);
  const agents = agentsLabel(person.agents);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={[`Nhắn riêng ${person.handle}`, status, agents].filter(Boolean).join(", ")}
    onPress={onPress}
    style={state => [s.row, s.rowCompact, (hovered(state) || busy) && s.rowHover, state.pressed && s.rowPressed]}
  >
    <Avatar colors={colors} handle={person.handle} size={32} presence={person.presence} ring={ring} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[s.title, person.presence === "offline" && { color: colors.foregroundMuted }]} numberOfLines={1}>{person.handle}</Text>
      {status || agents ? <Text style={s.time} numberOfLines={1}>
        {status ? <Text style={person.presence === "offline" ? null : { color: presenceColor(colors, person.presence) }}>{status}</Text> : null}
        {status && agents ? " · " : ""}{agents}
      </Text> : null}
    </View>
    <Icon name="MessageCircle" size={iconSize.sm} color={colors.foregroundMuted} />
  </Pressable>;
}

function GroupPicker({ s, colors, people, onClose, onStart }: {
  s: Styles; colors: Colors; people: ChatPerson[]; onClose: () => void; onStart: (handles: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const needle = fold(filter.trim());
  const full = picked.length >= maxDmMembers - 1;
  return <Modal title="Nhóm mới" icon={<Icon name="UsersRound" size={iconSize.lg} color={colors.foreground} />} open onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}>
      <SearchBox s={s} colors={colors} value={filter} onChange={setFilter} placeholder="Tìm người…" />
      <Text style={s.time}>Đã chọn {picked.length}/{maxDmMembers - 1}</Text>
      <View>
        {people.filter(person => fold(person.handle).includes(needle)).map(person => {
          const checked = picked.includes(person.handle);
          return <Pressable
            key={person.handle}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled: !checked && full }}
            disabled={!checked && full}
            onPress={() => setPicked(checked ? picked.filter(handle => handle !== person.handle) : [...picked, person.handle])}
            style={state => [s.row, s.rowCompact, hovered(state) && s.rowHover, !checked && full && { opacity: 0.4 }]}
          >
            <Avatar colors={colors} handle={person.handle} size={32} presence={person.presence} ring={colors.surface1} />
            <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>{person.handle}</Text>
            <View style={[s.check, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
              {checked && <Icon name="Check" size={iconSize.xs} color={colors.accentForeground} />}
            </View>
          </Pressable>;
        })}
      </View>
      <Button colors={colors} variant="primary" stretch disabled={!picked.length} onPress={() => onStart(picked)}
        label={picked.length ? `Bắt đầu với ${picked.length} người` : "Chọn ít nhất một người"} />
    </Modal.Content>
  </Modal>;
}

function SearchBox({ s, colors, value, onChange, placeholder = "Tìm người hoặc cuộc trò chuyện…" }: {
  s: Styles; colors: Colors; value: string; onChange: (value: string) => void; placeholder?: string;
}) {
  return <View style={s.search}>
    <Icon name="Search" size={iconSize.sm} color={colors.foregroundMuted} />
    <TextInput
      accessibilityLabel={placeholder}
      placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted}
      value={value}
      onChangeText={onChange}
      style={s.searchInput}
    />
    {value ? <Pressable accessibilityRole="button" accessibilityLabel="Xoá tìm kiếm" onPress={() => onChange("")} hitSlop={8}>
      <Icon name="X" size={iconSize.sm} color={colors.foregroundMuted} />
    </Pressable> : null}
  </View>;
}

function SectionTitle({ s, title, meta, accent }: { s: Styles; title: string; meta?: string; accent?: boolean }) {
  return <View style={s.sectionTitle}>
    <Text style={s.sectionText}>{title}</Text>
    {meta && <Text style={[s.sectionMeta, accent && s.sectionMetaAccent]} numberOfLines={1}>{meta}</Text>}
  </View>;
}

function GlyphAvatar({ s, colors, icon, size }: { s: Styles; colors: Colors; icon: string; size: number }) {
  return <View style={[s.avatar, { width: size, height: size, borderRadius: size * 0.3, backgroundColor: colors.surface2 }]}>
    <Icon name={icon} size={Math.round(size * 0.45)} color={colors.foregroundMuted} />
  </View>;
}

function makeStyles(colors: Colors) {
  const paseo = paseoColors(colors);
  return StyleSheet.create({
    root: { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
    page: { flex: 1, minHeight: 0, width: "100%", paddingTop: spacing[4] },
    pageWide: { paddingTop: spacing[6], paddingHorizontal: spacing[3] },
    header: { flexDirection: "row", alignItems: "center", gap: spacing[3], paddingHorizontal: spacing[4], paddingBottom: spacing[3] },
    heading: { color: colors.foreground, fontSize: fontSize["2xl"], fontWeight: fontWeight.normal },
    subheading: { color: colors.foregroundMuted, fontSize: fontSize.sm, marginTop: spacing[0.5] },
    search: {
      flexDirection: "row", alignItems: "center", gap: spacing[2], marginHorizontal: spacing[4], marginBottom: spacing[3],
      minHeight: controlHeight.compact, paddingHorizontal: spacing[3],
      backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    },
    searchInput: { flex: 1, color: colors.foreground, paddingVertical: spacing[1.5], fontSize: fontSize.base, outlineStyle: "none" } as object,
    alert: { marginHorizontal: spacing[4], marginBottom: spacing[3], padding: spacing[3], borderRadius: radius.lg, borderWidth: 1, borderColor: colors.statusDanger },
    columns: { flex: 1, minHeight: 0, flexDirection: "row", gap: spacing[4], paddingHorizontal: spacing[4], paddingBottom: spacing[4] },
    sideColumn: { flex: 1, minWidth: sideColumnMinWidth },
    mainColumn: { flex: 2, minWidth: 0 },
    stack: { gap: spacing[4] },
    card: { minHeight: 0, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: "hidden" },
    list: { paddingHorizontal: spacing[1.5], paddingBottom: spacing[2] },
    sectionTitle: { flexDirection: "row", alignItems: "baseline", gap: spacing[2], paddingHorizontal: spacing[4], paddingTop: spacing[3], paddingBottom: spacing[2] },
    // Title and count share one line so every column's header has the same height; a long count ends in an ellipsis.
    sectionText: { color: colors.foreground, fontSize: fontSize.base, fontWeight: fontWeight.medium, flexShrink: 0 },
    sectionMeta: { flex: 1, color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "right" },
    assistant: { paddingBottom: spacing[2] },
    sectionMetaAccent: { color: colors.accent, fontWeight: fontWeight.medium },
    row: { flexDirection: "row", alignItems: "center", gap: spacing[3], paddingHorizontal: spacing[2], paddingVertical: spacing[2], borderRadius: radius.lg },
    rowCompact: { gap: spacing[2], paddingVertical: spacing[1.5] },
    rowHover: { backgroundColor: paseo.interactionHighlight },
    rowPressed: { backgroundColor: paseo.interactionHighlight },
    line: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
    // Rows are web <button>s, which center text unless told otherwise.
    title: { flex: 1, color: colors.foreground, fontSize: fontSize.base, fontWeight: fontWeight.normal, textAlign: "left" },
    titleUnread: { fontWeight: fontWeight.medium },
    time: { color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "left" },
    preview: { flex: 1, color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "left" },
    previewAuthor: { fontWeight: fontWeight.medium },
    avatar: { alignItems: "center", justifyContent: "center" },
    check: { width: 18, height: 18, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.foregroundMuted, alignItems: "center", justifyContent: "center" },
    empty: { color: colors.foregroundMuted, fontSize: fontSize.sm, padding: spacing[3], textAlign: "left" },
  });
}
