import type { PaseoApi } from "@getpaseo/client";
import { conversationId, conversationTitle, plainBody, type ChatMessageView } from "../shared/chat";
import { requestMark } from "./agent-tools";
import type { ChatClient, ChatEvent, Delivery } from "./chat";
import { imageIdsLine } from "./image-files";

// An agent that sent a message asking for replies, or that its person mentioned, hears what concerns it in that
// conversation: for 24 hours, and past that while a request it wrote in stays open, up to 14 days.
// The chat broker keeps who waits on what and decides what is due (chat-broker/src/watches.rs), so a daemon restart
// loses nothing; this daemon hands each agent of its host what the broker says is due, as Paseo hands one agent's
// message to another: a working agent takes it into its turn (steer), an idle one starts a turn. Then it tells the broker
// how far the agent got. The broker is read when it said something may be due, when its event stream (re)connected, and
// once at start.

const lineOf = (message: ChatMessageView) => {
  const mark = requestMark(message);
  return `[${message.key}] ${message.author}${mark ? ` (${mark})` : ""}: ${[plainBody(message.body), imageIdsLine(message)].filter(Boolean).join(" ")}`;
};

export function replyPrompt(title: string, id: string, messages: ChatMessageView[]): string {
  const lines = messages.map(lineOf);
  return [
    `New chat ${messages.length > 1 ? "messages" : "message"} in "${title}" (conversation ${id}):`,
    ...lines,
    `Reply with chat_send using conversation "${id}" if an answer is needed. ` +
      "When this gives you what your request asked for, close it: chat_send with replyTo the request key and status completed.",
  ].join("\n");
}

export function mentionPrompt(title: string, id: string, me: string, mentions: ChatMessageView[], replies: ChatMessageView[]): string {
  return [
    `${me} mentioned you in chat "${title}" (conversation ${id}):`,
    ...mentions.map(lineOf),
    ...replies.length ? ["Later messages from others:", ...replies.map(lineOf)] : [],
    `Do what ${me} asks, and answer with chat_send using conversation "${id}".`,
  ].join("\n");
}

function promptOf(delivery: Delivery, me: string): string {
  const title = conversationTitle(delivery.conversation, me);
  const id = conversationId(delivery.conversation);
  return delivery.mentions.length
    ? mentionPrompt(title, id, me, delivery.mentions, delivery.replies)
    : replyPrompt(title, id, delivery.replies);
}

export function replyWatcher(deps: {
  chat: () => Promise<ChatClient>;
  log?: (message: string) => void;
}) {
  // Whether the broker may hold something for this host: true at start, for what came while the daemon was down.
  let due = true;
  // The delivery in progress, and the one asked for while it runs: a tick that comes during a delivery runs right
  // after it instead of being dropped.
  let current: Promise<void> | null = null;
  let next: Promise<void> | null = null;

  function tick(paseo: PaseoApi | null): Promise<void> {
    if (!current) {
      current = deliver(paseo).finally(() => { current = null; });
      return current;
    }
    next ??= current.then(() => { next = null; return tick(paseo); });
    return next;
  }

  async function deliver(paseo: PaseoApi | null) {
    // Without a Paseo client yet (no window opened, no agent started since the daemon came up) the broker keeps it.
    if (!due || !paseo) return;
    due = false;
    let files: ChatClient;
    let deliveries: Delivery[];
    try {
      files = await deps.chat();
      deliveries = await files.deliveries();
    } catch (error) {
      due = true;
      deps.log?.(`[chat] reply delivery skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const delivery of deliveries) {
      try {
        const agent = paseo.agents.ref(delivery.agent);
        const found = await agent.refresh();
        if (!found || agent.status === "closed" || agent.archivedAt) {
          await files.endWatch(delivery.agent, delivery.conversation);
          continue;
        }
        // An agent still starting has no turn to take the prompt yet; the next tick tries again.
        if (agent.status === "initializing") {
          due = true;
          continue;
        }
        // An older broker also lists what it held back (`halted`), which this daemon never hands over.
        if (!delivery.mentions.length && !delivery.replies.length) continue;
        await agent.send(promptOf(delivery, files.me), { activeTurnBehavior: "steer" });
        const through = [...delivery.mentions, ...delivery.replies].map(message => message.key).sort().at(-1)!;
        await files.delivered(delivery.agent, delivery.conversation, through);
      } catch (error) {
        // One broken conversation or agent must not stop delivery to the others; the broker still holds it.
        due = true;
        deps.log?.(`[chat] reply delivery to ${delivery.agent} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    // What the chat broker says changed: something may be due, or the stream reconnected after missing events.
    notice(event: ChatEvent) {
      if (event.type === "deliveries" || event.type === "ready") due = true;
    },

    tick,
  };
}

export type ReplyWatcher = ReturnType<typeof replyWatcher>;
