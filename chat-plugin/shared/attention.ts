import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { personal } from "./chat";
import { fold } from "./fold";

// What the person must not miss from their chats: a todo (something asked of them or promised by them), an important note,
// or an event at a time. The AI Assistant writes the list as it reads messages (server/attention-tools.ts); the person
// only reads it, marks an item done or removes it. It is the person's own, kept on their host (server/attention.ts).
// It also holds a blocker: work of an AI Assistant worker that its router could not settle, put there by the router or
// the plugin (server/assistant.ts), or a decision an AI took that only people take (server/attention.ts
// `noteDelegation`); never added by an agent's attention_add. No agent closes a blocker, so
// none can hide stuck work from the person: an agent marking one done says the person's part is done,
// and the item stays on the list, waiting on others, until its worker settles the work or the person closes it.

export const attentionKinds = ["todo", "event", "note"] as const;
export type AttentionKind = typeof attentionKinds[number];
export const attentionItemKinds = [...attentionKinds, "blocker"] as const;
export type AttentionItemKind = typeof attentionItemKinds[number];

export const maxAttentionTitleLength = 200;
export const maxAttentionDetailLength = 1000;
// Open items past this many are dropped oldest first; done items are kept this long, then dropped.
export const maxOpenAttention = 300;
export const keepDoneMs = 30 * 24 * 60 * 60_000;

const itemSchema = z.object({
  id: z.string(),
  kind: z.enum(attentionItemKinds),
  title: z.string().min(1).max(maxAttentionTitleLength),
  detail: z.string().max(maxAttentionDetailLength).nullable(),
  // The conversation it came from, and the message when there is one.
  conversation: z.string(),
  messageKey: z.string().nullable(),
  // When the event starts, or by when the todo is due.
  due: z.string().nullable(),
  createdAt: z.string(),
  // The agent that wrote it, as its tab is titled, and its id, so picking the item opens that agent and its ⋯ menu forks
  // it (server/attention-fork.ts). Items written before the id was kept have none and open their conversation.
  by: z.string(),
  agentId: z.string().nullable().default(null),
  // The provider session that agent was in when it wrote the item (a Claude Code session id): the fork reads the
  // transcript from it when the agent's activity cannot be read. Items written before it was kept have none.
  sessionId: z.string().nullable().default(null),
  // A blocker only: since when the person's part is done and the AI waits on others (`waitOnOthers`).
  waitingOnOthersAt: z.string().nullable().default(null),
  doneAt: z.string().nullable(),
});
export type AttentionItem = z.infer<typeof itemSchema>;
export const attentionFileSchema = z.object({ items: z.array(itemSchema).default([]) });

// What an agent writes. A second add of the same open item (same kind, conversation and title) changes nothing.
export const attentionAddSchema = z.object({
  kind: z.enum(attentionKinds),
  title: z.string().trim().min(1).max(maxAttentionTitleLength),
  detail: z.string().trim().max(maxAttentionDetailLength).optional(),
  conversation: z.string().min(1),
  messageKey: z.string().optional(),
  due: z.iso.datetime({ offset: true }).optional(),
});
export type AttentionAdd = z.infer<typeof attentionAddSchema>;

export const attentionUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(maxAttentionTitleLength).optional(),
  detail: z.string().trim().max(maxAttentionDetailLength).optional(),
  due: z.iso.datetime({ offset: true }).nullable().optional(),
  done: z.boolean().optional(),
});
export type AttentionUpdate = z.infer<typeof attentionUpdateSchema>;

// An agent adds a todo, an event or a note; the plugin a blocker too.
type NewItem = Omit<AttentionAdd, "kind"> & { kind: AttentionItemKind };

const sameItem = (item: AttentionItem, add: NewItem) =>
  !item.doneAt && item.kind === add.kind && item.conversation === add.conversation && fold(item.title) === fold(add.title);

