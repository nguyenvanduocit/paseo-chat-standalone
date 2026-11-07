import { z } from "zod";
import {
  conversationId, conversationTitle, handlePattern, parseConversationId, preview,
  type ChatAttachment, type ChatMessage, type ChatMessageView, type ChatPerson, type ChatSummary, type ChatRequest, type Conversation, type Priority, type Status,
} from "../shared/chat";
import { signalSchema, type Signal } from "../shared/signals";

// Chat lives in the chat broker (chat-broker/, docs/chat-broker.md): the only process that reads and writes the
// chat files. This daemon calls its HTTP API and hears what changes through one event stream per person, so nothing
// here touches the chat directory. The broker stamps the author from the handle each call names (docs/standalone.md).

export const defaultChatBrokerUrl = "http://127.0.0.1:8080";

// `key` is the broker's `CHAT_BROKER_KEY`, the same for everyone on this daemon; `handle` is the person a client picked.
export interface ChatConfig { url: string; key: string; handle: string }

type Env = Record<string, string | undefined>;

export function resolveChatConfig(env: Env, handle: string): ChatConfig {
  const url = (env.CHAT_BROKER_URL?.trim() || defaultChatBrokerUrl).replace(/\/+$/, "");
  new URL(url); // a malformed URL fails here rather than on every call
  const key = env.CHAT_BROKER_KEY?.trim();
  if (!key) throw new Error("Chat cần CHAT_BROKER_KEY: đặt cho daemon đúng khóa chat broker đang chạy với.");
  if (!handlePattern.test(handle)) throw new Error("Handle chat chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.");
  return { url, key, handle };
}

// `workspaceId` is the workspace the assistant's tabs open in, null while it is off. `from` is the key before which nothing
// is sent: the moment it was turned on. `delivered` holds, per conversation id, the key of the last message the
// assistant has been sent or has passed over.
export interface AssistantState { workspaceId: string | null; from: string; delivered: Record<string, string> }

// A message key starts with this, so `padTime(ms)` sorts before every key sent at or after `ms`.
export const padTime = (ms: number) => String(Math.max(0, ms)).padStart(13, "0");

// What the broker pushes (docs/chat-broker.md, "Sự kiện"). `ready` comes first on every (re)connect: whatever
// happened while the stream was down has no event, so a listener reads its state again.
// Messages due to one agent of this host in one conversation: the person's mentions of it and others' replies.
export interface Delivery { agent: string; conversation: Conversation; mentions: ChatMessageView[]; replies: ChatMessageView[] }

export type ChatEvent =
  | { type: "ready" }
  | { type: "message"; conversation: Conversation; key: string; author: string }
  | { type: "read"; conversation: Conversation; key: string }
  | { type: "focus"; conversation: string; at: number }
  | { type: "people" }
  | { type: "deliveries" }
  // An AI of this person made a decision of a kind only people make without pointing at the person's message.
  | { type: "delegation"; conversation: Conversation; key: string; decision: string };

// The broker sends the replied-to message whole; readers here show a short copy of it. `request` is optional: the
// plugin reaches every host at once while the broker is deployed on its own, so a broker older than it
// sends none; read here, it is no request.
type BrokerView = ChatMessage & { reply: ChatMessage | null; request?: ChatRequest | null };
interface BrokerSummary { id: string; conversation: string; last: BrokerView | ChatMessage | null; unread: number; mentioned: boolean; urgent: boolean; lastRead: string }

export class ChatBrokerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const pageSize = 200;
// Listing the host's projects asks Paseo for every workspace, so a window's poll carries them only this often.
const projectsEveryMs = 20_000;
const reconnectMinMs = 1_000;
const reconnectMaxMs = 30_000;

const viewOf = (message: BrokerView): ChatMessageView => ({
  ...message, reply: message.reply ? { key: message.reply.key, author: message.reply.author, body: preview(message.reply) } : null,
  request: message.request ?? null,
});

