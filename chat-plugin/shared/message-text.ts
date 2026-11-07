import { z } from "zod";
import { bodyParts, mentionText, messageKeyPattern, plainBody, type ChatMessageView, type Status } from "./chat";

// How a message reads in Paseo's timeline, for the conversation tab and for the plugin's own views (the
// Chat panel, the notification window), so a message looks the same wherever it shows.

export const messageClock = (createdAt: string) => new Date(createdAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

const markdownOf = (pictures: readonly string[]) => pictures.map(picture => `![ảnh](<${picture}>)`).join("\n");
const pictured = (message: ChatMessageView, pictures: readonly string[]) =>
  message.attachments.length > 0 && pictures.length === message.attachments.length;
const imageCount = (message: ChatMessageView) => message.attachments.length ? `\n\n_🖼 ${message.attachments.length} ảnh_` : "";

// What a message says of a request, as a muted line under its text: the request it opens, or where the
// request it answers stands. A message is written once, so the line is what the message said, not the request today.
const statusNames: Record<Status, string> = {
  "working": "Đang làm", "input-required": "Cần thêm thông tin", "completed": "Đã xong", "failed": "Không làm được", "canceled": "Đã huỷ",
};
export function requestNote(message: Pick<ChatMessageView, "key" | "status" | "request">): string {
  if (message.status) return `\n\n_Yêu cầu: ${statusNames[message.status]}_`;
  return message.request?.key === message.key ? "\n\n_Yêu cầu, chờ trả lời_" : "";
}

// Markdown draws inline code as a tinted pill, which is how a mention shows in someone else's message.
const pilled = (body: string) => bodyParts(body).map(part => part.kind === "text" ? part.text : `\`${mentionText(part)}\``).join("");

// My message is Markdown where a mention reads `@name`. Pictures it carried follow it as `myPicturesMarkdown`;
// without them the message counts its images.
export function myMessageText(message: ChatMessageView, pictures: readonly string[] = []): string {
  const body = `${plainBody(message.body)}${requestNote(message)}`;
  return pictured(message, pictures) ? body : `${body}${imageCount(message)}`;
}

export function myPicturesMarkdown(message: ChatMessageView, pictures: readonly string[] = []): string | null {
  return pictured(message, pictures) ? markdownOf(pictures) : null;
}

// In a conversation tab my message is a Paseo user message, which Paseo draws as plain text. The client
// transforms it into this item, the bubble on the right that reads Markdown as theirs does. Paseo hands the
// transform every agent's user messages without naming the tab; the ones a chat tab draws carry the message
// key as `messageId` (server/provider.ts), which no other provider's ids look like. What I type in the tab's
// composer Paseo records itself under the composer's id, like a user message in any other tab, so it keeps
// Paseo's bubble and reads as typed.
export const myMessageItem = {
  kind: "chat-my-message",
  version: 1,
  schema: z.object({ markdown: z.string(), byAgent: z.boolean().optional() }),
};
export type MyMessage = z.infer<typeof myMessageItem.schema>;

export function myMessageOf(item: { text: string; messageId?: string }): MyMessage | null {
  return item.messageId && messageKeyPattern.test(item.messageId) ? { markdown: item.text } : null;
}

// What one of my agents sent, a chat tab draws in Paseo's agent-message envelope (server/provider.ts), and the
// daemon turns that into an `agent_message` tool call keyed by the envelope's message id, the chat message key.
// Paseo's card draws its body as plain text, so the transform draws it as my bubble marked as sent by AI. The
// client hands a transform the call's `callId`, `name` and `detail` only, without the sending agent, and timeline
// renderers get no navigation, so the mark neither names nor opens the agent.
const agentMessageCallPrefix = "paseo-agent-message:";
export function myAgentMessageOf(item: { name: string; callId: string; detail: { type: string; text?: string } }): MyMessage | null {
  const key = item.callId.startsWith(agentMessageCallPrefix) ? item.callId.slice(agentMessageCallPrefix.length) : "";
  if (item.name !== "agent_message" || !messageKeyPattern.test(key)) return null;
  return item.detail.type === "plain_text" && typeof item.detail.text === "string" ? { markdown: item.detail.text, byAgent: true } : null;
}

// Someone else's message is a bubble on the left under their name and time. Paseo's timeline has no bubble
// for it, so the conversation tab gets it as a plugin item the client draws (`theirMessageItem`), the same
// bubble the plugin's own views draw. What it replies to is a line above it; the bubble holds Markdown:
// the text, then its pictures. `pictures` are the URLs the chat broker serves them at, one per attachment;
// without them the message counts its images.
export const theirMessageItem = {
  kind: "chat-message",
  version: 1,
  // `reply` is what the message answers; `continued` drops the name and time under the same sender's previous message.
  schema: z.object({
    author: z.string(), createdAt: z.string(), markdown: z.string(),
    reply: z.object({ author: z.string(), text: z.string() }).optional(), continued: z.boolean().optional(),
  }),
};
export type TheirMessage = z.infer<typeof theirMessageItem.schema>;

export function theirMessage(message: ChatMessageView, pictures: readonly string[] = [], continued = false): TheirMessage {
  const shown = pictured(message, pictures) ? `\n\n${markdownOf(pictures)}` : imageCount(message);
  return {
    author: message.author, createdAt: message.createdAt, markdown: `${pilled(message.body)}${requestNote(message)}${shown}`,
    ...message.reply ? { reply: quoteOf(message.reply) } : {}, ...continued ? { continued } : {},
  };
}

// My message is Paseo's own bubble, which has no name or time, so the conversation tab draws them as a row
// of their own above the first message of my group, as someone else's bubble has them. Paseo puts the bubble
// of what I send after whatever the tab drew last, so when my next message would start a group the tab ends
// with this row empty (no `sender`), and fills it once my message lands below it (server/provider.ts).
export const senderLineItem = {
  kind: "chat-sender",
  version: 1,
  schema: z.object({ sender: z.object({ author: z.string(), createdAt: z.string() }).optional() }),
};
export type SenderLine = z.infer<typeof senderLineItem.schema>;

// A message as one quoted line: who wrote it and its text. A reply shows what it answers this way, and the
// composer what it is replying to.
export type Quote = { author: string; text: string };
export const quoteOf = (message: Pick<ChatMessageView, "author" | "body">): Quote =>
  ({ author: message.author, text: plainBody(message.body).replace(/\s+/g, " ").trim() });
export const replyOf = (message: ChatMessageView): Quote | null => message.reply && quoteOf(message.reply);

// Messages read in groups, as in Discord and Slack: one sender's messages a few minutes apart show their
// name and time once. A reply starts a group, so what it answers stays next to the name.
export const groupWindowMs = 5 * 60_000;
type Said = Pick<ChatMessageView, "author" | "createdAt">;
export function continues(previous: Said | undefined, message: Said & Pick<ChatMessageView, "reply">): boolean {
  if (!previous || previous.author !== message.author || message.reply) return false;
  const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
  return gap >= 0 && gap < groupWindowMs;
}

// A conversation view's rows: a line for each day, and the messages. A message `continued` its group under
// the previous one; `endsGroup` when the next row is not its group's.
export type MessageRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ChatMessageView; continued: boolean; endsGroup: boolean };

export function messageRows(messages: readonly ChatMessageView[], now = new Date()): MessageRow[] {
  const rows: MessageRow[] = [];
  let previous: ChatMessageView | undefined;
  for (const message of messages) {
    const day = new Date(message.createdAt).toDateString();
    const newDay = !previous || new Date(previous.createdAt).toDateString() !== day;
    if (newDay) rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(message.createdAt, now) });
    rows.push({ kind: "message", key: message.key, message, continued: !newDay && continues(previous, message), endsGroup: true });
    previous = message;
  }
  rows.forEach((row, at) => {
    const next = rows[at + 1];
    if (row.kind === "message") row.endsGroup = !(next?.kind === "message" && next.continued);
  });
  return rows;
}

// "Hôm nay", "Hôm qua", else the weekday and date; the year only when it is not this year.
export function dayLabel(createdAt: string, now = new Date()): string {
  const date = new Date(createdAt);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Hôm nay";
  if (date.toDateString() === yesterday.toDateString()) return "Hôm qua";
  return date.toLocaleDateString("vi-VN", {
    weekday: "long", day: "numeric", month: "long", ...date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" },
  });
}