// The list with `add` in it, and the item it names: the open one already there, or a new one with `id`.
export function addAttention(
  items: readonly AttentionItem[], add: NewItem, at: { id: string; now: string; by: string; agentId: string | null; sessionId: string | null },
) {
  const existing = items.find(item => sameItem(item, add));
  if (existing) return { items: [...items], item: existing, added: false };
  const item: AttentionItem = {
    id: at.id, kind: add.kind, title: add.title, detail: add.detail || null, conversation: add.conversation,
    messageKey: add.messageKey ?? null, due: add.due ?? null, createdAt: at.now, by: at.by, agentId: at.agentId, sessionId: at.sessionId,
    waitingOnOthersAt: null, doneAt: null,
  };
  return { items: [...items, item], item, added: true };
}

// Null when no item has `update.id`.
export function updateAttention(items: readonly AttentionItem[], update: AttentionUpdate, now: string): AttentionItem[] | null {
  if (!items.some(item => item.id === update.id)) return null;
  return items.map(item => item.id !== update.id ? item : {
    ...item,
    ...update.title !== undefined ? { title: update.title } : {},
    ...update.detail !== undefined ? { detail: update.detail || null } : {},
    ...update.due !== undefined ? { due: update.due } : {},
    ...update.done !== undefined ? { doneAt: update.done ? item.doneAt ?? now : null } : {},
  });
}

// A blocker whose person's part is done (`waiting`), or that needs the person again. Null when no blocker has `id`.
export function waitOnOthers(items: readonly AttentionItem[], id: string, waiting: boolean, now: string): AttentionItem[] | null {
  if (!items.some(item => item.id === id && item.kind === "blocker")) return null;
  return items.map(item => item.id !== id ? item : { ...item, waitingOnOthersAt: waiting ? item.waitingOnOthersAt ?? now : null });
}

// An open item the person has nothing left to do on: a blocker waiting on others.
export const waitingOnOthers = (item: AttentionItem) => item.kind === "blocker" && item.waitingOnOthersAt !== null;

export const removeAttention = (items: readonly AttentionItem[], id: string) => items.filter(item => item.id !== id);

// What is kept on save: done items for `keepDoneMs`, the newest `maxOpenAttention` open ones.
export function pruneAttention(items: readonly AttentionItem[], now: number): AttentionItem[] {
  const open = items.filter(item => !item.doneAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, maxOpenAttention);
  const done = items.filter(item => item.doneAt && now - Date.parse(item.doneAt) < keepDoneMs);
  const kept = new Set([...open, ...done]);
  return items.filter(item => kept.has(item));
}

// Open items in the order the person reads them: those with a time, soonest first (overdue ones first of all), then the
// rest, newest first, then the blockers waiting on others, newest first.
export function openAttention(items: readonly AttentionItem[]): AttentionItem[] {
  const open = items.filter(item => !item.doneAt);
  const timed = open.filter(item => item.due).sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
  const untimed = open.filter(item => !item.due).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...timed, ...untimed.filter(item => !waitingOnOthers(item)), ...untimed.filter(waitingOnOthers)];
}

// An item as the Chat screen shows it: the conversation's title for the person, beside its id to open it.
const shownItemSchema = itemSchema.extend({ conversationTitle: z.string() });
export type ShownAttentionItem = z.infer<typeof shownItemSchema>;

export const readAttention = defineRpc({
  name: "chat.attention",
  input: personal({}),
  output: z.object({ items: z.array(shownItemSchema) }),
});

// The person marks an item done, or removes it.
export const changeAttention = defineRpc({
  name: "chat.attention-change",
  input: personal({ id: z.string().min(1), action: z.enum(["done", "remove"]) }),
  output: z.object({}),
});

// The person forks the agent that wrote an item, to talk on about it in a tab of its own: the new agent's id, to open it.
export const forkAttention = defineRpc({
  name: "chat.attention-fork",
  input: personal({ id: z.string().min(1) }),
  output: z.object({ agentId: z.string() }),
});
