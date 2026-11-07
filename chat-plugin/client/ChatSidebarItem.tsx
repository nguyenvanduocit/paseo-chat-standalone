import { useSettings, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { chatSettings } from "../shared/chat";
import { notificationsFor } from "../shared/notify";
import type { ChatTabsWatch } from "./chat-tabs";
import { CountBadge } from "./chat-ui";
import { MessageDialog } from "./MessageDialog";
import { useInbox } from "./useInbox";

export const chatScreenId = "chat";

// The Chat row in the sidebar. It stays mounted, so it also carries notifications: a window with a
// reply box for a direct message or a mention, a toast for other messages the person wants to hear
// about, and opening the Chat screen on a conversation an agent asked to show.
export function ChatSidebarItem({ theme, layout, currentScreen, openScreen, tabs }: PluginSidebarItemProps & { tabs: ChatTabsWatch }) {
  const { inbox } = useInbox();
  const settings = useSettings(chatSettings);
  const toast = useToast();
  const seen = useRef<Map<string, string> | null>(null);
  // Conversations waiting to pop up, one window at a time, in the order they arrived.
  const [popups, setPopups] = useState<string[]>([]);
  const focusSince = useRef(Date.now());
  const inTabs = useSyncExternalStore(tabs.subscribe, tabs.tabbed);
  // A conversation in a tab is already on screen: Paseo shows and announces what arrives.
  const onScreen = inTabs;
  const viewing = currentScreen?.screenId === chatScreenId ? currentScreen.params.c ?? null : null;
  const prefs = settings.status === "ready" ? settings.values : chatSettings.schema.parse({});

  useEffect(() => {
    if (!inbox) return;
    const { notify, popup, seen: next } = notificationsFor(inbox, seen.current, { ...prefs, viewing, tabbed: onScreen });
    seen.current = next;
    for (const item of notify) toast.show(item.text, { variant: "info", durationMs: 6000 });
    // A conversation read elsewhere meanwhile (its tab, another window) leaves the queue.
    const unreadIds = new Set(inbox.conversations.filter(summary => summary.unread > 0).map(summary => summary.id));
    setPopups(current => [...current.filter(id => unreadIds.has(id)), ...popup.filter(id => !current.includes(id))]);
    const focus = inbox.focus;
    if (focus && focus.at > focusSince.current) {
      focusSince.current = focus.at;
      openScreen({ screenId: chatScreenId, params: { c: focus.conversation } });
    }
  }, [inbox]);

  const unread = inbox?.conversations.reduce((sum, summary) => sum + summary.unread, 0) ?? 0;
  const popupSummary = popups.map(id => inbox?.conversations.find(summary => summary.id === id))
    .find(summary => summary && summary.unread > 0 && summary.id !== viewing && !onScreen.has(summary.id));
  return <>{popupSummary && <MessageDialog
    key={popupSummary.id}
    me={inbox?.me ?? ""}
    summary={popupSummary}
    theme={theme}
    layout={layout}
    onClose={() => setPopups(current => current.filter(id => id !== popupSummary.id))}
    onOpenChat={id => openScreen({ screenId: chatScreenId, params: { c: id } })}
  />}<SidebarRow
    icon="MessagesSquare"
    label="Chat"
    active={currentScreen?.screenId === chatScreenId}
    onPress={() => openScreen({ screenId: chatScreenId })}
    trailing={unread > 0 ? <CountBadge colors={theme.colors} count={unread} /> : undefined}
  /></>;
}
