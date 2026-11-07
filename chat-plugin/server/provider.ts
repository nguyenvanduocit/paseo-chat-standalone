import { mkdir } from "node:fs/promises";
import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderRegistration, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import {
  agentIdPattern, conversationId, conversationTitle, dmOf, handlePattern, isDm, messageIdPattern, parseConversationId,
  type ChatMessageView, type ChatThread, type Conversation,
} from "../shared/chat";
import { conversationLabel, tabOwnerLabel } from "../shared/chat-tabs";
import { mentionOfAttachment, mentionToken } from "../shared/mentions";
import { isUrgentAttachment } from "../shared/priority";
import { continues, groupWindowMs, myMessageText, myPicturesMarkdown, senderLineItem, theirMessage, theirMessageItem, type SenderLine } from "../shared/message-text";
import type { ChatClient } from "./chat";

export const chatProviderId = "chat";
// The plugin's id in paseo-plugin.json: Paseo hands a plugin timeline item to the renderer this plugin registers.
const chatPluginId = "chat";
const capabilities = ["prompt.message", "prompt.image", "session.persistence"];
const historyLimit = 200;

// A tab shows one conversation to one person of this daemon: the person whose client opened it (docs/standalone.md).
export interface TabOf { as: string; conversation: Conversation }

const unbase64 = (value: string) => Buffer.from(value, "base64url").toString();

// Paseo writes a model as `provider/model`, and a room id holds a slash, so the model id carries the person's handle
// and the conversation id, each in base64url.
export function modelIdOf(as: string, conversation: Conversation): string {
  return `c-${Buffer.from(as).toString("base64url")}.${Buffer.from(conversationId(conversation)).toString("base64url")}`;
}

function tabOf(as: unknown, conversation: unknown): TabOf | null {
  if (typeof as !== "string" || !handlePattern.test(as) || typeof conversation !== "string") return null;
  const parsed = parseConversationId(conversation);
  return parsed ? { as, conversation: parsed } : null;
}

export function tabOfModel(model: string | undefined): TabOf | null {
  const match = /^c-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(model ?? "");
  return match ? tabOf(unbase64(match[1]), unbase64(match[2])) : null;
}

// Paseo stores this with the agent and hands it back when it reopens the tab after its session closed
// (plugin reload, daemon restart).
const persistenceOf = ({ as, conversation }: TabOf) => ({ version: 2, data: { as, conversation: conversationId(conversation) } });

function tabOfPersistence(persistence: { data: unknown } | undefined): TabOf | null {
  const data = persistence?.data;
  if (!data || typeof data !== "object" || !("as" in data) || !("conversation" in data)) return null;
  return tabOf(data.as, data.conversation);
}

const isMine = (message: ChatMessageView, me: string) => message.author === me;

// Every plugin row of a tab is named by its place: right after the message keyed `after` (`start` before the
// first). Paseo puts my bubble after whatever the tab drew last, and a row drawn again under the same id
// replaces it where it stands, so the empty row a tab ends with is taken over by the next row drawn there.
const rowAfter = (after: string | undefined) => `after-${after ?? "start"}`;

// My messages, and what my agents sent for me, are Paseo user messages whose `messageId` is the message key:
// the client recognises them by it and draws them as the plugin's bubble on the right (`myMessageOf`). What I
// type in the tab Paseo records under the composer's id instead, so it keeps Paseo's own bubble. Everyone
// else's is the plugin's bubble on the left under their name, which a message `continued` from the same sender
// leaves out. The content is `shared/message-text`, which the plugin's own views share. `after` is the message drawn before it.
export function timelineItemOf(message: ChatMessageView, me: string, { pictures = [], continued = false, after }: {
  pictures?: readonly string[]; continued?: boolean; after?: string;
} = {}): ProviderTimelineItem {
  if (isMine(message, me)) {
    const text = myMessageText(message, pictures);
    // What one of my agents sent reads as Paseo's own message from that agent, which opens the agent.
    const agentId = message.via?.agentId;
    return { id: message.key, type: "user_message", text: agentId ? agentEnvelopeOf(message.key, agentId, message.via!.agent, text) : text, messageId: message.key };
  }
  const { kind, version } = theirMessageItem;
  return { id: rowAfter(after), type: "plugin", pluginId: chatPluginId, kind, version, data: theirMessage(message, pictures, continued) };
}

