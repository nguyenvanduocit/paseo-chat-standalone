import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema, type PluginAttachmentItem } from "@getpaseo/plugin";
import { z } from "zod";
import { agentIdPattern, agentMention, conversationSchema, handlePattern, personal, type Mention } from "./chat";

// Who a message can mention: people in chat, and the agents of this host, the sender's own.
export const maxMentionQueryLength = 64;
export const maxMentionCandidates = 20;

const candidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), handle: z.string(), online: z.boolean() }),
  z.object({ kind: z.literal("agent"), id: z.string(), title: z.string(), status: z.string() }),
]);
export type MentionCandidate = z.infer<typeof candidateSchema>;

// For the reply boxes of the Chat panel and the pop-up. A direct message offers its members only.
export const readMentionCandidates = defineRpc({
  name: "chat.mention-candidates",
  input: personal({ conversation: conversationSchema.optional(), query: z.string().max(maxMentionQueryLength) }),
  output: z.object({ candidates: z.array(candidateSchema) }),
});

// For Paseo's composer in a chat tab: each pick becomes one of Paseo's attachment pills.
export const searchMentionAttachments = defineRpc({
  name: "chat.mention-attachments",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const mentionAttachmentSource = defineAttachmentSource({
  id: "mention",
  title: "Nhắc tên",
  icon: "AtSign",
  pickerTitle: "Nhắc người hoặc agent",
  searchPlaceholder: "Tìm người hoặc agent của bạn",
  search: searchMentionAttachments,
});

const personResource = "chat-person";
const agentResource = "chat-agent";

export const mentionOf = (candidate: MentionCandidate): Mention => candidate.kind === "person"
  ? { kind: "person", handle: candidate.handle }
  : { kind: "agent", id: candidate.id, title: candidate.title };

// The text in a message body that mentions someone.
export const mentionToken = (mention: Mention) => mention.kind === "person" ? `@${mention.handle}` : agentMention(mention.id, mention.title);

// An attachment in any agent's composer. Its text is what an agent outside chat reads; the chat tab
// turns the attachment back into a mention.
export function mentionAttachmentItem(candidate: MentionCandidate): PluginAttachmentItem {
  if (candidate.kind === "person") {
    return {
      id: candidate.handle, identifier: `@${candidate.handle}`, title: "người trong chat", ...candidate.online ? { subtitle: "đang online" } : {},
      url: `paseo://chat/person/${encodeURIComponent(candidate.handle)}`, resourceType: personResource,
      text: `Team chat handle @${candidate.handle}. Message them with chat_send to ["${candidate.handle}"].`,
    };
  }
  return {
    id: candidate.id, identifier: `@${candidate.title}`, title: "agent của bạn", subtitle: candidate.status,
    url: `paseo://chat/agent/${encodeURIComponent(candidate.id)}`, resourceType: agentResource,
    text: `Paseo agent "${candidate.title}" (id ${candidate.id}) on this host.`,
  };
}

// A composer attachment back as a mention; anything else is not one.
export function mentionOfAttachment(resource: { resourceType: string; id: string; title: string; identifier: string } | undefined): Mention | null {
  if (resource?.resourceType === personResource && handlePattern.test(resource.id)) return { kind: "person", handle: resource.id };
  if (resource?.resourceType === agentResource && agentIdPattern.test(resource.id)) {
    return { kind: "agent", id: resource.id, title: resource.identifier.replace(/^@/, "") };
  }
  return null;
}
