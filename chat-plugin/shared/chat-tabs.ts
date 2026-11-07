export const conversationLabel = "chat.conversation";
// A conversation tab is one person's (docs/standalone.md): it carries their handle under this label.
export const tabOwnerLabel = "chat.owner";

interface TabAgent {
  id: string;
  status: string;
  requiresAttention?: boolean;
  archivedAt?: string | null;
  labels: Readonly<Record<string, string>>;
}

// From the agent list: which conversations have an open tab, and which tabs Paseo just cleared.
// A new message in an open tab runs as a turn, so Paseo marks the tab as needing attention and
// clears it when the person looks at the tab; that clear is when the conversation was read.
// `attention` holds each chat tab's flag as of the previous call. Only the tabs of `me`, the person at this client, count.
export function chatTabs(attention: ReadonlyMap<string, boolean>, agents: readonly TabAgent[], me: string | null) {
  const next = new Map<string, boolean>();
  const tabbed = new Set<string>();
  const read: string[] = [];
  for (const agent of agents) {
    const conversation = agent.labels[conversationLabel];
    if (!conversation || agent.archivedAt || me === null || agent.labels[tabOwnerLabel] !== me) continue;
    const flagged = agent.requiresAttention === true;
    next.set(agent.id, flagged);
    if (agent.status !== "closed") tabbed.add(conversation);
    if (attention.get(agent.id) === true && !flagged) read.push(conversation);
  }
  return { attention: next, tabbed, read };
}
