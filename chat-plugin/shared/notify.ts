import { isDm, type ChatInbox, type ChatSettingsValues } from "./chat";

export interface NotifyPrefs extends Pick<ChatSettingsValues, "notify" | "autoOpen"> {
  // The conversation open on screen right now; its messages are already in view.
  viewing: string | null;
  // Conversations with an open tab, where Paseo marks the tab and notifies for what arrives.
  tabbed: ReadonlySet<string>;
}

// Decides, from one inbox poll, which new messages pop up a window and which show a toast: only an urgent
// direct message or mention pops up, and with the window turned off it shows a toast as any direct one. `seen`
// holds each conversation's newest key as of the previous poll; null on the first poll, which
// only records what is already there. A conversation that pops up gets no toast as well.
export function notificationsFor(inbox: ChatInbox, seen: ReadonlyMap<string, string> | null, prefs: NotifyPrefs) {
  const next = new Map(inbox.conversations.flatMap(summary => summary.last ? [[summary.id, summary.last.key] as const] : []));
  const notify: { id: string; text: string }[] = [];
  const popup: string[] = [];
  if (!seen) return { notify, popup, seen: next };
  for (const summary of inbox.conversations) {
    const last = summary.last;
    if (!last || last.author === inbox.me || last.key <= (seen.get(summary.id) ?? "") || last.key <= summary.lastRead) continue;
    if (summary.id === prefs.viewing || prefs.tabbed.has(summary.id)) continue;
    const direct = isDm(summary.conversation) || summary.mentioned;
    // Conversations arrive newest first, and so do the windows.
    if (prefs.autoOpen && summary.urgent) { popup.push(summary.id); continue; }
    if (prefs.notify === "all" || (prefs.notify === "dm-and-mentions" && direct)) {
      notify.push({ id: summary.id, text: isDm(summary.conversation) && summary.conversation.members.length === 2
        ? `${last.author}: ${last.preview}`
        : `${summary.title} · ${last.author}: ${last.preview}` });
    }
  }
  return { notify, popup, seen: next };
}
