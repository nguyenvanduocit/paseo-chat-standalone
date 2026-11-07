import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { AttentionItem } from "../shared/attention";

// The person forks the agent that wrote a Cần lưu ý item, to talk on about it: a new tab in that agent's workspace, with
// its provider, model and mode, whose first turn loads what the item came from and then waits for the person. The
// plugin SDK neither forks an agent nor opens one at a message, so the fork reads the source agent's activity itself
// with Paseo's `get_agent_activity`, the same curated history Paseo's own fork attaches, and the chat message by its key.

export type ForkPaseo = Pick<PaseoApi, "agents" | "workspaces">;

const forkTitleLength = 80;

// The fork's first turn: where the item came from, what to read, and to wait for the person.
export function forkPrompt(item: AttentionItem, source: { title: string | null; cwd: string }, conversationTitle: string): string {
  return [
    "This tab is a fork the person opened from their Cần lưu ý list, to talk on about one item. Load its context first:",
    "",
    `Item [${item.kind}]: ${item.title}`,
    ...item.detail ? [`Detail: ${item.detail}`] : [],
    ...item.due ? [`Due: ${item.due}`] : [],
    `Noted at ${item.createdAt} by ${item.by}, from the chat conversation ${item.conversation} (${conversationTitle})${item.messageKey ? `, message ${item.messageKey}` : ""}.`,
    `Source agent: ${item.agentId}${source.title ? ` (${source.title})` : ""}, working in ${source.cwd}.`,
    ...item.sessionId ? [`Its provider session when it noted the item: ${item.sessionId}.`] : [],
    "",
    `1. Read the source agent's activity with the Paseo tool get_agent_activity, agent id ${item.agentId}.`,
    ...item.sessionId
      ? [`   If that tool is missing or fails, read the Claude Code transcript ${item.sessionId}.jsonl under ~/.claude/projects/.`]
      : [],
    `2. Read the conversation with chat_read (conversation ${item.conversation})${item.messageKey ? `, and find message ${item.messageKey} there or with chat_search` : ""}.`,
    "3. Tell the person in a few lines, in the language of the conversation, where the item stands and what is still open; then wait.",
    "",
    "Do not send chat messages, or change anything for the person, until they ask you to.",
  ].join("\n");
}

// Creates the fork of the agent that wrote `item` and returns its id.
export async function forkAttentionItem(paseo: ForkPaseo, item: AttentionItem, conversationTitle: string): Promise<{ agentId: string }> {
  if (!item.agentId) throw new Error("Mục này không ghi agent nào viết nó, nên không fork được.");
  const source: PaseoAgent | undefined = (await paseo.agents.ref(item.agentId).refresh())?.agent;
  if (!source?.workspaceId) throw new Error("Agent viết mục này không còn trên host, nên không fork được.");
  const created = await paseo.workspaces.ref(source.workspaceId).agents.create({
    config: { provider: `${source.provider}/${source.model ?? "default"}`, ...source.currentModeId ? { modeId: source.currentModeId } : {} },
    title: `Fork · ${item.title}`.slice(0, forkTitleLength),
    prompt: forkPrompt(item, { title: source.title, cwd: source.cwd }, conversationTitle),
  });
  return { agentId: created.id };
}
