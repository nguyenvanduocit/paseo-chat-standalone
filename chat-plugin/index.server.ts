import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentToolContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  chatSettings, claimWorkspace, conversationTitle, markChatRead, openChatTab, parseConversationId,
  readChatInbox, readChatLatest, readDaemonPeople, readWorkspaceOwner, sendChatMessage,
} from "./shared/chat";
import { openRouter, openSelf, readAssistant, renewTab, routerLabel, selfLabel, workerLabel } from "./shared/assistant";
import { chatAgentTools } from "./server/agent-tools";
import { attentionStore } from "./server/attention";
import { attentionTools } from "./server/attention-tools";
import { changeAttention, forkAttention, openAttention, readAttention, removeAttention, updateAttention } from "./shared/attention";
import { forkAttentionItem } from "./server/attention-fork";
import { assistantRelay } from "./server/assistant";
import { routerTools } from "./server/assistant-router";
import { workerTools, working } from "./server/assistant-tabs";
import { ChatBrokerError, openChatClient, resolveChatConfig, type ChatClient } from "./server/chat";
import { daemonStore, noOwner, ownedAgent, ownerOf, peopleOf, withClaim, type OwnedAgent } from "./server/daemon";
import { chatImageDir } from "./server/image-files";
import { hostAgents, mentionCandidates, type HostAgent } from "./server/mentions";
import { assistantAgentList, readAssistantAgents } from "./shared/assistant-agents";
import { chatProvider, chatProviderId, hostProjects, openChatTab as openTab } from "./server/provider";
import { tasteStore, tastePaths } from "./server/taste";
import { personaStore } from "./server/persona";
import { selfTools } from "./server/self";
import { sessionLedger, type AgentSession } from "./server/session-owners";
import { workerStore } from "./server/workers";
import { replyWatcher } from "./server/replies";
import { signalTools } from "./server/signal-tools";
import { changeSignal, readSignals } from "./shared/signals";
import { maxMentionQueryLength, mentionAttachmentItem, readMentionCandidates, searchMentionAttachments } from "./shared/mentions";
import { searchPriorityAttachments, urgentAttachmentItem } from "./shared/priority";

// One daemon serves several people (docs/standalone.md), the ones `CHAT_PEOPLE` lists: every client picks its person and
// names them in each call (`as`), and each person has their own chat client, AI Assistant and files here.

// Delivery waits on time as well as on events: a sender going quiet, a busy agent finishing its turn. The tick reads
// the chat broker only for conversations its events marked; it also refreshes each person's count of working agents.
const tickMs = 5_000;
// Whose each workspace is (server/daemon.ts), and each person's files under `<handle>/`.
const chatRoot = join(homedir(), ".paseo", "chat");
// A person's direct messages open in a workspace of this directory.
const chatHomeOf = (handle: string) => join(homedir(), "Chat", handle);
// What the daily improvement learns from, the worker registry, the attention list and the delegation catalog's copy.
const assistantDirOf = (handle: string) => join(chatRoot, handle, "assistant");
// The persona is a directory of its own, which is also the workspace the AI Assistant's tabs open in.
const personaDirOf = (handle: string) => join(chatRoot, handle, "persona");
// Each person's Claude Code sessions, for the daily improvement (server/work-history.ts): this plugin records each Claude
// agent's session under the agent's owner (server/session-owners.ts).
const sessionUsageDir = join(homedir(), ".paseo", "session-usage");

