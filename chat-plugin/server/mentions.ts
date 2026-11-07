import type { PaseoApi } from "@getpaseo/client";
import { isDm, type ChatPerson, type Conversation } from "../shared/chat";
import { maxMentionCandidates, type MentionCandidate } from "../shared/mentions";
import { ownedAgent, type OwnedAgent } from "./daemon";
import { chatProviderId } from "./provider";

const matches = (query: string, ...names: string[]) => {
  const wanted = query.trim().toLowerCase();
  return !wanted || names.some(name => name.toLowerCase().includes(wanted));
};

export interface HostAgent extends OwnedAgent { title: string; status: string }

// The agents of this daemon that can be mentioned or counted as working: open ones, newest first, without chat tabs.
export async function hostAgents(paseo: Pick<PaseoApi, "agents">): Promise<HostAgent[]> {
  const { entries } = await paseo.agents.list({
    filter: { includeArchived: false }, sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 200 },
  });
  return entries.map(entry => entry.agent)
    .filter(agent => agent.provider !== chatProviderId && !agent.archivedAt && !agent.internal && agent.status !== "closed")
    .map(agent => ({ ...ownedAgent(agent), title: agent.title?.trim() || agent.id.slice(0, 8), status: agent.status }));
}

// People first, online before offline; a direct message offers only its other members. `me` is left out of the people;
// `agents` are the ones the sender may mention, their own.
export function mentionCandidates(people: readonly ChatPerson[], me: string | null, agents: readonly HostAgent[], input: { conversation?: Conversation; query: string }): MentionCandidate[] {
  const members = input.conversation && isDm(input.conversation) ? new Set(input.conversation.members) : null;
  const named: MentionCandidate[] = people
    .filter(person => person.handle !== me && (!members || members.has(person.handle)) && matches(input.query, person.handle))
    .map(person => ({ handle: person.handle, online: person.presence !== "offline" }))
    .sort((a, b) => Number(b.online) - Number(a.online))
    .map(person => ({ kind: "person", ...person }));
  const mentionable: MentionCandidate[] = agents
    .filter(agent => matches(input.query, agent.title))
    .map(({ id, title, status }) => ({ kind: "agent", id, title, status }));
  return [...named, ...mentionable].slice(0, maxMentionCandidates);
}
