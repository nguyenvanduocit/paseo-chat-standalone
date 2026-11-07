import { isDm, type ChatPerson, type ChatSummary, type Presence } from "../shared/chat";
import { needsPerson, type AssistantAgents, type AssistantTab, type WorkerRow } from "../shared/assistant-agents";

// A message preview as one line of plain text: markdown marks, links and code fences add noise in a list.
export function plainPreview(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,!?:;])/g, "$1$2")
    .replace(/(^|\s)(#{1,6}|>|[-*+]|\d+\.)\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Today shows the time (24-hour, as a message's own time reads), this week the weekday, older the date.
export function shortTime(createdAt: string, now = new Date()): string {
  const date = new Date(createdAt);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7) return date.toLocaleDateString("vi-VN", { weekday: "short" });
  return date.toLocaleDateString("vi-VN", { day: "numeric", month: "numeric" });
}

// One handle always gets the same avatar color, so people are recognisable at a glance.
export function avatarHue(handle: string): number {
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function initials(handle: string): string {
  const parts = handle.split(/[-_.\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : handle.slice(0, 2)).toUpperCase();
}

const presenceRank: Record<Presence, number> = { active: 0, afk: 1, offline: 2 };

// Active people first, then AFK, then offline, each by handle.
export function byPresence<Person extends Pick<ChatPerson, "handle" | "presence">>(people: readonly Person[]): Person[] {
  return [...people].sort((a, b) => presenceRank[a.presence] - presenceRank[b.presence] || a.handle.localeCompare(b.handle));
}

// A person's presence in words: active, AFK for how long since their last input, or when they were last seen.
export function presenceLabel(person: Pick<ChatPerson, "presence" | "activeAt" | "lastSeenAt">, now = Date.now()): string {
  if (person.presence === "active") return "Đang hoạt động";
  if (person.presence === "offline") return lastSeen(person.lastSeenAt, now);
  const idle = person.activeAt ? elapsed(person.activeAt, now) : "";
  return idle ? `AFK · ${idle}` : "AFK";
}

export function agentsLabel(agents: number): string {
  return agents ? `${agents} agent đang chạy` : "";
}

// Who is at their keyboard, who is away, and how many agents the team has working, for a list's heading.
export function teamActivity(people: readonly Pick<ChatPerson, "presence" | "agents">[]) {
  return {
    active: people.filter(person => person.presence === "active").length,
    afk: people.filter(person => person.presence === "afk").length,
    agents: people.reduce((total, person) => total + person.agents, 0),
  };
}

export function teamActivityLabel(activity: ReturnType<typeof teamActivity>): string {
  return [`${activity.active} hoạt động`, activity.afk ? `${activity.afk} AFK` : "", agentsLabel(activity.agents)].filter(Boolean).join(" · ");
}

// The other person of a one-to-one conversation; null for a room or a group.
export function partnerOf(conversation: ChatSummary["conversation"], me: string): string | null {
  return isDm(conversation) && conversation.members.length === 2 ? conversation.members.find(member => member !== me) ?? null : null;
}

// Each person's one-to-one conversation, so their row in a people list carries its unread count.
export function oneToOneByPartner<Summary extends Pick<ChatSummary, "conversation">>(conversations: readonly Summary[], me: string): Map<string, Summary> {
  return new Map(conversations.flatMap(summary => {
    const partner = partnerOf(summary.conversation, me);
    return partner ? [[partner, summary] as const] : [];
  }));
}

// The panel's two conversation tabs: one-to-one messages, and groups (rooms and conversations of three or
// more), each in the order given (the inbox's newest first).
export function byKind<Summary extends Pick<ChatSummary, "conversation">>(conversations: readonly Summary[], me: string) {
  return {
    direct: conversations.filter(summary => partnerOf(summary.conversation, me) !== null),
    groups: conversations.filter(summary => partnerOf(summary.conversation, me) === null),
  };
}

// A tab's two parts: what has something unread, then the rest, each in the order given.
export function splitUnread<Summary extends Pick<ChatSummary, "unread">>(conversations: readonly Summary[]) {
  return { unread: conversations.filter(summary => summary.unread > 0), read: conversations.filter(summary => summary.unread === 0) };
}

// Who wrote a conversation's last message, as its preview names them: "Bạn" for me, nothing in a
// one-to-one conversation where the title already names the other person.
export function lastAuthorLabel(summary: Pick<ChatSummary, "conversation" | "last">, me: string): string {
  const author = summary.last?.author;
  if (!author) return "";
  return author === me ? "Bạn" : author === partnerOf(summary.conversation, me) ? "" : author;
}

// When someone was last seen, in words: "vừa xong", "5 phút trước", "3 ngày trước".
export function lastSeen(lastSeenAt: string | null, now = Date.now()): string {
  if (!lastSeenAt) return "";
  const since = elapsed(lastSeenAt, now);
  return since ? `${since} trước` : "vừa xong";
}

// What one of the assistant's tabs is doing, and for how long: "Cần cấp quyền · 3 phút", "Đang chạy · 12 phút",
// "Rảnh · 2 giờ trước".
export function agentStatusLabel(tab: Pick<AssistantTab, "state" | "since">, now = Date.now()): string {
  const since = elapsed(tab.since, now);
  switch (tab.state) {
    case "permission": return since ? `Cần cấp quyền · ${since}` : "Cần cấp quyền";
    case "error": return since ? `Lỗi · ${since} trước` : "Lỗi";
    case "finished": return since ? `Xong, chưa xem · ${since} trước` : "Xong, chưa xem";
    case "running": return since ? `Đang chạy · ${since}` : "Đang chạy";
    case "idle": return since ? `Rảnh · ${since} trước` : "Rảnh";
  }
}

// Whom a worker answers: "Trả lời carol, dave".
export function workerConversationsLabel(worker: Pick<WorkerRow, "conversations">): string {
  return worker.conversations.length ? `Trả lời ${worker.conversations.join(", ")}` : "";
}

// How many of the assistant's tabs wait on me and how many are working, for the AI column's heading.
export function assistantActivity(list: AssistantAgents) {
  const tabs = [...list.workers, ...list.router ? [list.router] : [], ...list.self ? [list.self] : []];
  return { needs: tabs.filter(tab => needsPerson(tab.state)).length, running: tabs.filter(tab => tab.state === "running").length };
}

export function assistantActivityLabel(activity: ReturnType<typeof assistantActivity>): string {
  return [activity.needs ? `${activity.needs} cần bạn` : "", activity.running ? `${activity.running} đang chạy` : ""].filter(Boolean).join(" · ");
}

// When an attention item is due, in words: "Quá hạn 2 giờ", "Hôm nay 15:00", "Mai 09:00", "Th 6 10:00", "12/11 09:00".
export function attentionDueLabel(due: string, now = new Date()): string {
  const date = new Date(due);
  if (date.getTime() < now.getTime()) {
    const late = elapsed(due, now.getTime());
    return late ? `Quá hạn ${late}` : "Đến giờ";
  }
  const clock = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  if (days === 0) return `Hôm nay ${clock}`;
  if (days === 1) return `Mai ${clock}`;
  if (days < 7) return `${date.toLocaleDateString("vi-VN", { weekday: "short" })} ${clock}`;
  return `${date.toLocaleDateString("vi-VN", { day: "numeric", month: "numeric" })} ${clock}`;
}

// How long ago a time was, in words: "5 phút", "2 giờ", "3 ngày"; empty under a minute.
function elapsed(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes} phút`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} giờ`;
  return `${Math.floor(minutes / (24 * 60))} ngày`;
}