export default function contribute(server: PluginServerContext) {
  // The client reads these preferences (toasts, pop-ups), shared by everyone on this daemon.
  server.registerSettings(chatSettings);
  const daemon = daemonStore(join(chatRoot, "daemon.json"));
  const everyone = peopleOf(process.env);
  const listed = (handle: string) => {
    if (!everyone.includes(handle)) throw new Error(`"${handle}" không có trong CHAT_PEOPLE của daemon này (${everyone.join(", ")}).`);
  };

  // The plugin process has one Paseo client and hands it to every handler and hook, but not to this function,
  // so work on a timer, and a chat tab sending, use the one a handler or hook last brought.
  let hostPaseo: PaseoApi | null = null;
  const seen = (paseo: PaseoApi) => { hostPaseo = paseo; return paseo; };

  // Everything one person has on this daemon, made the first time they are named and kept while the plugin runs.
  function makePerson(handle: string) {
    const chat = openChatClient(resolveChatConfig(process.env, handle));
    const files = async () => chat;
    const tasteDir = assistantDirOf(handle);
    const taste = tasteStore(tastePaths(tasteDir, personaDirOf(handle), { usage: sessionUsageDir, transcripts: join(homedir(), ".claude", "projects") }));
    const persona = personaStore(taste.paths.persona, taste.paths.history, taste.paths.delegation);
    const workers = workerStore(join(tasteDir, "workers.json"));
    // What the person must not miss from their chats: the assistant writes it, the Chat screen shows it.
    const attention = attentionStore(join(tasteDir, "attention.json"));
    const relay = assistantRelay({ chat: files, taste, persona, workers, attention, log: message => console.error(`${message} (${handle})`) });
    // Agents reach people through chat tools; replies to what they sent, and mentions by their person, come back as
    // prompts: the chat broker records who waits, this daemon hands each agent what is due.
    const replies = replyWatcher({ chat: files, log: message => console.error(`${message} (${handle})`) });
    return { handle, chat, files, persona, workers, attention, attentionTools: attentionTools(attention), relay, replies };
  }
  type Person = ReturnType<typeof makePerson>;
  const people = new Map<string, Promise<Person>>();
  function personOf(handle: string): Promise<Person> {
    try {
      listed(handle);
    } catch (error) {
      return Promise.reject(error);
    }
    let person = people.get(handle);
    if (!person) {
      person = (async () => {
        const made = makePerson(handle);
        // Listed in chat before any client of theirs opens, so others can message them.
        await made.chat.register();
        made.chat.subscribe(event => {
          made.replies.notice(event);
          made.relay.notice(event, made.chat.me);
        });
        return made;
      })().catch(error => { people.delete(handle); throw error; });
      people.set(handle, person);
    }
    return person;
  }
  const chatOf = async (handle: string) => (await personOf(handle)).chat;

  server.handle(readDaemonPeople, async () => ({ people: [...everyone] }));
  server.handle(readWorkspaceOwner, async ({ workspaceId }) => ({ owner: (await daemon.read()).workspaces[workspaceId] ?? null }));
  server.handle(claimWorkspace, async ({ as, workspaceId, claim }) => {
    listed(as);
    return { owner: (await daemon.change(state => withClaim(state, workspaceId, as, claim))).workspaces[workspaceId] ?? null };
  });

  // An agent acts for the person its labels name, else the owner of its workspace, else its parent's (server/daemon.ts).
  async function snapshotOf(paseo: PaseoApi, id: string): Promise<OwnedAgent | null> {
    const agent = (await paseo.agents.ref(id).refresh())?.agent;
    return agent ? ownedAgent(agent) : null;
  }
  async function chatOfAgent({ agent, paseo }: AgentToolContext): Promise<ChatClient> {
    seen(paseo);
    const { workspaces } = await daemon.read();
    const self = await snapshotOf(paseo, agent.id) ?? { id: agent.id, workspaceId: agent.workspaceId, parentAgentId: agent.parentAgentId, labels: {} };
    const owner = await ownerOf(self, workspaces, id => snapshotOf(paseo, id));
    if (!owner) throw new Error(noOwner);
    return chatOf(owner);
  }
  // The open agents of this daemon that act for `handle`.
  async function agentsOf(paseo: PaseoApi, handle: string): Promise<HostAgent[]> {
    const [agents, { workspaces }] = await Promise.all([hostAgents(paseo), daemon.read()]);
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const owners = await Promise.all(agents.map(agent => ownerOf(agent, workspaces, async id => byId.get(id) ?? null)));
    return agents.filter((_, index) => owners[index] === handle);
  }

  // An open client polls the inbox, so the client arrives within seconds of the first window.
  server.handle(readChatInbox, async ({ as, idleMs }, { paseo }) => {
    seen(paseo);
    return (await chatOf(as)).inbox(() => hostProjects(paseo), idleMs);
  });
  server.handle(markChatRead, async ({ as, conversation }) => (await chatOf(as)).markLatestRead(conversation));
  server.handle(readChatLatest, async ({ as, conversation, limit }) => (await chatOf(as)).latest(conversation, limit));
  server.handle(sendChatMessage, async ({ as, conversation, id, body, replyTo }) => (await chatOf(as)).send(conversation, id, body, [], { replyTo }));

  // A conversation's title for the person, or its id when it is not one.
  const titleOf = (id: string, me: string) => { const conversation = parseConversationId(id); return conversation ? conversationTitle(conversation, me) : id; };
  server.handle(readAttention, async ({ as }) => {
    const { attention } = await personOf(as);
    return { items: openAttention(await attention.read()).map(item => ({ ...item, conversationTitle: titleOf(item.conversation, as) })) };
  });
  server.handle(forkAttention, async ({ as, id }, { paseo }) => {
    const { attention } = await personOf(as);
    const item = (await attention.read()).find(candidate => candidate.id === id);
    if (!item) throw new Error("Mục này không còn trong danh sách.");
    return forkAttentionItem(seen(paseo), item, titleOf(item.conversation, as));
  });
  server.handle(changeAttention, async ({ as, id, action }) => {
    const { attention } = await personOf(as);
    await attention.change(items => ({
      items: action === "remove" ? removeAttention(items, id) : updateAttention(items, { id, done: true }, new Date().toISOString()),
      result: null,
    }));
    return {};
  });

  // The AI Assistant answers what others send the person directly or mention them in: a router assigns each message to
  // the worker of its work.
  server.handle(readAssistant, async ({ as }, { paseo }) => {
    seen(paseo);
    const { relay, persona } = await personOf(as);
    return {
      workspaceId: await relay.workspace(paseo),
      tabs: await relay.tabs(paseo),
      persona: await persona.read().then(({ files, updatedAt }) => ({ files: files.length, updatedAt })),
      selfWorking: await relay.selfWorking(paseo),
    };
  });
  // The Chat screen's AI column: the assistant's workers with what the router gave each, its router and the
  // talk-to-myself tab the relay recorded, among the agents under the labels the relay finds them by. Archived tabs are
  // listed too, so the column can count the archived workers.
  server.handle(readAssistantAgents, async ({ as }, { paseo }) => {
    seen(paseo);
    const { workers } = await personOf(as);
    const byLabel = (label: string) => paseo.agents.list({ filter: { labels: { [label]: as }, includeArchived: true } });
    const [tabs, registry] = await Promise.all([Promise.all([workerLabel, routerLabel, selfLabel].map(byLabel)), workers.read()]);
    const agents = tabs.flatMap(({ entries }) => entries.map(entry => entry.agent));
    return assistantAgentList(agents, registry, as, Date.now());
  });
  server.handle(openSelf, async ({ as }, { paseo }) => (await personOf(as)).relay.openSelf(seen(paseo)));
  server.handle(openRouter, async ({ as }, { paseo }) => (await personOf(as)).relay.openRouter(seen(paseo)));
  server.handle(renewTab, async ({ as, tab }, { paseo }) => (await personOf(as)).relay.renew(seen(paseo), tab));

  // Chat settings' Signals section: every signal; the person subscribes their AI Assistant or leaves, and the creator
  // deletes the signal.
  server.handle(readSignals, async ({ as }) => {
    const files = await chatOf(as);
    try {
      return { me: files.me, signals: await files.signals() };
    } catch (error) {
      if (error instanceof ChatBrokerError && error.status === 404) throw new Error("Chat broker này chưa có Signals; cần bản chat broker mới hơn.");
      throw error;
    }
  });
  server.handle(changeSignal, async ({ as, alert, action }) => {
    const files = await chatOf(as);
    if (action === "subscribe") await files.subscribeSignal(alert, null);
    else if (action === "unsubscribe") await files.unsubscribeSignal(alert);
    else await files.deleteSignal(alert);
    return {};
  });

  server.handle(readMentionCandidates, async ({ as, conversation, query }, { paseo }) => {
    const [people, agents] = await Promise.all([(await chatOf(as)).people(), agentsOf(seen(paseo), as)]);
    return { candidates: mentionCandidates(people, as, agents, { conversation, query }) };
  });
  // Paseo's composer asks without saying whose tab it is, so it offers everyone in chat and every agent of this daemon.
  server.handle(searchMentionAttachments, async ({ query }, { paseo }) => {
    const [people, agents] = await Promise.all([chatOf(everyone[0]).then(chat => chat.people()), hostAgents(seen(paseo))]);
    return { items: mentionCandidates(people, null, agents, { query: query.slice(0, maxMentionQueryLength) }).map(mentionAttachmentItem) };
  });
  server.handle(searchPriorityAttachments, async () => ({ items: [urgentAttachmentItem] }));

  // A conversation is a Paseo agent tab: Paseo's own composer and timeline show it. A provider has no
  // Paseo client of its own; a tab's session opens through the hook below, which brings the plugin's client.
  server.registerProvider(chatProvider(chatOf, everyone));
  server.handle(openChatTab, async ({ as, conversation }, { paseo }) => openTab(seen(paseo), await chatOf(as), conversation, chatHomeOf(as)));

  // Every interactive agent gets the chat tools, which act for its owner. The AI Assistant's workers also get the tools
  // that answer their assigned conversations and report their checklist, the router the tools that assign and follow up
  // work, and the talk-to-myself tab the doctor; all three the attention list of their person.
  const imageDir = chatImageDir();
  const tools = [...chatAgentTools(chatOfAgent, imageDir, join(chatRoot, "<handle>", "assistant", "delegation.md")), ...signalTools(chatOfAgent)];
  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    seen(paseo);
    if (request.purpose !== "interactive" || request.provider === chatProviderId) return;
    return { ...request, tools: [...request.tools, ...tools, ...await ownTools(paseo, request.labels ?? {})] };
  });
  async function ownTools(paseo: PaseoApi, labels: Readonly<Record<string, string>>) {
    const owner = labels[routerLabel] ?? labels[workerLabel] ?? labels[selfLabel];
    // A tab of someone no longer in CHAT_PEOPLE still opens, without their assistant's tools.
    if (owner === undefined || !everyone.includes(owner)) return [];
    const person = await personOf(owner);
    const { relay } = person;
    if (labels[routerLabel] !== undefined) {
      return [...routerTools({
        workers: () => relay.workers(paseo),
        assign: input => relay.assign(paseo, input),
        followUp: input => relay.followUp(paseo, input),
        escalate: input => relay.escalate(paseo, input),
      }), ...person.attentionTools];
    }
    if (labels[workerLabel] !== undefined) {
      return [...workerTools(person.files, { assignedTo: relay.assignedTo, report: relay.report }), ...person.attentionTools];
    }
    return [...selfTools(async () => relay.doctor(paseo)), ...person.attentionTools];
  }
  // Everyone sees how many of their agents are working, also while no window is open: an agent starting a turn
  // brings the client too.
  // A turn's start is when a resumed session's own lines begin (server/session-owners.ts), kept until the turn ends.
  const turnStarts = new Map<string, string>();
  server.addHook("agent.turn.before", async ({ agent }, { paseo }) => {
    seen(paseo);
    turnStarts.set(agent.id, new Date().toISOString());
  });

  async function tickPerson(paseo: PaseoApi | null, person: Person) {
    await Promise.all([
      person.replies.tick(paseo),
      person.relay.tick(paseo),
      paseo && agentsOf(paseo, person.handle).then(agents => person.chat.reportAgents(agents.filter(working).length))
        .catch(error => console.error(`[chat] Could not report working agents (${person.handle}).`, error)),
    ]);
  }
  // Each Claude agent's session under the person the agent acts for (server/session-owners.ts): recorded when one of its
  // turns ends, which every session with something in it has, and once for all agents when the plugin first has a
  // Paseo client. An agent whose workspace has no owner yet is recorded at a turn after someone claims it.
  const sessions = sessionLedger({ usageDir: sessionUsageDir, transcriptsDir: join(homedir(), ".claude", "projects") });
  type AgentSnapshot = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
  async function sessionOf(agent: AgentSnapshot, workspaces: Readonly<Record<string, string>>, parentOf: (id: string) => Promise<OwnedAgent | null>): Promise<AgentSession | null> {
    const sessionId = agent.persistence?.provider === "claude" ? agent.persistence.sessionId : null;
    if (!sessionId) return null;
    const owner = await ownerOf(ownedAgent(agent), workspaces, parentOf);
    return owner ? { agentId: agent.id, sessionId, cwd: agent.cwd, createdAt: agent.createdAt, owner } : null;
  }
  server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
    seen(paseo);
    const startedAt = turnStarts.get(agent.id) ?? new Date().toISOString();
    turnStarts.delete(agent.id);
    try {
      const [snapshot, { workspaces }] = await Promise.all([paseo.agents.ref(agent.id).refresh(), daemon.read()]);
      const session = snapshot?.agent ? await sessionOf(snapshot.agent, workspaces, id => snapshotOf(paseo, id)) : null;
      if (session) await sessions.record([session], startedAt);
    } catch (error) {
      console.error(`[chat] Could not record the Claude Code session of ${agent.id}.`, error);
    }
  });
  async function recordEveryAgent(paseo: PaseoApi) {
    const agents: AgentSnapshot[] = [];
    for (let cursor: string | undefined; ;) {
      const { entries, pageInfo } = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      agents.push(...entries.map(entry => entry.agent));
      if (!pageInfo.hasMore || !pageInfo.nextCursor) break;
      cursor = pageInfo.nextCursor;
    }
    const { workspaces } = await daemon.read();
    const byId = new Map(agents.map(agent => [agent.id, ownedAgent(agent)]));
    const found = await Promise.all(agents.map(agent => sessionOf(agent, workspaces, async id => byId.get(id) ?? null)));
    await sessions.record(found.filter(session => session !== null), new Date().toISOString());
  }
  let recordedEveryAgent = false;
  const timer = setInterval(() => {
    for (const person of people.values()) void person.then(made => tickPerson(hostPaseo, made), () => {});
    if (hostPaseo && !recordedEveryAgent) {
      recordedEveryAgent = true;
      void recordEveryAgent(hostPaseo).catch(error => console.error("[chat] Could not record the Claude Code sessions of every agent.", error));
    }
  }, tickMs);
  timer.unref?.();

  // Everyone of this daemon is in chat, and has their AI Assistant running, without opening a client.
  for (const handle of everyone) void personOf(handle).catch(error => console.error(`[chat] Could not start chat for ${handle}.`, error));

  return () => {
    clearInterval(timer);
    for (const person of people.values()) void person.then(made => made.chat.close(), () => {});
  };
}
