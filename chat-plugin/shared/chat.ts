import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const maxChatBodyLength = 4000;
export const handlePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const maxDmMembers = 10;

// Only preferences, shared by everyone on this daemon: who writes is the person each client picked (docs/standalone.md).
const chatSettingsSchema = z.object({
  // Which new messages show a toast: direct messages and mentions, every message, or none.
  notify: z.enum(["dm-and-mentions", "all", "off"]).default("dm-and-mentions"),
  // An urgent direct message or mention pops up a window over the current screen, with a reply box.
  autoOpen: z.boolean().default(true),
});
export type ChatSettingsValues = z.infer<typeof chatSettingsSchema>;
export const chatSettings = defineSettings({
  id: "workspace-chat",
  scope: "host",
  version: 4,
  schema: chatSettingsSchema,
  // Versions 1 to 3 also said whether the AI Assistant was on, and where; it is always on now (server/assistant.ts).
  migrate: values => {
    const { assistant: _dropped, ...kept } = values as { assistant?: unknown };
    return kept;
  },
});

export const maxChatNameLength = 200;
export const maxChatQueryLength = 200;

// A conversation is a project room or a direct message between two to ten handles.
const threadSchema = z.object({
  project: z.string().min(1).max(maxChatNameLength), room: z.string().min(1).max(maxChatNameLength),
});
export type ChatThread = z.infer<typeof threadSchema>;
export const handleSchema = z.string().regex(handlePattern);

// Every call a client makes for its person names that person in `as`: one daemon serves several people, and only the
// client knows which of them is at it (docs/standalone.md).
export function personal<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ as: handleSchema, ...shape });
}
const dmSchema = z.object({ members: z.array(handleSchema).min(2).max(maxDmMembers) });
export type ChatDm = z.infer<typeof dmSchema>;
export const conversationSchema = z.union([threadSchema.strict(), dmSchema.strict()]);
export type Conversation = ChatThread | ChatDm;

export const isDm = (conversation: Conversation): conversation is ChatDm => "members" in conversation;

// Members are kept sorted and unique, so one set of people always maps to one conversation.
export function dmOf(handles: readonly string[]): ChatDm {
  return { members: [...new Set(handles)].sort() };
}

// A conversation as one string: screen params and agent tools carry it.
export function conversationId(conversation: Conversation): string {
  return isDm(conversation)
    ? `dm:${dmOf(conversation.members).members.join(",")}`
    : `room:${encodeURIComponent(conversation.project)}/${encodeURIComponent(conversation.room)}`;
}

export function parseConversationId(id: string): Conversation | null {
  let candidate: unknown = null;
  if (id.startsWith("dm:")) candidate = dmOf(id.slice(3).split(","));
  const room = /^room:([^/]+)\/([^/]+)$/.exec(id);
  if (room) {
    try {
      candidate = { project: decodeURIComponent(room[1]), room: decodeURIComponent(room[2]) };
    } catch {
      return null;
    }
  }
  const parsed = conversationSchema.safeParse(candidate);
  return parsed.success && (!isDm(parsed.data) || parsed.data.members.length >= 2) ? parsed.data : null;
}

// Every workspace of a project opens the project's one room, so teammates meet there without setting anything up.
export function projectRoom(project: string): ChatThread {
  return { project, room: "chung" };
}

export function threadTitle(thread: ChatThread): string {
  return `${thread.project}-${thread.room}`;
}

export function conversationTitle(conversation: Conversation, me: string): string {
  if (!isDm(conversation)) return threadTitle(conversation);
  const others = conversation.members.filter(member => member !== me);
  return others.length ? others.join(", ") : me;
}

export const maxAttachments = 4;
export const maxImageBytes = 10 * 1024 * 1024;
const imageMimeList = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = typeof imageMimeList[number];
// Typed as plain strings so callers can test any file's declared type against it.
export const imageMimes: readonly string[] = imageMimeList;
export const imageIdPattern = /^[a-f0-9]{64}$/;

const attachmentSchema = z.object({ id: z.string(), mime: z.string(), width: z.number().int(), height: z.number().int() });
export type ChatAttachment = z.infer<typeof attachmentSchema>;

