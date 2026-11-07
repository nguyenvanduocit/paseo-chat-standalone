import { defineAgentTool, type AgentToolContext, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  conversationId, conversationTitle, dmOf, handlePattern, maxAttachments, maxChatBodyLength, maxChatQueryLength, messageKeyPattern,
  parseConversationId, priorities, statuses, closingStatuses, type ChatMessageView, type Conversation,
} from "../shared/chat";
import type { ChatClient } from "./chat";
import { imageIdsLine, saveChatImage, uploadImageFiles } from "./image-files";

// Tools every agent session on this daemon gets. They act as the agent's owner (server/daemon.ts `ownerOf`), and every
// message they send is marked as sent by an agent.

// The chat client of the person the calling agent acts for; it fails, with what to do, when the agent has no owner.
export type AgentChat = (context: AgentToolContext) => Promise<ChatClient>;

const handle = z.string().regex(handlePattern);
const target = {
  to: z.array(handle).min(1).max(9).optional()
    .describe("Handles to message directly, e.g. [\"alice\"]. A direct conversation with them is created if needed."),
  conversation: z.string().optional().describe("A conversation id from chat_conversations, e.g. \"dm:alice,bob\" or \"room:project/room\"."),
};

const text = (value: string) => ({ text: value });
const failure = (value: string) => ({ text: value, isError: true });

// What an agent needs to know of a message's request: the request it opens, or the one it answers and where that stands.
export function requestMark(message: ChatMessageView): string | null {
  const request = message.request;
  if (!request) return null;
  const state = `${request.state}${message.status ? `, this message says ${message.status}` : ""}`;
  return request.key === message.key ? `opens request ${request.key}: ${state}` : `in request ${request.key}: ${state}`;
}

// A message as agents read it: its key (usable as replyTo), time, author, body and the ids of its images.
export function messageLine(message: ChatMessageView): string {
  const body = [message.body, imageIdsLine(message)].filter(Boolean).join(" ");
  const marks = [message.priority === "urgent" ? "urgent" : null, message.via ? `via agent "${message.via.agent}"` : null,
    message.reply ? `replying to ${message.reply.author}: "${message.reply.body}"` : null, requestMark(message)].filter(Boolean);
  return `[${message.key}] ${message.createdAt} ${message.author}${marks.length ? ` (${marks.join("; ")})` : ""}: ${body}`;
}

async function resolve(files: ChatClient, input: { to?: string[]; conversation?: string }): Promise<Conversation> {
  if (Boolean(input.to?.length) === Boolean(input.conversation)) throw new Error("Give exactly one of `to` or `conversation`.");
  if (input.conversation) {
    const parsed = parseConversationId(input.conversation);
    if (!parsed) throw new Error(`Unknown conversation id "${input.conversation}". Use chat_conversations to list them.`);
    return parsed;
  }
  const known = new Set((await files.people()).map(person => person.handle));
  const unknown = input.to!.filter(name => !known.has(name));
  if (unknown.length) {
    throw new Error(`No chat user named ${unknown.join(", ")}. Known handles: ${[...known].join(", ") || "none yet"}.`);
  }
  return dmOf([files.me, ...input.to!]);
}

// Image files an agent attaches to a message it sends.
export const imagesInput = z.array(z.string().min(1)).max(maxAttachments).default([])
  .describe("Absolute paths of PNG, JPEG, WebP or GIF files on this host to attach, at most 4, each up to 10 MB.");

// `imageDir` is where chat_image saves images (server/image-files.ts).
// An agent sends a chat message as its person with this tool.
export const chatSendToolName = "chat_send";

