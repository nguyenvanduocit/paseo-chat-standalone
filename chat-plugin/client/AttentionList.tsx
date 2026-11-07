import { type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useMe, useMyRpc } from "./me";
import { Icon, ScrollView, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  changeAttention, forkAttention, readAttention, waitingOnOthers, type AttentionItemKind, type ShownAttentionItem,
} from "../shared/attention";
import { attentionDueLabel } from "./chat-list";
import { CountBadge, ErrorLine, hovered, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { fontSize, fontWeight, iconSize, paseoColors, radius, spacing } from "./paseo-theme";
import { RowMenu } from "./RowMenu";
import { useOpenConversation } from "./useOpenConversation";

// "Cần lưu ý": what the AI Assistant noted the person must not miss from their chats (shared/attention.ts), timed items
// soonest first, and the work of its workers that the router could not settle. It has its own column on the Chat
// screen, its own tab in the Chat panel, and its own screen behind its own sidebar row, with one column per kind.
// Picking one opens the agent that wrote it, or the stuck worker, where the work behind it is (an item older than the
// agent id opens its conversation); the row's ⋯ menu forks that agent into a new tab to talk on about the item
// (server/attention-fork.ts), marks it done or removes it.

export const attentionScreenId = "attention";

const pollMs = 5_000;

export function useAttention() {
  const read = useMyRpc(readAttention);
  const change = useMyRpc(changeAttention);
  const forkRpc = useMyRpc(forkAttention);
  const [items, setItems] = useState<ShownAttentionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const me = useMe();
  useEffect(() => {
    setItems(null);
    if (me === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await read({});
        if (!cancelled) { setItems(next.items); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(userErrorMessage(failure));
      } finally {
        if (!cancelled) timer = setTimeout(poll, pollMs);
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [read, tick, me]);
  // The row leaves at once; the next read confirms it.
  const act = useCallback(async (id: string, action: AttentionAction) => {
    setItems(current => current?.filter(item => item.id !== id) ?? null);
    try {
      await change({ id, action });
    } catch (failure) {
      setError(userErrorMessage(failure));
    } finally {
      setTick(value => value + 1);
    }
  }, [change]);
  // The new tab's id, or null when the fork failed and `error` says why.
  const fork = useCallback(async (id: string) => {
    try {
      return (await forkRpc({ id })).agentId;
    } catch (failure) {
      setError(userErrorMessage(failure));
      return null;
    }
  }, [forkRpc]);
  return { items, error, act, fork };
}

const kindIcons: Record<AttentionItemKind, string> = { todo: "ListTodo", event: "CalendarClock", note: "StickyNote", blocker: "OctagonAlert" };
const kindNames: Record<AttentionItemKind, string> = { todo: "Việc cần làm", event: "Sự kiện", note: "Ghi chú", blocker: "AI bị vướng" };

type AttentionAction = "done" | "remove";
function AttentionRow({ colors, item, onOpen, onFork, onAct }: {
  colors: Colors; item: ShownAttentionItem; onOpen?: () => void; onFork?: () => void; onAct: (action: AttentionAction) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const due = item.due ? attentionDueLabel(item.due) : "";
  const late = item.due !== null && Date.parse(item.due) < Date.now();
  // A blocker whose person's part is done stays in sight, muted, until its worker settles the work.
  const waiting = waitingOnOthers(item);
  // An overdue item, or a worker that waits on the person, is drawn as a warning.
  const warn = late || (item.kind === "blocker" && !waiting);
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "left" as const };
  // The row with an open menu draws above the rows after it, which the menu overlaps.
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[1], borderRadius: radius.lg, zIndex: menuOpen ? 1 : 0 }}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[kindNames[item.kind], waiting ? waitingText : "", item.title, due, `trong ${item.conversationTitle}`, `ghi bởi ${item.by}`].filter(Boolean).join(", ")}
      disabled={!onOpen}
      onPress={onOpen}
      style={state => ({
        flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: spacing[2],
        paddingHorizontal: spacing[2], paddingVertical: spacing[1.5], borderRadius: radius.lg,
        backgroundColor: state.pressed || hovered(state) ? paseoColors(colors).interactionHighlight : "transparent",
      })}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={waiting ? "Hourglass" : kindIcons[item.kind]} size={iconSize.sm}
          color={warn ? colors.statusWarning : waiting ? colors.foregroundMuted : colors.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={{ color: waiting ? colors.foregroundMuted : colors.foreground, fontSize: fontSize.base, textAlign: "left" }}>{item.title}</Text>
        <Text numberOfLines={1} style={muted}>
          {waiting ? `${waitingText} · ` : ""}
          {due ? <Text style={{ color: late ? colors.statusWarning : colors.foreground, fontWeight: fontWeight.medium }}>{due}</Text> : null}
          {due ? " · " : ""}{item.conversationTitle} · {item.by}
        </Text>
        {item.detail ? <Text numberOfLines={2} style={muted}>{item.detail}</Text> : null}
      </View>
    </Pressable>
    <View style={{ paddingTop: spacing[1] }}>
      <RowMenu colors={colors} title={item.title} open={menuOpen} onToggle={setMenuOpen} entries={[
        ...onFork ? [{ icon: "GitFork", label: "Fork để hỏi tiếp", onSelect: onFork }] : [],
        { icon: "Check", label: "Đánh dấu xong", onSelect: () => onAct("done") },
        { icon: "Trash2", label: "Bỏ khỏi danh sách", onSelect: () => onAct("remove") },
      ]} />
    </View>
  </View>;
}

const waitingText = "Bạn đã xong · AI chờ người khác";

// The open items that need the person: all but the blockers waiting on others. What the counts of the list count.
export const needsYouCount = (items: ShownAttentionItem[] | null) => items?.filter(item => !waitingOnOthers(item)).length ?? 0;

// "2 mục · 1 quá hạn · 1 chờ người khác", or nothing while the list is loading or empty.
export function attentionCountLabel(items: ShownAttentionItem[] | null): string | undefined {
  if (!items?.length) return undefined;
  const late = items.filter(item => item.due !== null && Date.parse(item.due) < Date.now()).length;
  const waiting = items.length - needsYouCount(items);
  return [`${needsYouCount(items)} mục`, late ? `${late} quá hạn` : "", waiting ? `${waiting} chờ người khác` : ""].filter(Boolean).join(" · ");
}

type Openers = { openAgent?: (input: { agentId: string }) => void; openConversation?: (id: string) => void };

// The rows of `items`, each opening the agent that wrote it, or its conversation when the agent is not known; an item
// whose agent is known forks it into a new tab, which opens.
function ItemRows({ colors, items, act, fork, openAgent, openConversation }: Openers & {
  colors: Colors; items: ShownAttentionItem[]; act: ReturnType<typeof useAttention>["act"]; fork: ReturnType<typeof useAttention>["fork"];
}) {
  const opener = (item: ShownAttentionItem) => item.agentId && openAgent ? () => openAgent({ agentId: item.agentId! })
    : openConversation ? () => openConversation(item.conversation) : undefined;
  const forker = (item: ShownAttentionItem) => item.agentId && openAgent ? () => {
    void fork(item.id).then(agentId => { if (agentId) openAgent({ agentId }); });
  } : undefined;
  return <>{items.map(item => <AttentionRow key={item.id} colors={colors} item={item}
    onOpen={opener(item)} onFork={forker(item)} onAct={action => { void act(item.id, action); }} />)}</>;
}

const emptyText = "Chưa có gì cần lưu ý. AI Assistant ghi lại ở đây việc cần làm, sự kiện và ghi chú quan trọng từ tin nhắn gửi cho bạn, và việc AI bị vướng mà router không gỡ được.";

// The list as one column: the Chat screen's column and the Chat panel's tab.
export function AttentionRows({ colors, attention, ...openers }: Openers & { colors: Colors; attention: ReturnType<typeof useAttention> }) {
  const { items, error, act, fork } = attention;
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, padding: spacing[2], textAlign: "left" as const };
  return <>
    {items === null
      ? <Text style={muted}>{error ? "" : "Đang tải..."}</Text>
      : items.length
      ? <ItemRows colors={colors} items={items} act={act} fork={fork} {...openers} />
      : <Text style={muted}>{emptyText}</Text>}
    {error ? <Text style={{ ...muted, color: colors.statusDanger }}>{error}</Text> : null}
  </>;
}

// The screen's columns, the work only the person can settle first. Each keeps the list's order (timed items soonest first).
const columnKinds: readonly AttentionItemKind[] = ["blocker", "todo", "event", "note"];
// From this width the columns sit side by side; below it they stack.
const sideBySideMinWidth = 960;

function AttentionColumns({ colors, attention, sideBySide, ...openers }: Openers & {
  colors: Colors; attention: ReturnType<typeof useAttention>; sideBySide: boolean;
}) {
  const { items, error, act, fork } = attention;
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, padding: spacing[2], textAlign: "left" as const };
  if (!items?.length) {
    return <View style={columnStyle(colors)}>
      <Text style={muted}>{items === null ? (error ? "" : "Đang tải...") : emptyText}</Text>
    </View>;
  }
  return <View style={{ flexDirection: sideBySide ? "row" : "column", alignItems: sideBySide ? "flex-start" : "stretch", gap: spacing[3] }}>
    {columnKinds.map((kind, index) => {
      const shown = items.filter(item => item.kind === kind);
      // Earlier columns draw above later ones, which a menu opened at the bottom of a stacked column overlaps.
      return <View key={kind} style={[columnStyle(colors), { zIndex: columnKinds.length - index }, sideBySide && { flex: 1, minWidth: 0 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2], paddingHorizontal: spacing[2], paddingVertical: spacing[1.5] }}>
          <Icon name={kindIcons[kind]} size={iconSize.sm} color={kind === "blocker" && needsYouCount(shown) ? colors.statusWarning : colors.foregroundMuted} />
          <Text style={{ flex: 1, color: colors.foreground, fontSize: fontSize.base, fontWeight: fontWeight.medium }}>{kindNames[kind]}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>{shown.length}</Text>
        </View>
        {shown.length
          ? <ItemRows colors={colors} items={shown} act={act} fork={fork} {...openers} />
          : <Text style={muted}>Không có mục nào.</Text>}
      </View>;
    })}
  </View>;
}