// Paseo draws my bubble as plain text with only the images its own composer still holds, so after a reload
// my pictures follow the bubble as their own item.
export function picturesItemOf(message: ChatMessageView, me: string, pictures: readonly string[] = []): ProviderTimelineItem | null {
  const text = isMine(message, me) ? myPicturesMarkdown(message, pictures) : null;
  return text === null ? null : { id: `${message.key}-pictures`, type: "assistant_message", text };
}

// The row with my name and time above my message, right after the message keyed `after`; without `sender` it is
// the empty row a tab ends with.
export function senderLineOf(after: string | undefined, sender?: Pick<ChatMessageView, "author" | "createdAt">): ProviderTimelineItem {
  const { kind, version } = senderLineItem;
  const data: SenderLine = sender ? { sender: { author: sender.author, createdAt: sender.createdAt } } : {};
  return { id: rowAfter(after), type: "plugin", pluginId: chatPluginId, kind, version, data };
}

// Paseo delivers what one agent sends another (here, to a chat tab) wrapped in a `paseo-system` envelope of
// kind `agent-message` (version 1: attributes and body XML-escaped, `@getpaseo/server` agent-messages/envelope.js).
// The person reads what the agent wrote, and the message carries `via` with the sending agent, as a message sent
// through `chat_send` does. The daemon draws a user message in that envelope as a message from the agent, which opens
// it, so a tab draws my agents' messages the same way (`agentEnvelopeOf`).
const agentEnvelope = /^\s*<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n?([\s\S]*?)\n?<\/paseo-system>\s*$/;
const xmlEntities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (value: string) => value.replace(/[&<>"']/g, character => xmlEntities[character]);
const unescapeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, entity => Object.keys(xmlEntities).find(key => xmlEntities[key] === entity)!);

export function agentMessageOf(text: string): { agentId: string; title?: string; text: string } | null {
  const match = agentEnvelope.exec(text);
  if (!match) return null;
  const attributes = new Map([...match[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)].map(([, name, value]) => [name, unescapeXml(value)]));
  const agentId = attributes.get("source-agent-id");
  if (attributes.get("kind") !== "agent-message" || !agentId || !agentIdPattern.test(agentId)) return null;
  const title = attributes.get("source-agent-title")?.slice(0, 200);
  return { agentId, ...title ? { title } : {}, text: unescapeXml(match[2]).trim() };
}

export function agentEnvelopeOf(key: string, agentId: string, title: string, text: string): string {
  return `<paseo-system version="1" kind="agent-message" source-agent-id="${escapeXml(agentId)}" message-id="${escapeXml(key)}"` +
    ` source-agent-title="${escapeXml(title)}">\n${escapeXml(text)}\n</paseo-system>`;
}

// A message id must match messageIdPattern; Paseo's client message ids are UUIDs.
const sendIdOf = (clientMessageId: string) => {
  const id = clientMessageId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  return messageIdPattern.test(id) ? id : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// The person's direct messages with everyone, then the rooms and groups they are in. Labelled with the person, since
// the catalog lists everyone on this daemon.
export async function chatModels(chat: ChatClient) {
  const people = (await chat.people()).filter(person => person.handle !== chat.me);
  const dms = people.map(person => dmOf([chat.me, person.handle]));
  const seen = new Set(dms.map(conversationId));
  const others = (await chat.joined()).filter(conversation => !seen.has(conversationId(conversation)));
  return [...dms, ...others].map((conversation, index) => ({
    id: modelIdOf(chat.me, conversation),
    label: `${conversationTitle(conversation, chat.me)} · ${chat.me}`,
    description: isDm(conversation) ? (conversation.members.length > 2 ? "Nhóm" : "Tin nhắn riêng") : "Phòng chat",
    isDefault: index === 0,
  }));
}

// `last` is the newest message the tab drew, which the next one may continue under. `pending` when the tab ends
// with the empty row after `last`; `pendingTimer` draws that row once my group's window has passed.
interface Session {
  as: string; conversation: Conversation; cursor: string; shown: Set<string>; last?: ChatMessageView;
  pending: boolean; pendingTimer?: ReturnType<typeof setTimeout>; queue: Promise<void>;
}

// A message's pictures are its images at the broker, which Paseo's Markdown draws straight from their URL.
const picturesOf = (chat: ChatClient, messages: ChatMessageView[]) =>
  new Map(messages.map(message => [message.key, message.attachments.map(attachment => chat.imageUrl(attachment.id))]));

// A message the tab has shown, or counts as shown; reads go only after the cursor.
function seen(session: Session, message: ChatMessageView) {
  session.shown.add(message.key);
  session.cursor = message.key > session.cursor ? message.key : session.cursor;
}

// A closed session draws no empty row later.
function stop(session: Session) {
  clearTimeout(session.pendingTimer);
}

// My message is stored, and its event sent, before send returns, so a read in between would show it as a second
// bubble without its clientMessageId. Reads and sends of one session run one at a time.
function serially(session: Session, work: () => Promise<void>) {
  const done = session.queue.then(work);
  session.queue = done.catch(() => {});
  return done;
}

// A chat conversation shown in a Paseo agent tab: Paseo's own composer and timeline, backed by the chat broker. A tab
// reads new messages when the broker says its conversation has one, and catches up whenever the event stream
// (re)connects. `openChat` is the client of one person of this daemon, `people` everyone of this daemon (`CHAT_PEOPLE`).
export function chatProvider(openChat: (as: string) => Promise<ChatClient>, people: readonly string[], { log = console.error }: {
  log?: (message: string, error: unknown) => void;
} = {}): ProviderRegistration {
  return {
    id: chatProviderId,
    label: "Chat",
    description: "Nhắn tin với đồng đội",
    async connect() {
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => { for (const listener of listeners) listener(event); };
      const sessions = new Map<string, Session>();

      const draw = (sessionId: string, item: ProviderTimelineItem, timestamp: string) => emit({ type: "timeline.item", sessionId, item, timestamp });

      // Paseo names a tab's model from this catalog, so it holds the conversations of everyone on this daemon.
      async function catalogModels() {
        const lists = await Promise.all(people.map(async as => chatModels(await openChat(as))));
        return lists.flat().map((model, index) => ({ ...model, isDefault: index === 0 }));
      }

      // One subscription per person for every tab of theirs on this connection, made when their first tab opens.
      const unsubscribes = new Map<string, () => void>();
      function listen(chat: ChatClient) {
        if (unsubscribes.has(chat.me)) return;
        unsubscribes.set(chat.me, chat.subscribe(event => {
          if (event.type !== "ready" && event.type !== "message") return;
          const id = event.type === "message" ? conversationId(event.conversation) : null;
          for (const [sessionId, session] of sessions) {
            if (session.as === chat.me && (id === null || conversationId(session.conversation) === id)) void catchUp(sessionId);
          }
        }));
      }

      // The empty row the next row drawn takes over: someone else's bubble, or my name above my bubble.
      function pend(sessionId: string, session: Session) {
        clearTimeout(session.pendingTimer);
        session.pendingTimer = undefined;
        if (session.pending) return;
        session.pending = true;
        draw(sessionId, senderLineOf(session.last?.key), session.last?.createdAt ?? new Date().toISOString());
      }

      // After someone else's message my next one starts a group, so the tab needs the empty row at once. After
      // mine it needs it only once the group's window has passed: within it my next message continues the group
      // and goes right under my bubble, where an empty row would leave a gap.
      function settle(sessionId: string, session: Session, me: string) {
        clearTimeout(session.pendingTimer);
        const last = session.last;
        const wait = last && isMine(last, me) ? Date.parse(last.createdAt) + groupWindowMs - Date.now() : 0;
        if (wait <= 0) return pend(sessionId, session);
        session.pendingTimer = setTimeout(() => void serially(session, async () => pend(sessionId, session)), wait);
        session.pendingTimer.unref?.();
      }

      // Draws a message after the tab's last row. My message gets my name above it when it starts a group, and
      // also when the tab ends with the empty row, which would otherwise stay as a gap above it.
      function drawMessage(sessionId: string, session: Session, message: ChatMessageView, me: string, pictures?: string[]) {
        const continued = continues(session.last, message);
        const after = session.last?.key;
        if (isMine(message, me) && (!continued || session.pending)) draw(sessionId, senderLineOf(after, message), message.createdAt);
        session.pending = false;
        session.last = message;
        const items = [timelineItemOf(message, me, { pictures, continued, after }), picturesItemOf(message, me, pictures)];
        for (const item of items) if (item) draw(sessionId, item, message.createdAt);
      }

      function show(sessionId: string, session: Session, messages: ChatMessageView[], me: string, pictures: Map<string, string[]>) {
        const fresh = messages.filter(message => !session.shown.has(message.key));
        for (const message of messages) seen(session, message);
        for (const message of fresh) drawMessage(sessionId, session, message, me, pictures.get(message.key));
        if (fresh.length) settle(sessionId, session, me);
      }

      // What arrives in an open tab runs as a turn: Paseo marks a tab that finished a turn as needing
      // attention, shows its unread dot and notification, and clears it when the person looks at the tab.
      function arrive(sessionId: string, session: Session, messages: ChatMessageView[], me: string, pictures: Map<string, string[]>) {
        const theirs = messages.filter(message => !session.shown.has(message.key) && message.author !== me);
        if (!theirs.length) {
          show(sessionId, session, messages, me, pictures);
          return;
        }
        const turnId = `arrive-${theirs.at(-1)!.key}`;
        emit({ type: "session.turn", sessionId, turnId, state: "started" });
        show(sessionId, session, messages, me, pictures);
        emit({ type: "session.turn", sessionId, turnId, state: "completed" });
      }

      async function catchUp(sessionId: string) {
        const session = sessions.get(sessionId);
        if (!session) return;
        await serially(session, async () => {
          try {
            const chat = await openChat(session.as);
            const { messages } = await chat.newer(session.conversation, session.cursor);
            const fresh = messages.filter(message => !session.shown.has(message.key));
            arrive(sessionId, session, messages, chat.me, picturesOf(chat, fresh));
          } catch (error) {
            log("[chat] Could not read new chat messages.", error);
          }
        });
      }

      async function open(input: Extract<ProviderInput, { type: "session.open" }>) {
        const tab = tabOfModel(input.config.model) ?? tabOfPersistence(input.persistence);
        if (!tab) throw new Error("Chọn người hoặc cuộc trò chuyện để nhắn.");
        const { conversation } = tab;
        const chat = await openChat(tab.as);
        const { messages } = await chat.latest(conversation, historyLimit);
        const pictures = picturesOf(chat, input.history === "replay" ? messages : []);
        const previous = sessions.get(input.sessionId);
        if (previous) stop(previous);
        const session: Session = {
          as: tab.as, conversation, cursor: "", shown: new Set(), pending: false, queue: Promise.resolve(),
        };
        sessions.set(input.sessionId, session);
        listen(chat);
        const title = conversationTitle(conversation, chat.me);
        emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", persistence: persistenceOf(tab), cwd: input.config.cwd, title });
        // A replay publishes the conversation so far before ready. Paseo opens a new tab without history and
        // then reloads it (openChatTab), so a session without history counts the messages as seen, not new.
        if (input.history === "replay") show(input.sessionId, session, messages, chat.me, pictures);
        else for (const message of messages) seen(session, message);
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        // Paseo keeps a tab's stored timeline over a replay (plugin reload, rollout) and drops what the replay drew,
        // so the empty row is drawn again after ready, where it reaches that timeline; one already there keeps its place.
        session.pending = false;
        settle(input.sessionId, session, chat.me);
        // A message that came between reading the history and listening has had its event already.
        void catchUp(input.sessionId);
        const last = messages.at(-1);
        if (last) await chat.markRead(conversation, last.key);
      }

      async function prompt(input: Extract<ProviderInput, { type: "session.prompt" }>) {
        const { clientMessageId } = input.prompt;
        const session = sessions.get(input.sessionId);
        try {
          if (!session) throw new Error("Cuộc trò chuyện chưa mở.");
          if (input.prompt.input.type !== "message") throw new Error("Chat không có lệnh.");
          const chat = await openChat(session.as);
          // A person or agent picked in the composer arrives as an attachment pill and leads the message; the
          // urgent pill marks the message instead of adding text.
          const mentions: string[] = [];
          const written: string[] = [];
          let urgent = false;
          for (const part of input.prompt.input.content) {
            if (part.type !== "text") continue;
            const resource = "externalResource" in part ? part.externalResource : undefined;
            const mention = mentionOfAttachment(resource);
            if (mention) mentions.push(mentionToken(mention));
            else if (isUrgentAttachment(resource)) urgent = true;
            else written.push(part.text);
          }
          const typed = written.join("\n").trim();
          const fromAgent = agentMessageOf(typed);
          const text = [mentions.join(" "), fromAgent?.text ?? typed].filter(Boolean).join(" ");
          const images = input.prompt.input.content.flatMap(part => part.type === "image" ? [part] : []);
          const attachments: string[] = [];
          for (const image of images) attachments.push((await chat.upload(image.data)).attachment.id);
          await serially(session, async () => {
            const { message } = await chat.send(session.conversation, sendIdOf(clientMessageId), text, attachments, {
              priority: urgent ? "urgent" : "normal",
              ...fromAgent ? { via: { agent: fromAgent.title ?? "agent", agentId: fromAgent.agentId } } : {},
            });
            seen(session, message);
            // Paseo has already put my bubble after the tab's last row. When that row is the empty one, it takes
            // my name; otherwise my message continues my group, right under my previous bubble.
            if (session.pending) draw(input.sessionId, senderLineOf(session.last?.key, message), message.createdAt);
            session.pending = false;
            session.last = message;
            draw(input.sessionId, { ...timelineItemOf(message, chat.me), clientMessageId } as ProviderTimelineItem, message.createdAt);
            settle(input.sessionId, session, chat.me);
          });
          emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId, result: { type: "completed" } });
        } catch (error) {
          emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId, result: { type: "failed", error: { message: error instanceof Error ? error.message : String(error) } } });
        }
      }

      async function handle(input: ProviderInput) {
        switch (input.type) {
          case "catalog":
            emit({ type: "catalog", requestId: input.requestId, catalog: { models: await catalogModels(), modes: [] } });
            return;
          case "session.open":
            await open(input);
            return;
          case "session.prompt":
            await prompt(input);
            return;
          case "session.close": {
            const session = sessions.get(input.sessionId);
            if (session) stop(session);
            sessions.delete(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          default:
            if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
        }
      }

      const connection: ProviderConnection = {
        version: 1,
        capabilities,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() {
          for (const unsubscribe of unsubscribes.values()) unsubscribe();
          unsubscribes.clear();
          for (const session of sessions.values()) stop(session);
          sessions.clear();
        },
        async send(input) {
          try {
            await handle(input);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { message } });
            else log("[chat] Provider input failed.", error);
          }
        },
      };
      return connection;
    },
  };
}


