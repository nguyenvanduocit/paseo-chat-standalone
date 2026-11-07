import { defineAttachmentSource, defineRpc, PluginAttachmentSearchPayloadSchema, type PluginAttachmentItem } from "@getpaseo/plugin";
import { z } from "zod";

// Paseo's composer in a chat tab marks a message urgent with a pill, as it picks mentions: the one item below.
export const searchPriorityAttachments = defineRpc({
  name: "chat.priority-attachments",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const urgentAttachmentSource = defineAttachmentSource({
  id: "urgent",
  title: "Khẩn",
  icon: "Siren",
  pickerTitle: "Đánh dấu tin khẩn",
  searchPlaceholder: "Tin khẩn mở cửa sổ ở máy người nhận",
  search: searchPriorityAttachments,
});

const urgentResource = "chat-priority";

// Its text is what an agent outside chat reads when the pill lands in its composer.
export const urgentAttachmentItem: PluginAttachmentItem = {
  id: "urgent", identifier: "!khẩn", title: "tin khẩn", subtitle: "mở cửa sổ ở máy người nhận",
  url: "paseo://chat/priority/urgent", resourceType: urgentResource,
  text: "Mark the team chat message urgent: chat_send with priority \"urgent\".",
};

export const isUrgentAttachment = (resource: { resourceType: string; id: string } | undefined) =>
  resource?.resourceType === urgentResource && resource.id === urgentAttachmentItem.id;