const columnStyle = (colors: Colors) => ({
  backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing[1.5],
});

// The Cần lưu ý screen: one column per kind, side by side when the screen is wide enough.
export function AttentionScreen({ theme, navigation }: PluginScreenProps) {
  const colors = theme.colors;
  const attention = useAttention();
  const { open, error } = useOpenConversation(navigation);
  const [width, setWidth] = useState(0);
  const count = attentionCountLabel(attention.items);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ width: "100%", maxWidth: 1600, alignSelf: "center", padding: spacing[4], paddingTop: spacing[6], gap: spacing[3] }}>
      <View>
        <Text style={{ color: colors.foreground, fontSize: fontSize["2xl"], fontWeight: fontWeight.normal }}>Cần lưu ý</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, marginTop: spacing[0.5] }}>
          {count ? `${count}. ` : ""}Việc cần làm, sự kiện và ghi chú AI Assistant ghi lại từ tin nhắn gửi cho bạn, và việc AI bị vướng cần bạn gỡ.
        </Text>
      </View>
      {error ? <ErrorLine colors={colors} message={error} /> : null}
      {attention.error ? <ErrorLine colors={colors} message={attention.error} /> : null}
      <AttentionColumns colors={colors} attention={attention} sideBySide={width >= sideBySideMinWidth}
        openAgent={navigation ? input => navigation.openAgent(input) : undefined} openConversation={id => { void open(id); }} />
    </ScrollView>
  </View>;
}

// The sidebar row of the Cần lưu ý screen, counting the open items.
export function AttentionSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const count = needsYouCount(useAttention().items);
  return <SidebarRow
    icon="ListChecks"
    label="Cần lưu ý"
    active={currentScreen?.screenId === attentionScreenId}
    onPress={() => openScreen({ screenId: attentionScreenId })}
    trailing={count > 0 ? <CountBadge colors={theme.colors} count={count} /> : undefined}
  />;
}
