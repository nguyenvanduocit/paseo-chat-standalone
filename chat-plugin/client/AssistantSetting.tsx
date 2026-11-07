import { useMyRpc } from "./me";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { openRouter, openSelf, readAssistant } from "../shared/assistant";
import { Button, ErrorLine, hovered, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { fontSize, fontWeight, iconSize, paseoColors, radius, spacing } from "./paseo-theme";

// The AI Assistant as the Chat screen and the Chat panel show it, always on: one router tab receives what people write
// to the person directly or mention them in and hands each piece of work to a worker tab (server/assistant.ts delivers,
// in the workspace of the person's persona directory), and the talk-to-myself tab where the person and the AI shape the
// persona (server/self.ts).

type AssistantView = z.infer<typeof readAssistant.output>;
type OpenWorkspace = (input: { workspaceId: string }) => void;
type OpenAgent = (input: { agentId: string }) => void;

const pollMs = 10_000;
const receives = "Một router nhận tin nhắn riêng và tin nhắc tên bạn, rồi giao từng việc cho worker phụ trách việc đó";

const timeAgo = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} phút trước`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} giờ trước`;
  return `${Math.round(minutes / 60 / 24)} ngày trước`;
};

// The assistant's workspace, its tabs and the persona, refreshed every few seconds.
function useAssistant() {
  const read = useMyRpc(readAssistant);
  const openSelfTab = useMyRpc(openSelf);
  const openRouterTab = useMyRpc(openRouter);
  const [view, setView] = useState<AssistantView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await read({});
        if (!cancelled) { setView(next); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(userErrorMessage(failure));
      } finally {
        if (!cancelled) timer = setTimeout(poll, pollMs);
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [read, tick]);

  return {
    loading: view === null && !error,
    view,
    selfWorking: view?.selfWorking === true,
    opening,
    error,
    // Opens the talk-to-myself tab or the router in the assistant's workspace, creating it when there is none.
    async open(tab: "self" | "router", openAgent: OpenAgent) {
      setOpening(true);
      try {
        openAgent(await (tab === "self" ? openSelfTab : openRouterTab)({}));
        setError(null);
      } catch (failure) {
        setError(userErrorMessage(failure));
      } finally {
        setOpening(false);
        setTick(value => value + 1);
      }
    },
  };
}

type Assistant = ReturnType<typeof useAssistant>;

// What the assistant is doing now, in a title and one line.
function describe(assistant: Assistant): { title: string; detail: string } {
  const tabs = assistant.view?.tabs;
  const counts = tabs?.open ? ` · ${tabs.open} tab, ${tabs.running} đang chạy` : "";
  return { title: "Luôn bật", detail: `${receives}${counts}` };
}

function personaLine(assistant: Assistant): string {
  const persona = assistant.view?.persona;
  const files = persona?.files ? `Persona ${persona.files} file` : "Chưa có persona";
  if (assistant.selfWorking) return `${files} · Talk to myself đang chạy…`;
  return persona?.updatedAt ? `${files} · cập nhật ${timeAgo(persona.updatedAt)}, tự cập nhật mỗi ngày` : files;
}

// The top of the Chat screen's AI column: what the assistant does and the persona, then a button to open its workspace.
// The router and talk-to-myself tab are rows below it (client/AssistantAgents.tsx).
export function AssistantCard({ colors, openWorkspace, openAgent }: { colors: Colors; openWorkspace?: OpenWorkspace; openAgent?: OpenAgent }) {
  const assistant = useAssistant();
  const shown = describe(assistant);
  const workspaceId = assistant.view?.workspaceId ?? null;
  return <View style={{
    gap: spacing[2], padding: spacing[3], backgroundColor: colors.surface0, borderWidth: 1, borderRadius: radius.lg, borderColor: colors.border,
  }}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing[3] }}>
      <AssistantGlyph colors={colors} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: spacing[0.5] }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>AI Assistant</Text>
        {assistant.loading
          ? <ActivityIndicator size="small" color={colors.foregroundMuted} style={{ alignSelf: "flex-start" }} />
          : <>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.base, fontWeight: fontWeight.medium }}>{shown.title}</Text>
            <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>{shown.detail}</Text>
            <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>{personaLine(assistant)}</Text>
          </>}
        {assistant.error ? <ErrorLine colors={colors} message={assistant.error} /> : null}
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[1] }}>
      {workspaceId && openWorkspace
        ? <Button colors={colors} variant="ghost" icon="SquareArrowOutUpRight" label="Mở" onPress={() => openWorkspace({ workspaceId })} />
        : null}
    </View>
  </View>;
}