// The parts of Paseo a chat tab is opened with.
type ChatTabPaseo = Pick<PaseoApi, "agents" | "workspaces" | "providers">;

// A room opens in a workspace of the project it is named after: the one named like the project, else the
// project's own checkout. Null when this host has no open workspace of that project.
export function roomWorkspace(room: ChatThread, workspaces: readonly PaseoWorkspace[]): PaseoWorkspace | null {
  const ofProject = workspaces.filter(workspace => workspace.projectDisplayName === room.project && workspace.workspaceDirectory && !workspace.archivingAt);
  return ofProject.find(workspace => workspace.name === room.project)
    ?? ofProject.find(workspace => workspace.workspaceKind === "local_checkout" || workspace.workspaceKind === "directory")
    ?? ofProject[0] ?? null;
}

export async function allWorkspaces(paseo: Pick<PaseoApi, "workspaces">) {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, cursor } });
    workspaces.push(...page.entries);
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return workspaces;
}

// The projects this host has open workspaces of, by the name their rooms are keyed on.
export async function hostProjects(paseo: Pick<PaseoApi, "workspaces">): Promise<string[]> {
  const names = (await allWorkspaces(paseo)).filter(workspace => !workspace.archivingAt).map(workspace => workspace.projectDisplayName);
  return [...new Set(names.filter(Boolean))].sort();
}

