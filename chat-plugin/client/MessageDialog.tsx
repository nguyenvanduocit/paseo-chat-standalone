import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useMyRpc } from "./me";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import {
  isDm, markChatRead, maxChatBodyLength, maxPopupMessages, readChatLatest, sendChatMessage,
  type ChatMessageView, type ChatSummary,
} from "../shared/chat";
import { messageRows } from "../shared/message-text";
import { Button, Composer, ErrorLine, MessageList } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { draftBody, emptyDraft, type MentionDraft } from "./MentionField";
import { iconSize, spacing } from "./paseo-theme";

type Props = Pick<PluginHostProps, "theme" | "layout"> & {
  me: string;
  summary: ChatSummary;
  onClose(): void;
  onOpenChat(id: string): void;
};

const newSendId = () => `pop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// A direct message or a mention, over whatever the person is doing: the unread messages and a reply
// box. Closing it, sending or opening the chat all count as reading the conversation.
export function MessageDialog({ me, summary, onClose, onOpenChat, theme, layout }: Props) {
  const colors = theme.colors;
  const latest = useMyRpc(readChatLatest);
  const send = useMyRpc(sendChatMessage);
  const markRead = useMyRpc(markChatRead);

  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [composed, setComposed] = useState<MentionDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per draft, so a retried send cannot post the reply twice.
  const sendId = useRef(newSendId());
  const lastKey = summary.last?.key ?? "";

  // Messages that arrive while the window is open join it.
  useEffect(() => {
    let cancelled = false;
    latest({ conversation: summary.conversation, limit: maxPopupMessages })
      .then(result => { if (!cancelled) setMessages(result.messages); })
      .catch(failure => { if (!cancelled) setError(userErrorMessage(failure)); });
    return () => { cancelled = true; };
  }, [lastKey]);

  async function finish(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (failure) {
      setError(userErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const close = () => finish(() => markRead({ conversation: summary.conversation }));
  const reply = () => finish(() => send({ conversation: summary.conversation, id: sendId.current, body: draftBody(composed) }));

  const unread = messages.filter(message => message.key > summary.lastRead);
  const shown = unread.length ? unread : messages.slice(-1);
  const marks = [summary.urgent ? "khẩn" : null, !isDm(summary.conversation) && summary.mentioned ? "nhắc bạn" : null].filter(Boolean);
  const title = [summary.title, ...marks].join(" · ");

  return (
    <Modal title={title} icon={<Icon name="MessagesSquare" size={iconSize.lg} color={colors.foreground} />} open onOpenChange={next => (next || busy ? undefined : void close())}>
      <Modal.Content contentContainerStyle={{ padding: layout.compact ? spacing[4] : spacing[6], gap: spacing[4] }}>
        {shown.length === 0 && !error ? <ActivityIndicator color={colors.accent} /> : null}
        {shown.length ? <View><MessageList colors={colors} me={me} rows={messageRows(shown)} /></View> : null}
        <Composer colors={colors} label="Trả lời" conversation={summary.conversation} draft={composed} autoFocus sending={busy} maxLength={maxChatBodyLength} minLines={2}
          onChange={next => { setComposed(next); sendId.current = newSendId(); }} onSubmit={() => { void reply(); }} />
        {error === null ? null : <ErrorLine colors={colors} message={error} />}
        <View style={{ flexDirection: "row", gap: spacing[2], alignItems: "center", flexWrap: "wrap" }}>
          <Button colors={colors} variant="ghost" icon="MessageSquare" label="Mở chat" disabled={busy}
            onPress={() => { onClose(); onOpenChat(summary.id); }} />
          <View style={{ marginLeft: "auto" }}>
            <Button colors={colors} variant="ghost" label="Đóng" disabled={busy} onPress={() => { void close(); }} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
