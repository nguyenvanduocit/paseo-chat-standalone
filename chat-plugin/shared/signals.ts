import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { isDm, personal, type ChatThread, type Conversation } from "./chat";

// A signal is a set of Grafana alerts, those whose rule carries the label `signal=<alert>`, that the chat broker
// pulls every 30 seconds and turns into messages of one room, `room:signals/<alert>`, grouped per poll. People and agents subscribe per alert: an agent hears
// the room as it hears a conversation it watches (server/replies.ts), and `agent: null` sends it to the person's AI
// Assistant (server/assistant.ts), as does the broker when the agent is gone (`handedOverAt`).

export const alertPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const alertSchema = z.string().regex(alertPattern);
const signalsProject = "signals";

export const signalRoom = (alert: string): ChatThread => ({ project: signalsProject, room: alert });

// The alert a conversation is the room of, or null when it is no signal's room.
export const alertOf = (conversation: Conversation): string | null =>
  !isDm(conversation) && conversation.project === signalsProject && alertPattern.test(conversation.room) ? conversation.room : null;

// One handle's subscription: `agent` null is the handle's AI Assistant; `handedOverAt` the time the agent was found gone
// and the subscription moved to the AI Assistant. Times in milliseconds.
const subscriptionSchema = z.object({
  handle: z.string(), agent: z.string().nullable(), at: z.number(), handedOverAt: z.number().nullable(),
});
export type SignalSubscription = z.infer<typeof subscriptionSchema>;

// What the broker says of a signal: `firing` alerts now; `lastChangeAt` the time of its last firing or resolved message,
// null before the first.
export const signalSchema = z.object({
  alert: z.string(), conversation: z.string(), createdBy: z.string(), createdAt: z.number(),
  firing: z.number().int(), lastChangeAt: z.number().nullable(),
  subscriptions: z.array(subscriptionSchema),
});
export type Signal = z.infer<typeof signalSchema>;

// Who hears a subscription's alerts, as people and agents read it.
export function subscriberTarget(subscription: SignalSubscription): string {
  if (subscription.agent) return `agent ${subscription.agent}`;
  return subscription.handedOverAt === null ? "AI Assistant" : "AI Assistant (agent đã mất, giao cho AI Assistant)";
}

// Signals the person created or subscribes to.
export const isMine = (signal: Signal, me: string) =>
  signal.createdBy === me || signal.subscriptions.some(subscription => subscription.handle === me);

// The Chat settings' Signals section: every signal, and who the person is.
export const readSignals = defineRpc({
  name: "chat.signals",
  input: personal({}),
  output: z.object({ me: z.string(), signals: z.array(signalSchema) }),
});

// The person subscribes their AI Assistant to a signal or leaves it; its creator deletes it.
export const changeSignal = defineRpc({
  name: "chat.signal-change",
  input: personal({ alert: alertSchema, action: z.enum(["subscribe", "unsubscribe", "delete"]) }),
  output: z.object({}),
});