// One agent tab per person and conversation, found again by its labels. A room's tab is in its project's workspace;
// a direct message's, or a room's whose project this daemon lacks, is in the workspace of `home`, the person's own.
// A tab found only in another workspace stays open there, and a new one opens where the conversation belongs; its
// history replays from the chat broker.
export async function openChatTab(paseo: ChatTabPaseo, chat: ChatClient, conversation: Conversation, home: string) {
  const labels = { [conversationLabel]: conversationId(conversation), [tabOwnerLabel]: chat.me };
  const room = isDm(conversation) ? null : roomWorkspace(conversation, await allWorkspaces(paseo));
  if (!room) await mkdir(home, { recursive: true });
  const workspace = room ? paseo.workspaces.ref(room) : await paseo.workspaces.open(home);
  const { entries } = await paseo.agents.list({ filter: { labels, includeArchived: false } });
  const existing = entries.find(entry => entry.agent.workspaceId === workspace.id);
  if (existing) return { agentId: existing.agent.id };
  // Paseo names a tab's model from the provider catalog it keeps, so the conversation must be in it.
  await chat.joinConversation(conversation);
  await paseo.providers.refresh({ cwd: room?.workspaceDirectory ?? workspace.directory ?? home, providers: [chatProviderId] });
  const created = await workspace.agents.create({
    config: { provider: `${chatProviderId}/${modelIdOf(chat.me, conversation)}` }, title: conversationTitle(conversation, chat.me), labels,
  });
  // Paseo opens a new agent without history. Its reload reopens the session from the stored persistence
  // with history replayed and re-streams the timeline, which is how a conversation so far reaches the tab.
  await created.reload();
  return { agentId: created.id };
}
