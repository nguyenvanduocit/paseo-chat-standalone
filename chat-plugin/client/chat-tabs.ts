import type { PaseoAgent, PaseoAgentListResult } from "@getpaseo/client";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { markChatRead, parseConversationId } from "../shared/chat";
import { chatTabs } from "../shared/chat-tabs";
import { currentMe, myRpc, subscribeMe } from "./me";

export interface ChatTabsWatch {
  tabbed(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

// Watches this daemon's agents for the chat tabs of the person at this client: tells the sidebar which conversations
// Paseo already notifies for, and marks a conversation read when Paseo clears its tab's attention.
export function watchChatTabs(client: PluginClientContext): ChatTabsWatch {
  const lifetime = new AbortController();
  const agents = new Map<string, PaseoAgent>();
  const listeners = new Set<() => void>();
  let attention = new Map<string, boolean>();
  let tabbed: ReadonlySet<string> = new Set();
  let observation: PaseoAgentListResult["subscription"] | undefined;

  const report = (error: unknown) => {
    if (!lifetime.signal.aborted) console.error("Chat: unable to observe chat tabs", error);
  };
  const recompute = () => {
    const next = chatTabs(attention, [...agents.values()], currentMe());
    attention = next.attention;
    for (const id of next.read) {
      const conversation = parseConversationId(id);
      if (conversation) void myRpc(client.rpc, markChatRead, { conversation }).catch(report);
    }
    if ([...next.tabbed].join("\n") !== [...tabbed].join("\n")) {
      tabbed = next.tabbed;
      for (const listener of listeners) listener();
    }
  };
  const loadRemaining = async (cursor: string | null) => {
    while (cursor && !lifetime.signal.aborted) {
      const page = await client.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor }, signal: lifetime.signal });
      for (const { agent } of page.entries) if (!agents.has(agent.id)) agents.set(agent.id, agent);
      if (page.pageInfo.nextCursor === cursor) throw new Error("Agent directory cursor did not advance");
      cursor = page.pageInfo.nextCursor;
    }
    recompute();
  };

  const bootstrap = client.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 }, subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      observation = subscription;
      if (lifetime.signal.aborted) return;
      subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          agents.clear();
          for (const { agent } of entries) agents.set(agent.id, agent);
          recompute();
          void loadRemaining(pageInfo.nextCursor).catch(report);
        },
        update: message => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") agents.delete(update.agentId);
          else agents.set(update.agent.id, update.agent);
          recompute();
        },
        error: report,
      });
    }).catch(report);

  // Another person picked at this client has other tabs.
  const unsubscribeMe = subscribeMe(recompute);

  return {
    tabbed: () => tabbed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispose() {
      lifetime.abort();
      unsubscribeMe();
      await bootstrap;
      await observation?.release();
    },
  };
}