// A message's key is its file name: zero-padded send time in milliseconds, then its id. Keys sort in send order.
export const messageIdPattern = /^[A-Za-z0-9-]{8,64}$/;
export const messageKeyPattern = /^\d{13}-[A-Za-z0-9-]{8,64}$/;
const keySchema = z.string().regex(messageKeyPattern);
// "" means no cursor: nothing read yet, or the latest page.
const cursorSchema = z.union([z.literal(""), keySchema]);

export const agentIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

// How hard a message asks for attention: an urgent direct message or mention opens a window over its reader's
// screen, everything else at most shows a toast. A stored message without one reads as normal.
export const priorities = ["normal", "urgent"] as const;
export type Priority = typeof priorities[number];

// Where a request stands, said by a reply in its chain: `working` and `input-required` keep it open,
// the others close it.
export const statuses = ["working", "input-required", "completed", "failed", "canceled"] as const;
export type Status = typeof statuses[number];
export const closingStatuses: readonly Status[] = ["completed", "failed", "canceled"];

// What is stored: written once, never rewritten. `via` marks a message an agent sent for its person: `agent` is
// what to call it, `agentId` the Paseo agent on the person's host that sent it (messages stored before it carry none).
// `wait`: the agent waits for answers, so the message opens a request unless it is inside one; `status`: where the
// request of its reply chain stands.
export const messageSchema = z.object({
  key: z.string(), id: z.string(), author: z.string(), body: z.string(), createdAt: z.string(),
  attachments: z.array(attachmentSchema),
  replyTo: keySchema.optional(),
  via: z.object({ agent: z.string().max(200), agentId: z.string().regex(agentIdPattern).optional() }).optional(),
  priority: z.enum(priorities),
  wait: z.boolean().optional(),
  status: z.enum(statuses).optional(),
});
export type ChatMessage = z.infer<typeof messageSchema>;

// The request a message opens or sits in, as the broker works it out: its key, where it stands ("open" until a reply
// says), and the key of the message that said so.
export const requestStates = ["open", ...statuses] as const;
export const requestSchema = z.object({ key: z.string(), state: z.enum(requestStates), at: z.string() });
export type ChatRequest = z.infer<typeof requestSchema>;

// What a reader sees: the stored message, a short copy of the message it replies to, and its request.
export const messageViewSchema = messageSchema.extend({
  reply: z.object({ key: z.string(), author: z.string(), body: z.string() }).nullable(),
  request: requestSchema.nullable(),
});
export type ChatMessageView = z.infer<typeof messageViewSchema>;

// A person is mentioned as `@handle`, an agent of the sender's host as `@[title](agent:<agent id>)`.
// Mentions inside Markdown code are text.
export type Mention = { kind: "person"; handle: string } | { kind: "agent"; id: string; title: string };
export type BodyPart = { kind: "text"; text: string } | Mention;

const maxAgentTitleLength = 80;
const bodyTokens = /(```[\s\S]*?```|`[^`\n]*`)|@\[([^\]\n]{1,200})\]\(agent:([A-Za-z0-9_-]{1,128})\)|(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;

// A message body as text and mentions, in order. A trailing dot ends a sentence rather than the handle.
export function bodyParts(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === "text") last.text += value;
    else parts.push({ kind: "text", text: value });
  };
  let at = 0;
  for (const match of body.matchAll(bodyTokens)) {
    text(body.slice(at, match.index));
    at = match.index + match[0].length;
    const [whole, code, title, agentId, before, handle] = match;
    if (code !== undefined) text(whole);
    else if (agentId !== undefined) parts.push({ kind: "agent", id: agentId, title });
    else {
      const name = handle.replace(/\.+$/, "");
      text(before);
      parts.push({ kind: "person", handle: name });
      text(handle.slice(name.length));
    }
  }
  text(body.slice(at));
  return parts;
}

export function mentionsIn(body: string): string[] {
  return [...new Set(bodyParts(body).flatMap(part => part.kind === "person" ? [part.handle] : []))];
}

// A title keeps only what cannot end the token or start another mention.
export function agentMention(id: string, title: string): string {
  const shown = title.replace(/[[\]()@`\s]+/g, " ").trim().slice(0, maxAgentTitleLength).trim() || "agent";
  return `@[${shown}](agent:${id})`;
}

export const mentionText = (mention: Mention) => `@${mention.kind === "person" ? mention.handle : mention.title}`;