function conversationOf(id: string): Conversation {
  const conversation = parseConversationId(id);
  if (!conversation) throw new Error(`Chat broker trả về cuộc trò chuyện không hợp lệ: ${id}`);
  return conversation;
}

const changed = (answer: unknown) => z.object({ signal: signalSchema }).parse(answer);

export function openChatClient(config: ChatConfig, options: { fetch?: typeof fetch; log?: (message: string, error?: unknown) => void } = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? ((message, error) => console.error(message, error ?? ""));
  const me = config.handle;
  let projectsSentAt = -Infinity;
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${config.key}`,
    "x-chat-handle": me,
    ...extra,
  });

  async function call(method: string, path: string, init: { query?: Record<string, string | number | undefined>; json?: unknown; bytes?: Uint8Array<ArrayBuffer> } = {}): Promise<Response> {
    const url = new URL(`${config.url}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: headers(init.json !== undefined ? { "content-type": "application/json" } : init.bytes ? { "content-type": "application/octet-stream" } : {}),
        body: init.json !== undefined ? JSON.stringify(init.json) : init.bytes,
      });
    } catch (error) {
      throw new Error(`Không tới được chat broker (${config.url}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.ok) return response;
    const failure = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new ChatBrokerError(response.status, failure.error ?? "error", failure.message ?? `Chat broker trả lỗi ${response.status}.`);
  }
  const json = async <T>(method: string, path: string, init?: Parameters<typeof call>[2]) => await (await call(method, path, init)).json() as T;
  const messages = async (path: string, query: Record<string, string | number | undefined>) =>
    ({ messages: (await json<{ messages: BrokerView[] }>("GET", path, { query })).messages.map(viewOf) });

  function summaryOf(stored: BrokerSummary): ChatSummary {
    const conversation = conversationOf(stored.conversation);
    const last = stored.last;
    return {
      id: stored.id, conversation, title: conversationTitle(conversation, me),
      last: last ? { key: last.key, author: last.author, preview: preview(last), createdAt: last.createdAt } : null,
      unread: stored.unread, mentioned: stored.mentioned, urgent: stored.urgent, lastRead: stored.lastRead,
    };
  }

  // One event stream per person, opened with the first listener and reconnected until the plugin stops.
  const listeners = new Set<(event: ChatEvent) => void>();
  let stream: AbortController | null = null;
  const emit = (event: ChatEvent) => {
    for (const listener of listeners) {
      try { listener(event); } catch (error) { log("[chat] A chat event listener failed.", error); }
    }
  };

  function eventOf(type: string, data: string): ChatEvent | null {
    const body = data ? JSON.parse(data) as Record<string, unknown> : {};
    switch (type) {
      case "ready": return { type };
      case "people": return { type };
      case "deliveries": return { type };
      case "focus": return { type, conversation: String(body.conversation), at: Number(body.at) };
      case "message": return { type, conversation: conversationOf(String(body.conversation)), key: String(body.key), author: String(body.author) };
      case "read": return { type, conversation: conversationOf(String(body.conversation)), key: String(body.key) };
      case "delegation": return { type, conversation: conversationOf(String(body.conversation)), key: String(body.key), decision: String(body.decision) };
      default: return null;
    }
  }

  async function listen(signal: AbortSignal) {
    let wait = reconnectMinMs;
    while (!signal.aborted) {
      try {
        const response = await fetchImpl(`${config.url}/v1/events`, { headers: headers({ accept: "text/event-stream" }), signal });
        if (!response.ok || !response.body) throw new ChatBrokerError(response.status, "events", `Chat broker không mở luồng sự kiện (${response.status}).`);
        const decoder = new TextDecoder();
        let buffer = "";
        const reader = response.body.getReader();
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          buffer += decoder.decode(read.value, { stream: true });
          let end: number;
          // Server-sent events end with a blank line; lines starting with ":" are the broker's keep-alive.
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let type = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            if (!data.length && type === "message") continue;
            const event = eventOf(type, data.join("\n"));
            if (event?.type === "ready") wait = reconnectMinMs;
            if (event) emit(event);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        log(`[chat] The chat event stream dropped; reconnecting in ${wait / 1000}s.`, error);
      }
      await new Promise(resolve => setTimeout(resolve, wait).unref?.());
      wait = Math.min(reconnectMaxMs, wait * 2);
    }
  }

  return {
    me,

    // Listens to the broker's events; the stream opens with the first listener. Returns the unsubscribe.
    subscribe(listener: (event: ChatEvent) => void): () => void {
      listeners.add(listener);
      if (!stream) {
        stream = new AbortController();
        void listen(stream.signal);
      }
      return () => { listeners.delete(listener); };
    },

    close() {
      stream?.abort();
      stream = null;
      listeners.clear();
    },

    // Called by a client that is open: this handle is online in the projects its host works on, and its windows had
    // input `idleMs` ago (absent: the call says nothing about activity).
    // Without `hostProjects` the broker keeps the projects it has.
    async inbox(hostProjects?: () => Promise<string[]>, idleMs?: number) {
      const listing = hostProjects && Date.now() - projectsSentAt >= projectsEveryMs;
      await json("POST", "/v1/presence", {
        json: { ...listing ? { projects: await hostProjects() } : {}, ...idleMs === undefined ? {} : { idleMs } },
      });
      if (listing) projectsSentAt = Date.now();
      const inbox = await json<{ me: string; conversations: BrokerSummary[]; people: ChatPerson[]; focus: { conversation: string; at: number } | null }>("GET", "/v1/inbox");
      return { me: inbox.me, conversations: inbox.conversations.map(summaryOf), people: inbox.people, focus: inbox.focus };
    },

    people: () => json<ChatPerson[]>("GET", "/v1/people"),

    // How many agents this host has working; the broker writes a change at once and refreshes the same count.
    async reportAgents(running: number) {
      await json("POST", "/v1/agents", { json: { running } });
    },

    // Lists this host's person before any client opens, so others can message them.
    async register() {
      await json("POST", "/v1/register", { json: {} });
    },

    // Rooms this handle has read, written or been mentioned in, and direct messages that include it.
    joined: async () => (await json<string[]>("GET", "/v1/conversations")).map(conversationOf),

    // Messages after a key, oldest first, without counting as viewing the conversation. The broker gives keys that
    // only grow within a conversation, so `after` the last key read misses nothing.
    newer: (conversation: Conversation, after: string, limit = pageSize) =>
      messages("/v1/messages", { c: conversationId(conversation), after, limit }),

    latest: (conversation: Conversation, limit: number) =>
      messages("/v1/messages/latest", { c: conversationId(conversation), limit }),

    // Retrying with the same id returns the stored message instead of writing a second one.
    async send(conversation: Conversation, id: string, body: string, attachments: string[],
      extra: { replyTo?: string; via?: ChatMessage["via"]; priority?: Priority; wait?: boolean; status?: Status } = {}) {
      const sent = await json<{ message: BrokerView }>("POST", "/v1/messages", {
        json: { conversation: conversationId(conversation), id, body, attachments, ...extra },
      });
      return { message: viewOf(sent.message) };
    },

    async markRead(conversation: Conversation, key: string) {
      await json("POST", "/v1/reads", { json: { conversation: conversationId(conversation), key } });
      return {};
    },

    async markLatestRead(conversation: Conversation) {
      await json("POST", "/v1/reads", { json: { conversation: conversationId(conversation) } });
      return {};
    },

    // Opening a conversation's tab joins it, so it is listed from then on, even before anyone writes in it.
    async joinConversation(conversation: Conversation) {
      await json("POST", "/v1/joins", { json: { conversation: conversationId(conversation) } });
      return {};
    },

    // Asks every open client of this handle to show the conversation.
    async focus(conversation: Conversation) {
      await json("POST", "/v1/focus", { json: { conversation: conversationId(conversation) } });
    },

    // Where this handle's AI Assistant is up to; none until it is first saved.
    assistantState: () => json<AssistantState | null>("GET", "/v1/assistant"),

    async saveAssistantState(state: AssistantState) {
      await json("PUT", "/v1/assistant", { json: state });
    },

    // What is due to the agents of this host: per agent and conversation, the mentions and others' replies the
    // broker holds for it until they are acknowledged.
    async deliveries(): Promise<Delivery[]> {
      const { deliveries } = await json<{ deliveries: Array<{ agent: string; conversation: string; mentions: BrokerView[]; replies: BrokerView[] }> }>("GET", "/v1/deliveries");
      return deliveries.map(delivery => ({
        agent: delivery.agent, conversation: conversationOf(delivery.conversation),
        mentions: delivery.mentions.map(viewOf), replies: delivery.replies.map(viewOf),
      }));
    },

    // The agent got the conversation's messages up to `through`.
    async delivered(agent: string, conversation: Conversation, through: string) {
      await json("POST", "/v1/deliveries", { json: { agent, conversation: conversationId(conversation), through } });
    },

    // The agent is gone from this host: nothing more of the conversation is due to it.
    async endWatch(agent: string, conversation: Conversation) {
      await json("POST", "/v1/watches/end", { json: { agent, conversation: conversationId(conversation) } });
    },

    // Every word of the query must start a word of the message, ignoring case and accents.
    search: (conversation: Conversation, q: string) => messages("/v1/search", { c: conversationId(conversation), q }),

    // The same search over every conversation this handle is in, newest first.
    async searchAll(q: string) {
      const found = await json<{ messages: Array<BrokerView & { conversation: string }> }>("GET", "/v1/search", { query: { q } });
      return { messages: found.messages.map(message => ({ ...viewOf(message), conversation: message.conversation })) };
    },

    // Where a stored image is served. The broker serves it without a credential, so Paseo's Markdown draws it from
    // this URL; the id is the SHA-256 of its bytes, known only to who was shown the message or holds the image.
    imageUrl: (id: string) => `${config.url}/v1/images/${encodeURIComponent(id)}`,

    // A stored image's bytes and the type the broker found in them.
    async image(id: string) {
      const response = await call("GET", `/v1/images/${encodeURIComponent(id)}`);
      return { mime: response.headers.get("content-type") ?? "", bytes: new Uint8Array(await response.arrayBuffer()) };
    },

    // The team's delegation catalog, as the broker was built with it.
    delegation: async () => z.object({ version: z.string(), text: z.string() }).parse(await json<unknown>("GET", "/v1/delegation")),

    // Signals: every handle sees every signal, subscribes only itself, and only a signal's
    // creator deletes it. The broker's answers are parsed, so a broker that says otherwise fails here.
    signals: async (): Promise<Signal[]> => z.array(signalSchema).parse((await json<{ signals: unknown }>("GET", "/v1/signals")).signals),

    registerSignal: async (alert: string) => changed(await json<unknown>("POST", "/v1/signals", { json: { alert } })),

    async deleteSignal(alert: string) {
      await json("POST", "/v1/signals/delete", { json: { alert } });
    },

    // `agent` null: this handle's AI Assistant. One subscription per handle and alert; subscribing again replaces it.
    subscribeSignal: async (alert: string, agent: string | null) =>
      changed(await json<unknown>("POST", "/v1/signals/subscribe", { json: { alert, ...agent === null ? {} : { agent } } })),
    unsubscribeSignal: async (alert: string) => changed(await json<unknown>("POST", "/v1/signals/unsubscribe", { json: { alert } })),

    upload: (base64: string) =>
      json<{ attachment: ChatAttachment }>("POST", "/v1/images", { bytes: new Uint8Array(Buffer.from(base64, "base64")) }),
  };
}

export type ChatClient = ReturnType<typeof openChatClient>;
