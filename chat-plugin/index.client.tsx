import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AttentionScreen, AttentionSidebarItem, attentionScreenId } from "./client/AttentionList";
import { ChatPanel } from "./client/ChatPanel";
import { ChatScreen } from "./client/ChatScreen";
import { ChatSettingsScreen } from "./client/ChatSettingsScreen";
import { ChatSidebarItem, chatScreenId } from "./client/ChatSidebarItem";
import { UnreadChatIcon } from "./client/UnreadChatIcon";
import { AsMe } from "./client/WhoAmI";
import { contributeChatHeaderButtons, workspaceChatPanelId } from "./client/chat-header-button";
import { watchChatTabs } from "./client/chat-tabs";
import { MyMessageBubble, MySenderLine, TheirMessageBubble } from "./client/chat-ui";
import { mentionAttachmentSource } from "./shared/mentions";
import { urgentAttachmentSource } from "./shared/priority";
import { myAgentMessageOf, myMessageItem, myMessageOf, senderLineItem, theirMessageItem } from "./shared/message-text";

export default function contribute(client: PluginClientContext) {
  // Every view of a person's chat waits until the person at this client is picked (client/me.ts).
  client.addWorkspacePanel({
    id: workspaceChatPanelId, title: "Chat", icon: "MessagesSquare", context: "workspace", locations: ["workspace", "explorer"],
    Component: props => <AsMe colors={props.theme.colors}><ChatPanel {...props} /></AsMe>,
  });
  client.addCommandCenterItem({
    id: "open-workspace-chat", title: "Open Workspace Chat", icon: "MessagesSquare", context: "workspace",
    onSelect({ openPanel }) { openPanel(workspaceChatPanelId, { location: "explorer" }); },
  });
  const headerButtons = contributeChatHeaderButtons(client, UnreadChatIcon);
  client.addScreen({ id: chatScreenId, title: "Chat", Component: props => <AsMe colors={props.theme.colors}><ChatScreen {...props} /></AsMe> });
  const tabs = watchChatTabs(client);
  client.addSidebarHeaderItem({ id: "chat", title: "Chat", Component: props => <ChatSidebarItem {...props} tabs={tabs} /> });
  client.addScreen({ id: attentionScreenId, title: "Cần lưu ý", Component: props => <AsMe colors={props.theme.colors}><AttentionScreen {...props} /></AsMe> });
  client.addSidebarHeaderItem({ id: "attention", title: "Cần lưu ý", Component: AttentionSidebarItem });
  client.addCommandCenterItem({
    id: "open-chat", title: "Open Chat", icon: "MessageCircle", context: "global", keywords: ["message", "dm", "tin nhắn"],
    onSelect({ openScreen }) { openScreen({ screenId: chatScreenId }); },
  });
  // Paseo's composer in a chat tab picks people and agents to mention, and marks a message urgent, as its own attachment pills.
  client.addAttachmentSource(mentionAttachmentSource);
  client.addAttachmentSource(urgentAttachmentSource);
  client.addSettingsScreen({ id: "workspace-chat", title: "Workspace Chat", icon: "MessagesSquare", Component: ChatSettingsScreen });

  // Someone else's message in a conversation tab, drawn as the bubble the plugin's own views draw.
  const removeTheirMessages = client.addTimelineRenderer({
    ...theirMessageItem,
    Component: ({ theme, item }) => <TheirMessageBubble colors={theme.colors} message={item.data} />,
  });
  // My message in a conversation tab, drawn as the bubble the plugin's own views draw so it reads Markdown.
  const removeMyMessages = client.addTimelineRenderer({
    ...myMessageItem,
    Component: ({ theme, item }) => <MyMessageBubble colors={theme.colors} message={item.data} />,
  });
  const { kind, version } = myMessageItem;
  const removeMyMessageTransform = client.addTimelineTransformer({
    id: "chat-my-message", query: { itemType: "user_message" },
    transform({ item }) {
      const data = myMessageOf(item);
      return data ? { items: [{ type: "plugin", kind, version, data }] } : undefined;
    },
  });
  // What my agent sent, which the daemon makes Paseo's agent-message card with a plain-text body.
  const removeMyAgentMessageTransform = client.addTimelineTransformer({
    id: "chat-my-agent-message", query: { itemType: "tool_call" },
    transform({ item }) {
      const data = myAgentMessageOf(item);
      return data ? { items: [{ type: "plugin", kind, version, data }] } : undefined;
    },
  });
  // My name and time above my own group, which my bubble does not show.
  const removeSenderLines = client.addTimelineRenderer({
    ...senderLineItem,
    Component: ({ theme, item }) => <MySenderLine colors={theme.colors} line={item.data} />,
  });
  return async () => {
    removeTheirMessages();
    removeMyMessages();
    removeMyMessageTransform();
    removeMyAgentMessageTransform();
    removeSenderLines();
    await Promise.all([headerButtons.dispose(), tabs.dispose()]);
  };
}
