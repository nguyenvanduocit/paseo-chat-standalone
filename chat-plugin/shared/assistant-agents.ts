import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { conversationTitle, parseConversationId, personal } from "./chat";
import { routerLabel, selfLabel, workerLabel } from "./assistant";

// The AI Assistant's tabs as the Chat screen's AI column shows them: the workers answering messages for the person,
// what waits on the person first, then the router that hands them work, then the talk-to-myself tab.

// What a tab is doing, most urgent first.
export const agentStates = ["permission", "error", "finished", "running", "idle"] as const;
export type AgentState = typeof agentStates[number];

// A state that waits on the person: they grant a permission, look at an error, or read what finished.
export const needsPerson = (state: AgentState) => state === "permission" || state === "error" || state === "finished";

// Idle workers are listed while they worked in the last day, the newest few; the rest, and archived ones, are counted.
export const recentIdleMs = 24 * 60 * 60_000;
export const maxIdleShown = 8;

const tabSchema = z.object({
  id: z.string(), title: z.string(), state: z.enum(agentStates),
  // Since when it is in its state: the turn's start while running, the attention's time while it waits on the
  // person, its last update otherwise.
  since: z.string(),
});
export type AssistantTab = z.infer<typeof tabSchema>;

// A worker also says what it works on and which conversations it answers, as the router assigned them.
const workerRowSchema = tabSchema.extend({ topic: z.string().nullable(), conversations: z.array(z.string()) });
export type WorkerRow = z.infer<typeof workerRowSchema>;

export const readAssistantAgents = defineRpc({
  name: "chat.assistant-agents",
  input: personal({}),
  output: z.object({
    workers: z.array(workerRowSchema),
    // Workers left out: archived, idle for over a day, or past the newest `maxIdleShown` idle ones.
    hiddenWorkers: z.number().int(),
    // Null before the person's first router or talk-to-myself tab exists, or after they archived it.
    router: tabSchema.nullable(),
    self: tabSchema.nullable(),
  }),
});
export type AssistantAgents = z.infer<typeof readAssistantAgents.output>;

// The fields of a Paseo agent snapshot this needs, so the core runs on plain objects.
export type AgentSnapshot = {
  id: string; title: string | null; status: string; updatedAt: string; createdAt: string;
  labels: Record<string, string>; archivedAt?: string | null;
  requiresAttention?: boolean; attentionReason?: "finished" | "error" | "permission" | null; attentionTimestamp?: string | null;
  pendingPermissions: readonly unknown[]; activeTurn?: { startedAt: string | null } | null;
  // The provider session the agent runs, once the provider has one: for Claude, the Claude Code session id.
  persistence?: { sessionId: string } | null;
};

// What the relay recorded of the person's tabs (server/workers.ts): a tab by its agent and the Claude Code session that
// agent runs, and what the router recorded of each worker.
export type TabRecord = { agentId: string; sessionId: string | null };
export type WorkerRecord = { title: string; topic: string; conversations: string[] };
export type TabRecords = { router: TabRecord | null; self: TabRecord | null; workers: Readonly<Record<string, WorkerRecord>> };

export type TabCandidate = Pick<AgentSnapshot, "id" | "createdAt" | "archivedAt" | "persistence">;

// The person's tab among their agents under one label, archived ones included: the agent recorded for it, else the
// agent that runs its recorded Claude Code session (that session imported again as another agent, say). Before one is
// recorded, the newest open one, else the newest archived one. Null when the person deleted the recorded one, or has
// none: the only cases a new tab is created.
export function chosenTab<T extends TabCandidate>(tabs: readonly T[], recorded: TabRecord | null): T | null {
  if (recorded) {
    return tabs.find(tab => tab.id === recorded.agentId)
      ?? (recorded.sessionId ? tabs.find(tab => tab.persistence?.sessionId === recorded.sessionId) : undefined) ?? null;
  }
  return [...tabs].sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function agentState(agent: AgentSnapshot): AgentState {
  if (agent.pendingPermissions.length || (agent.requiresAttention && agent.attentionReason === "permission")) return "permission";
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")) return "error";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.requiresAttention) return "finished";
  return "idle";
}

function tabOf(agent: AgentSnapshot, title: string): AssistantTab {
  const state = agentState(agent);
  const since = state === "running" ? agent.activeTurn?.startedAt ?? agent.updatedAt
    : state === "idle" ? agent.updatedAt : agent.attentionTimestamp ?? agent.updatedAt;
  return { id: agent.id, title, state, since };
}

// The person's tab under `label`, the one its button opens, while it is open: not archived, its session not closed.
function shownTab(agents: readonly AgentSnapshot[], label: string, me: string, recorded: TabRecord | null): AgentSnapshot | null {
  const tab = chosenTab(agents.filter(agent => agent.labels[label] === me), recorded);
  return tab && !tab.archivedAt && tab.status !== "closed" ? tab : null;
}

// Workers by state, most urgent first; within one, the longest waiting first when it waits on the person, the newest
// first otherwise. A worker's conversations read as their titles for the person.
export function assistantAgentList(agents: readonly AgentSnapshot[], records: TabRecords, me: string, now: number): AssistantAgents {
  const mine = agents.filter(agent => agent.labels[workerLabel] === me);
  const rows = mine.filter(agent => !agent.archivedAt && agent.status !== "closed").map((agent): WorkerRow => {
    const record = records.workers[agent.id];
    const conversations = (record?.conversations ?? []).map(id => {
      const conversation = parseConversationId(id);
      return conversation ? conversationTitle(conversation, me) : id;
    });
    return { ...tabOf(agent, record?.title ?? agent.title?.replace(/^AI · /, "") ?? agent.id.slice(0, 8)), topic: record?.topic ?? null, conversations };
  });
  const rank = (row: WorkerRow) => agentStates.indexOf(row.state);
  rows.sort((a, b) => rank(a) - rank(b) || (needsPerson(a.state) ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since)));
  const idle = rows.filter(row => row.state === "idle");
  const shownIdle = idle.filter(row => now - Date.parse(row.since) < recentIdleMs).slice(0, maxIdleShown);
  const router = shownTab(agents, routerLabel, me, records.router);
  const self = shownTab(agents, selfLabel, me, records.self);
  return {
    workers: [...rows.filter(row => row.state !== "idle"), ...shownIdle],
    hiddenWorkers: mine.length - rows.length + idle.length - shownIdle.length,
    router: router ? tabOf(router, "Router") : null,
    self: self ? tabOf(self, "Talk to myself") : null,
  };
}
