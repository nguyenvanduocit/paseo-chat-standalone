import { useMyRpc } from "./me";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { openRouter, openSelf, renewTab, type RenewableTab } from "../shared/assistant";
import { readAssistantAgents, type AgentState, type AssistantAgents, type AssistantTab, type WorkerRow } from "../shared/assistant-agents";
import { agentStatusLabel, workerConversationsLabel } from "./chat-list";
import { hovered, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { fontSize, fontWeight, iconSize, paseoColors, radius, spacing } from "./paseo-theme";
import { RowMenu } from "./RowMenu";

// The Chat screen's AI column body: the AI Assistant's workers answering messages for the person (what waits on the
// person first, order from shared/assistant-agents.ts), then its router and the talk-to-myself tab. Picking a worker
// opens it; the router and talk-to-myself rows open theirs, creating it when there is none, as the assistant's own
// buttons do. Their ⋯ menu starts the tab over: a new one takes its place and opens, the old one is archived, and the
// talk-to-myself tab writes what the old one learned into the persona (server/assistant.ts `renew`).

type OpenAgent = (input: { agentId: string }) => void;

// Tabs change state within seconds; the server reads them from this host's daemon.
const pollMs = 5_000;

export function useAssistantAgents() {
  const read = useMyRpc(readAssistantAgents);
  const [list, setList] = useState<AssistantAgents | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await read({});
        if (!cancelled) { setList(next); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(userErrorMessage(failure));
      } finally {
        if (!cancelled) timer = setTimeout(poll, pollMs);
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [read]);
  return { list, error };
}

function stateColor(colors: Colors, state: AgentState): string {
  if (state === "permission") return colors.statusWarning;
  if (state === "error") return colors.statusDanger;
  if (state === "finished") return colors.accent;
  if (state === "running") return colors.statusSuccess;
  return colors.foregroundMuted;
}

function stateTint(colors: Colors, state: AgentState): string {
  const paseo = paseoColors(colors);
  if (state === "permission") return paseo.statusWarningTint;
  if (state === "error") return paseo.statusDangerTint;
  if (state === "running") return paseo.statusSuccessTint;
  return colors.surface2;
}

const stateIcons: Record<"permission" | "error" | "finished", string> = { permission: "ShieldAlert", error: "CircleAlert", finished: "CircleCheck" };

// The tab's state when it is doing something, else what the tab is (`icon`).
function TabGlyph({ colors, state, icon }: { colors: Colors; state: AgentState | null; icon: string }) {
  return <View style={{
    width: 32, height: 32, borderRadius: radius.lg, alignItems: "center", justifyContent: "center",
    backgroundColor: state ? stateTint(colors, state) : colors.surface2,
  }}>
    {state === "running"
      ? <ActivityIndicator size="small" color={stateColor(colors, state)} />
      : <Icon name={state && state !== "idle" ? stateIcons[state] : icon} size={iconSize.sm} color={state ? stateColor(colors, state) : colors.foregroundMuted} />}
  </View>;
}

function TabRow({ colors, title, tab, icon, lines, onPress, onRenew }: {
  colors: Colors; title: string; tab: AssistantTab | null; icon: string; lines: string[]; onPress?: () => void; onRenew?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = tab ? agentStatusLabel(tab) : "Chưa mở";
  const [detail, ...more] = lines.filter(Boolean);
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "left" as const };
  const row = <Pressable
    accessibilityRole="button"
    accessibilityLabel={[`Mở ${title}`, status, ...lines].filter(Boolean).join(", ")}
    disabled={!onPress}
    onPress={onPress}
    style={state => ({
      flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing[2], paddingHorizontal: spacing[2], paddingVertical: spacing[1.5], borderRadius: radius.lg,
      backgroundColor: state.pressed || hovered(state) ? paseoColors(colors).interactionHighlight : "transparent",
    })}
  >
    <TabGlyph colors={colors} state={tab?.state ?? null} icon={icon} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: tab && tab.state !== "idle" ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.base, textAlign: "left" }}>{title}</Text>
      <Text numberOfLines={1} style={muted}>
        <Text style={tab && tab.state !== "idle" ? { color: stateColor(colors, tab.state) } : null}>{status}</Text>
        {detail ? ` · ${detail}` : ""}
      </Text>
      {more.map(line => <Text key={line} numberOfLines={1} style={muted}>{line}</Text>)}
    </View>
  </Pressable>;
  // The row with an open menu draws above the rows after it, which the menu overlaps.
  return <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[1], zIndex: menuOpen ? 1 : 0 }}>
    {row}
    {onRenew ? <RowMenu colors={colors} title={title} open={menuOpen} onToggle={setMenuOpen}
      entries={[{ icon: "RefreshCcw", label: "Tạo agent mới", onSelect: onRenew }]} /> : null}
  </View>;
}

function Heading({ colors, children }: { colors: Colors; children: string }) {
  return <Text style={{
    color: colors.foregroundMuted, fontSize: fontSize.sm, fontWeight: fontWeight.medium, textAlign: "left",
    paddingHorizontal: spacing[2], paddingTop: spacing[2], paddingBottom: spacing[1],
  }}>{children}</Text>;
}

export function AssistantAgentRows({ colors, list, error, openAgent }: {
  colors: Colors; list: AssistantAgents | null; error: string | null; openAgent?: OpenAgent;
}) {
  const openRouterTab = useMyRpc(openRouter);
  const openSelfTab = useMyRpc(openSelf);
  const renew = useMyRpc(renewTab);
  const [openError, setOpenError] = useState<string | null>(null);
  const muted = { color: colors.foregroundMuted, fontSize: fontSize.sm, padding: spacing[2], textAlign: "left" as const };
  if (!list) return <Text style={error ? { ...muted, color: colors.statusDanger } : muted}>{error ?? "Đang tải..."}</Text>;
  // The router and talk-to-myself rows go through the assistant's RPCs, which create the tab when there is none.
  const open = (rpc: () => Promise<{ agentId: string }>) => openAgent ? () => {
    setOpenError(null);
    rpc().then(openAgent, failure => setOpenError(userErrorMessage(failure)));
  } : undefined;
  const renewer = (tab: RenewableTab) => open(() => renew({ tab }));
  const worker = (row: WorkerRow) => <TabRow key={row.id} colors={colors} title={row.title} tab={row} icon="Bot"
    lines={[workerConversationsLabel(row), row.topic ?? ""]} onPress={openAgent ? () => openAgent({ agentId: row.id }) : undefined} />;
  return <>
    <Heading colors={colors}>Worker trả lời tin nhắn</Heading>
    {list.workers.map(worker)}
    {!list.workers.length ? <Text style={muted}>Chưa có worker nào làm việc trong ngày qua. Ai nhắn riêng hoặc nhắc tên bạn, router giao việc cho một worker và nó hiện ở đây.</Text> : null}
    {list.hiddenWorkers ? <Text style={muted}>{`+${list.hiddenWorkers} worker khác đang rảnh lâu hoặc đã lưu trữ`}</Text> : null}
    <Heading colors={colors}>Điều phối</Heading>
    <TabRow colors={colors} title="Router" tab={list.router} icon="Route" lines={["Nhận tin, giao cho worker"]}
      onPress={open(() => openRouterTab({}))} onRenew={renewer("router")} />
    <TabRow colors={colors} title="Talk to myself" tab={list.self} icon="Sparkles" lines={["Bạn và AI chỉnh persona"]}
      onPress={open(() => openSelfTab({}))} onRenew={renewer("self")} />
    {openError ?? error ? <Text style={{ ...muted, color: colors.statusDanger }}>{openError ?? error}</Text> : null}
  </>;
}