// `delegation` is the copy of the team's delegation catalog (server/delegation.ts) that a deciding message cites.
export function chatAgentTools(chat: AgentChat, imageDir: string, delegation: string): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "chat_people",
      title: "List chat people",
      description: "List the people you can message in chat: whether they are active, away from " +
        "the keyboard (Paseo open, no input for 5 minutes) or offline (Paseo closed), and how many of their agents are working.",
      input: z.object({}),
      async execute(_, context) {
        const files = await chat(context);
        const people = await files.people();
        return text(people.map(person => {
          const presence = person.presence === "active" ? "active"
            : person.presence === "afk" ? `away${person.activeAt ? `, last input ${person.activeAt}` : ""}`
            : `offline${person.lastSeenAt ? `, last seen ${person.lastSeenAt}` : ""}`;
          const agents = person.agents ? `, ${person.agents} agent${person.agents > 1 ? "s" : ""} working` : "";
          return `${person.handle}${person.handle === files.me ? " (you)" : ""}: ${presence}${agents}`;
        }).join("\n") || "No one has joined chat yet.");
      },
    }),

    defineAgentTool({
      name: "chat_conversations",
      title: "List chat conversations",
      description: "List your team chat conversations (direct messages and project rooms), newest first, with unread counts and ids for the other chat tools.",
      input: z.object({}),
      async execute(_, context) {
        const files = await chat(context);
        const { conversations } = await files.inbox();
        return text(conversations.map(summary =>
          `${summary.id} — ${summary.title}${summary.unread ? ` — ${summary.unread} unread${summary.mentioned ? ", mentions you" : ""}` : ""}${summary.last ? ` — last: ${summary.last.author}: ${summary.last.preview}` : ""}`).join("\n") || "No conversations yet.");
      },
    }),

    defineAgentTool({
      name: "chat_read",
      title: "Read a chat conversation",
      description: "Read the latest messages of a team chat conversation, oldest first. Each line starts with the message key, usable as replyTo.",
      input: z.object({ ...target, limit: z.number().int().min(1).max(100).default(30) }),
      async execute(input, context) {
        const files = await chat(context);
        try {
          const conversation = await resolve(files, input);
          const { messages } = await files.latest(conversation, input.limit);
          return text([`Conversation ${conversationId(conversation)} — ${conversationTitle(conversation, files.me)}`, ...messages.map(messageLine)].join("\n"));
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    }),

    defineAgentTool({
      name: "chat_search",
      title: "Search team chat",
      description: "Search team chat messages by words (case and accents ignored), in one conversation or in all of yours.",
      input: z.object({ query: z.string().min(1).max(maxChatQueryLength), conversation: target.conversation }),
      async execute(input, context) {
        const files = await chat(context);
        try {
          if (input.conversation) {
            const conversation = await resolve(files, { conversation: input.conversation });
            return text((await files.search(conversation, input.query)).messages.map(messageLine).join("\n") || "No matches.");
          }
          const { messages } = await files.searchAll(input.query);
          return text(messages.map(message => `${message.conversation} ${messageLine(message)}`).join("\n") || "No matches.");
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    }),

    defineAgentTool({
      name: chatSendToolName,
      title: "Send a chat message",
      description: "Send a team chat message as your person, to people directly (`to`) or into a conversation. The recipients get a notification; " +
        "an urgent one sent directly or mentioning them opens a window over their screen. " +
        "Use it when the task needs someone's answer or should tell someone something. " +
        "A message that waits for replies opens a request: what concerns it comes back to you as a new prompt, for 24 hours and, while the request is open, up to 14 days. " +
        "Answering a request, say where it stands with `status`: working (no need to answer yet), input-required (you need something from them), completed, failed or canceled. " +
        "When you asked and got what you needed, close your request: replyTo its key, status completed (or canceled when you no longer need it). " +
        "A message that decides, approves, grants or commits something for your person ends with its basis on its own line: " +
        `\`Delegation: <id> · <handle>\` (an id of the team's delegation catalog, ${delegation}), or ` +
        "`Decided by <handle>: <message-key>` pointing at the message where that person typed the decision themselves.",
      input: z.object({
        ...target,
        body: z.string().min(1).max(maxChatBodyLength).describe("Markdown text. Mention people with @handle."),
        images: imagesInput,
        replyTo: z.string().regex(messageKeyPattern).optional().describe("Key of the message this answers, from chat_read."),
        priority: z.enum(priorities).default("normal").describe("urgent only when the person must act now (an outage, a blocker you cannot pass); it interrupts whatever they are doing."),
        waitForReply: z.boolean().default(true).describe("Open a request and deliver what concerns it to you as prompts. Set false for a notice that needs no answer. A message that closes a request never waits."),
        status: z.enum(statuses).optional().describe("Where the request you reply to stands; needs replyTo pointing into a request."),
      }),
      async execute(input, context) {
        const files = await chat(context);
        try {
          const conversation = await resolve(files, input);
          const id = `agent-${randomBytes(8).toString("hex")}`;
          const via = { agent: context.agent.title?.slice(0, 200) || "agent", agentId: context.agent.id };
          const attachments = await uploadImageFiles(files, input.images);
          const wait = input.waitForReply && !(input.status && closingStatuses.includes(input.status));
          const { message } = await files.send(conversation, id, input.body, attachments,
            { replyTo: input.replyTo, via, priority: input.priority, wait, status: input.status });
          const mark = requestMark(message);
          return text(`Sent to ${conversationTitle(conversation, files.me)} (conversation ${conversationId(conversation)}, key ${message.key}${mark ? `; ${mark}` : ""}).` +
            (wait ? " Replies will arrive as a new prompt." : ""));
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    }),

    defineAgentTool({
      name: "chat_image",
      title: "Save a chat image to view it",
      description: "Save an image of a team chat message to a file on this host and return its path; read that file to see the image. " +
        "Image ids are listed after [images: in chat_read, chat_search and chat prompts.",
      input: z.object({ id: z.string().describe("The image id, 64 hex characters.") }),
      async execute(input, context) {
        try {
          return text(`Saved to ${await saveChatImage(await chat(context), imageDir, input.id)}. Read that file to see the image.`);
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    }),

    defineAgentTool({
      name: "chat_open",
      title: "Open a chat conversation on screen",
      description: "Open a team chat conversation in your person's Paseo window, for example to show them a thread or let them answer themselves.",
      input: z.object(target),
      async execute(input, context) {
        const files = await chat(context);
        try {
          const conversation = await resolve(files, input);
          await files.focus(conversation);
          return text(`Asked every open Paseo window of ${files.me} to show ${conversationTitle(conversation, files.me)}.`);
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    }),
  ];
}
