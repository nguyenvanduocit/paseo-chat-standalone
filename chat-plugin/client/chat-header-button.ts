import type { PaseoWorkspace, PaseoWorkspaceListResult } from "@getpaseo/client";
import type { PluginButton, PluginButtonIcon, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { readChatInbox } from "../shared/chat";
import { currentMe, myRpc } from "./me";

export const workspaceChatPanelId = "workspace-chat";

const unreadPollMs = 3_000;

// The button's look for an unread total: the plain icon, or `unreadIcon` with the count in its title.
function presentation(unread: number, unreadIcon: PluginButtonIcon): Pick<PluginButton, "title" | "icon"> {
  if (unread === 0) return { title: "Mở Chat", icon: "MessagesSquare" };
  return { title: `Mở Chat · ${unread > 99 ? "99+" : unread} tin chưa đọc`, icon: unreadIcon };
}

// Paseo registers header buttons per workspace, so this keeps one Chat button on every workspace
// of the host; pressing it opens the workspace chat panel in the Explorer sidebar. While the person
// has unread messages, every button shows `unreadIcon`.
export function contributeChatHeaderButtons(client: PluginClientContext, unreadIcon: PluginButtonIcon): { dispose(): Promise<void> } {
  const lifetime = new AbortController();
  const buttons = new Map<string, PluginButtonRegistration>();
  let observation: PaseoWorkspaceListResult["subscription"];
  let unread = 0;

  const register = (workspace: PaseoWorkspace) => {
    if (lifetime.signal.aborted || buttons.has(workspace.id)) return;
    const workspaceId = workspace.id;
    buttons.set(workspaceId, client.addHeaderButton({
      id: "open-chat",
      workspaceId,
      button: {
        ...presentation(unread, unreadIcon),
        behavior: {
          kind: "action",
          onPress() { client.openPanel(workspaceChatPanelId, { workspaceId, location: "explorer" }); },
        },
      },
    }));
  };
  const remove = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };

  const reportError = (error: unknown) => {
    if (!lifetime.signal.aborted) console.error("Chat header buttons: unable to observe workspaces", error);
  };
  const loadRemaining = async (cursor: string | null) => {
    while (cursor && !lifetime.signal.aborted) {
      const page = await client.paseo.workspaces.list({ page: { limit: 200, cursor } });
      if (lifetime.signal.aborted) return;
      for (const workspace of page.entries) register(workspace);
      if (page.pageInfo.nextCursor === cursor) throw new Error("Workspace directory cursor did not advance");
      cursor = page.pageInfo.nextCursor;
    }
  };

  const bootstrap = client.paseo.workspaces.list({ page: { limit: 200 }, subscribe: {} }).then(({ subscription }) => {
    observation = subscription;
    if (lifetime.signal.aborted) return;
    subscription.subscribe({
      snapshot: ({ entries, pageInfo }) => {
        for (const workspaceId of [...buttons.keys()]) remove(workspaceId);
        for (const workspace of entries) register(workspace);
        void loadRemaining(pageInfo.nextCursor).catch(reportError);
      },
      update: message => {
        if (message.type !== "workspace_update") return;
        const update = message.payload;
        if (update.kind === "remove") remove(update.id);
        else register(update.workspace);
      },
      error: reportError,
    });
  }).catch(reportError);

  // The inbox read fails while the daemon restarts; the buttons keep their last state and the error
  // is logged once per outage.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let failing = false;
  const pollUnread = async () => {
    try {
      // No count until a person is picked at this client.
      if (currentMe() === null) return;
      const inbox = await myRpc(client.rpc, readChatInbox, {});
      failing = false;
      const next = inbox.conversations.reduce((sum, summary) => sum + summary.unread, 0);
      if (!lifetime.signal.aborted && next !== unread) {
        unread = next;
        for (const button of buttons.values()) button.update(presentation(unread, unreadIcon));
      }
    } catch (error) {
      if (!failing && !lifetime.signal.aborted) console.error("Chat header buttons: unable to read unread messages", error);
      failing = true;
    } finally {
      if (!lifetime.signal.aborted) pollTimer = setTimeout(pollUnread, unreadPollMs);
    }
  };
  const polling = pollUnread();

  return {
    async dispose() {
      lifetime.abort();
      clearTimeout(pollTimer);
      for (const workspaceId of [...buttons.keys()]) remove(workspaceId);
      await Promise.all([bootstrap, polling]);
      await observation?.release();
    },
  };
}