// What a person reads: an agent mention shows as `@title`.
export function plainBody(body: string): string {
  return bodyParts(body).map(part => part.kind === "text" ? part.text : mentionText(part)).join("");
}

export function preview(message: Pick<ChatMessage, "body" | "attachments">): string {
  const text = plainBody(message.body).replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  return message.attachments.length ? `(${message.attachments.length} ảnh)` : "";
}

const conversationInput = personal({ conversation: conversationSchema });

// A person is `active` while a Paseo window of theirs is open and has had input in the last `afkAfterMs`,
// `afk` while one is open without it, `offline` when none is open.
export const presences = ["active", "afk", "offline"] as const;
export type Presence = typeof presences[number];
export const afkAfterMs = 5 * 60_000;

// `lastSeenAt` is when a window of theirs was last open, `activeAt` when one last had input. `projects` are the
// projects that person's host has workspaces for, as of their last time online. `agents` is how many agents of
// their host are working now, whether or not a window is open.
const personSchema = z.object({
  handle: z.string(), presence: z.enum(presences), lastSeenAt: z.string().nullable(), activeAt: z.string().nullable(),
  projects: z.array(z.string()), agents: z.number().int(),
});
export type ChatPerson = z.infer<typeof personSchema>;

const summarySchema = z.object({
  id: z.string(), conversation: conversationSchema, title: z.string(),
  last: z.object({ key: z.string(), author: z.string(), preview: z.string(), createdAt: z.string() }).nullable(),
  unread: z.number().int(), mentioned: z.boolean(), lastRead: cursorSchema,
  // An unread urgent message addressed to me: in a direct message, or mentioning me in a room.
  urgent: z.boolean(),
});
export type ChatSummary = z.infer<typeof summarySchema>;

// Everything the sidebar badge, the notifier and the conversation list need, in one poll.
// `idleMs` is how long ago the window asking had input; a caller that cannot tell leaves it out.
export const readChatInbox = defineRpc({
  name: "chat.inbox",
  input: personal({ idleMs: z.number().int().min(0).optional() }),
  output: z.object({
    me: z.string(), conversations: z.array(summarySchema), people: z.array(personSchema),
    // The newest request, by an agent of this person, to open a conversation on screen.
    focus: z.object({ conversation: z.string(), at: z.number() }).nullable(),
  }),
});
export type ChatInbox = z.infer<typeof readChatInbox.output>;

// The Paseo agent tab that shows a conversation, created on first open.
export const openChatTab = defineRpc({
  name: "chat.open-tab",
  input: conversationInput,
  output: z.object({ agentId: z.string() }),
});

// The person has seen the conversation up to its newest message.
export const markChatRead = defineRpc({
  name: "chat.read",
  input: conversationInput,
  output: z.object({}),
});


export const maxPopupMessages = 20;
export const maxLatestMessages = 100;

// The newest messages of a conversation, oldest first: the pop-up window shows the unread ones.
export const readChatLatest = defineRpc({
  name: "chat.latest",
  input: personal({ conversation: conversationSchema, limit: z.number().int().min(1).max(maxLatestMessages) }),
  output: z.object({ messages: z.array(messageViewSchema) }),
});

// A message the person writes outside a tab. Retrying with the same id returns the stored message.
export const sendChatMessage = defineRpc({
  name: "chat.send",
  input: personal({
    conversation: conversationSchema, id: z.string().regex(messageIdPattern),
    body: z.string().min(1).max(maxChatBodyLength), replyTo: keySchema.optional(),
  }),
  output: z.object({ message: messageViewSchema }),
});

// The people of this daemon (`CHAT_PEOPLE`), for a client to pick from.
export const readDaemonPeople = defineRpc({
  name: "chat.daemon-people",
  input: z.object({}),
  output: z.object({ people: z.array(z.string()) }),
});

// Whose a workspace is: the agents in it act for that person in chat. Null while no one has claimed it.
export const readWorkspaceOwner = defineRpc({
  name: "chat.workspace-owner",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ owner: z.string().nullable() }),
});

// The person claims a workspace as theirs, or lets go of one they own.
export const claimWorkspace = defineRpc({
  name: "chat.workspace-claim",
  input: personal({ workspaceId: z.string().min(1), claim: z.boolean() }),
  output: z.object({ owner: z.string().nullable() }),
});