type TabButtonProps = { colors: Colors; assistant: Assistant; openAgent: OpenAgent; onOpened?(): void };

// Opens the talk-to-myself tab, to talk about the persona.
function TalkButton({ colors, assistant, openAgent, onOpened }: TabButtonProps) {
  return <Button colors={colors} variant="ghost" icon="Sparkles" label="Talk to myself" disabled={assistant.opening}
    onPress={() => { void assistant.open("self", input => { openAgent(input); onOpened?.(); }); }} />;
}

// Opens the router, to watch which worker each message went to.
function RouterButton({ colors, assistant, openAgent, onOpened }: TabButtonProps) {
  return <Button colors={colors} variant="ghost" icon="Route" label="Router" disabled={assistant.opening}
    onPress={() => { void assistant.open("router", input => { openAgent(input); onOpened?.(); }); }} />;
}

// The Chat panel's row (style guide §7.3): the whole row opens the assistant's dialog.
export function AssistantRow({ colors, openAgent }: { colors: Colors; openAgent?: OpenAgent }) {
  const assistant = useAssistant();
  const [showing, setShowing] = useState(false);
  const shown = describe(assistant);
  const tabs = assistant.view?.tabs;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`AI Assistant: ${shown.title}. Mở cài đặt`}
      onPress={() => setShowing(true)}
      style={state => ({
        flexDirection: "row", alignItems: "center", gap: spacing[2], minHeight: 36, paddingVertical: spacing[1], paddingHorizontal: spacing[2], borderRadius: radius.lg,
        backgroundColor: state.pressed || hovered(state) ? paseoColors(colors).interactionHighlight : "transparent",
      })}>
      <AssistantGlyph colors={colors} size={24} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.base, textAlign: "left" }}>AI Assistant</Text>
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "left" }}>
          {assistant.loading ? "Đang tải..." : `${shown.title}${tabs?.open ? ` · ${tabs.running}/${tabs.open} tab đang chạy` : ""}`}
        </Text>
      </View>
      <Icon name="ChevronRight" size={iconSize.sm} color={colors.foregroundMuted} />
    </Pressable>
    {assistant.error ? <View style={{ paddingHorizontal: spacing[2] }}><ErrorLine colors={colors} message={assistant.error} /></View> : null}
    {showing ? <AssistantModal colors={colors} assistant={assistant} openAgent={openAgent} onClose={() => setShowing(false)} /> : null}
  </>;
}

function AssistantGlyph({ colors, size }: { colors: Colors; size: number }) {
  return <View style={{
    width: size, height: size, borderRadius: size >= 32 ? radius.lg : radius.md, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.accent,
  }}>
    <Icon name="Bot" size={Math.round(size * 0.5)} color={colors.accentForeground} />
  </View>;
}

// The assistant's dialog: what it does, the persona, and the router and talk-to-myself tabs.
function AssistantModal({ colors, assistant, openAgent, onClose }: { colors: Colors; assistant: Assistant; openAgent?: OpenAgent; onClose(): void }) {
  return <Modal title="AI Assistant" icon={<Icon name="Bot" size={iconSize.lg} color={colors.foreground} />} open onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>
        Một tab router nhận mọi tin nhắn riêng và tin nhắc tên bạn, rồi giao mỗi việc cho một tab worker. Ai hỏi lại cùng
        việc thì router giao về đúng worker đó, nên worker giữ được context. Worker làm thay bạn với đủ quyền của một agent.
        Tin của agent khác không được chuyển.
      </Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>{personaLine(assistant)}</Text>
      {openAgent
        ? <View style={{ flexDirection: "row", justifyContent: "center", gap: spacing[2] }}>
          <RouterButton colors={colors} assistant={assistant} openAgent={openAgent} onOpened={onClose} />
          <TalkButton colors={colors} assistant={assistant} openAgent={openAgent} onOpened={onClose} />
        </View>
        : null}
    </Modal.Content>
  </Modal>;
}
