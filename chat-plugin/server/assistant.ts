import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { randomBytes } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { assistantAccessLabel, assistantOfLabel, routerLabel, selfLabel, workerLabel, type RenewableTab } from "../shared/assistant";
import { chosenTab } from "../shared/assistant-agents";
import { addAttention, updateAttention, waitOnOthers, type AttentionItem } from "../shared/attention";
import {
  conversationId, conversationTitle, isDm, mentionsIn, parseConversationId,
  type ChatMessageView, type Conversation,
} from "../shared/chat";
import { chatSendToolName } from "./agent-tools";
import { actsCorpus, type AssistantTab } from "./assistant-acts";
import {
  assignToolName, reportsPrompt, reviewPrompt, routerGuidance, routerTabConfig, routingPrompt,
  type AssignInput, type RouterNotices, type EscalatedWorker, type EscalateInput, type FollowUpInput, type RaisedWorker, type RoutedConversation, type WorkerView,
} from "./assistant-router";
import {
  accessVersion, assignmentPrompt, assistantTabOptions, followUpPrompt, guidanceFor, guidanceLabels, personaChanged, quoted,
  replyToolName, workerGuidance, workerTabConfig, working,
} from "./assistant-tabs";
import { noteDelegation, type AttentionStore } from "./attention";
import { keepDelegation } from "./delegation";
import { attentionToolNames } from "./attention-tools";
import { padTime, type AssistantState, type ChatClient, type ChatEvent } from "./chat";
import { signalRoom, type Signal } from "../shared/signals";
import type { PersonaStore } from "./persona";
import {
  checklistHead, escalationItem, maxFollowUps, mergeChecklist, progressState, progressToolNames, raiseDecision, retireDue,
  reviewEveryMs, situation, stalled, stepLines, utc, type ReportedStep,
} from "./progress";
import { createSelfTab, doctorReport, doctorTurn, improvement, renewalPrompt, selfAccess, selfMovedNotice, startPrompt } from "./self";
import { learnAfterMessages, learningDue, type ConversationMessages, type Learned, type TasteStore } from "./taste";
import { noProgress, withAgents, type TabRecord, type Worker, type WorkerRegistry, type WorkerStore } from "./workers";
import { readAssistantHistory, readWorkHistory } from "./work-history";
import { workCorpus } from "./work-turns";

// The AI Assistant, always on: in the workspace of the person's persona directory (`~/.paseo/chat/<handle>/persona`, index.server.ts),
// one router tab receives every message that writes to the person directly or mentions them, from every conversation,
// and writes each piece of work to the worker tab that owns it (server/assistant-router.ts). Workers keep their context: the same work goes back to the same
// worker, archived or not, whoever asks. Every few seconds the relay hands the router what each conversation said once
// its sender has gone quiet; a router still working takes it into its turn. The relay reads only conversations the chat
// broker said someone wrote in, and every one after the event stream (re)connects, since what happened while it was
// down has no event.
// How far each conversation has been handed to the router is stored with chat (`assistant/<handle>.json`), so a plugin
// reload or a daemon restart neither loses nor repeats a message. What reaches a worker is the router's own message
// (server/assistant-router.ts); the workers are kept in the worker registry (server/workers.ts).
// Workers report their checklists into that registry; the relay hands the router every report, and every minute puts
// work that stopped before the router, or on the person's Cần lưu ý list when the router did not settle it
// (server/progress.ts).

// A sender who stops typing for this long has finished their thought; consecutive messages go in one prompt.
export const quietMs = 8_000;
// One prompt to the router carries at most this many messages of a conversation; the rest go in the next one.
export const maxPromptMessages = 20;
const pageSize = 200;
const learnHistory = 200;

const sentAt = (key: string) => Number(key.slice(0, 13));

// The signal rooms the person's AI Assistant subscribes to: per conversation id, when the
// subscription began, in milliseconds. One handed over from an agent found gone counts from then too, not from the
// handover: alerts that came while the agent was already gone reached no one. The relay's cursor keeps what it already
// passed from coming again.
export type AssistantSignals = ReadonlyMap<string, number>;

export function assistantSignals(signals: readonly Signal[], me: string): AssistantSignals {
  return new Map(signals.flatMap(signal => {
    const mine = signal.subscriptions.find(subscription => subscription.handle === me && subscription.agent === null);
    return mine ? [[conversationId(signalRoom(signal.alert)), mine.at] as const] : [];
  }));
}

// What is addressed to the assistant: someone else's message in a direct message, or in a room when it names the person,
// typed or sent through one of their agents, since people ask through their agents too; and every alert of a signal room
// it subscribes to, sent since the subscription began. A `working` status needs no answer and is not.
export function forAssistant(conversation: Conversation, message: ChatMessageView, me: string, signals: AssistantSignals): boolean {
  if (message.author === me || message.status === "working") return false;
  const subscribedAt = signals.get(conversationId(conversation));
  return isDm(conversation) || mentionsIn(message.body).includes(me) || (subscribedAt !== undefined && sentAt(message.key) >= subscribedAt);
}

type AssistantPaseo = Pick<PaseoApi, "agents" | "workspaces">;
// An agent as the registry records it: its id, and the Claude Code session it runs once Paseo reports one.
type Tabbed = { id: string; persistence?: { sessionId: string } | null };

const statusOf = (agent: PaseoAgent, now: number): WorkerView["status"] =>
  agent.archivedAt ? "archived" : !working(agent) ? "idle" : stalled(Date.parse(agent.updatedAt), now) ? "stalled" : "working";
// A report the router has not been given yet.
const unseenReport = (worker: Worker) => worker.reportedAt !== null && worker.reportedAt > (worker.deliveredAt ?? -Infinity);

// The work and review corpora are read by the talk-to-myself tab in one turn, beside the chat corpus.
const maxWorkBytes = 300_000;
// A busy day of the assistant is about 650 KB of acts, each prompt quoted once.
const maxReviewBytes = 600_000;
// What the router and the workers do in the person's name: message people, hand out and follow up work, keep the
// person's attention list. The daily improvement reviews each such act (server/assistant-acts.ts).
const actTools: ReadonlySet<string> = new Set([
  replyToolName, chatSendToolName, assignToolName, progressToolNames.followUp, progressToolNames.escalate,
  attentionToolNames.add, attentionToolNames.update,
]);
const workRereadMs = 60 * 60_000;

export function assistantRelay(deps: {
  chat: () => Promise<ChatClient>;
  taste: TasteStore;
  persona: PersonaStore;
  workers: WorkerStore;
  attention: AttentionStore;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const now = deps.now ?? Date.now;
  let running = false;
  // Conversations that may hold messages for the assistant; null means every one the person is in.
  let due: Map<string, Conversation> | null = null;
  // A problem that lasts is logged once, not every tick.
  let lastProblem = "";
  const problem = (message: string) => {
    if (message !== lastProblem) deps.log?.(`[chat] AI Assistant: ${message}`);
    lastProblem = message;
  };
  // Signal subscriptions are read every tick; a broker that cannot say (one older than signals answers 404) leaves the
  // assistant with none, and the rest of the relay goes on. Logged once until it answers again.
  let signalsProblem = "";
  async function subscribedSignals(files: ChatClient): Promise<AssistantSignals> {
    try {
      const signals = assistantSignals(await files.signals(), files.me);
      signalsProblem = "";
      return signals;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== signalsProblem) deps.log?.(`[chat] AI Assistant: no signal subscriptions (${message}).`);
      signalsProblem = message;
      return new Map();
    }
  }

  // The team's delegation catalog, copied from the broker each tick (server/delegation.ts). A broker older than the
  // catalog answers 404: the copy stays as it is and the rest of the relay goes on. Logged once until it answers again.
  let delegationProblem = "";
  async function keepCatalog(files: ChatClient) {
    try {
      await keepDelegation((await files.delegation()).text, deps.persona.delegation);
      delegationProblem = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== delegationProblem) deps.log?.(`[chat] AI Assistant: no delegation catalog (${message}).`);
      delegationProblem = message;
    }
  }

  // The stored state for this workspace. A host whose assistant never ran starts from when the plugin first saw it, so
  // it is not sent the whole history; a state from another workspace (an earlier one) keeps where each conversation was up to.
  async function stateFor(files: ChatClient, workspaceId: string): Promise<AssistantState> {
    const stored = await files.assistantState();
    if (stored?.workspaceId === workspaceId) return stored;
    const next = stored?.workspaceId ? { ...stored, workspaceId } : { workspaceId, from: firstSeen ?? padTime(now() + 1), delivered: {} };
    await files.saveAssistantState(next);
    firstSeen = null;
    return next;
  }
  // When a host whose assistant never ran first ticked, before the Paseo client came, which opens its workspace.
  let firstSeen: string | null = null;

  // The person's tabs last as long as their agents do, and Paseo keeps each agent's Claude Code session with it: an
  // archived agent is woken with its context when it is sent a prompt, or when the person opens it (`reload`). So the
  // relay uses the router, the talk-to-myself tab and each worker it recorded (server/workers.ts) while their agents
  // exist, archived or not, in whatever workspace and with whatever access they were created with: Paseo fixes a tab's
  // access then, and the doctor counts the tabs whose access is older than today's. A tab is created, in the assistant's
  // workspace with today's access, only when the person has none or deleted the one recorded (`chosenTab`).
  const tabAccess = () => accessVersion(assistantTabOptions(deps.persona.dir));
  // Every page: a person's archived workers add up.
  async function byLabel(paseo: AssistantPaseo, label: string, me: string) {
    const agents: PaseoAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { labels: { [label]: me }, includeArchived: true }, page: { limit: 200, cursor } });
      agents.push(...page.entries.map(entry => entry.agent));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return agents;
  }

  // A tab's record when the relay starts using its agent: the agent, and the Claude Code session it runs once Paseo
  // reports one. Every tick keeps the record on its agent (`keepRecords`).
  const recordOf = (agent: Tabbed): TabRecord => ({ agentId: agent.id, sessionId: agent.persistence?.sessionId ?? null });

  // A tab the person opens, resumed: an archived one is un-archived and its session resumed first, with its timeline.
  async function resumed(paseo: AssistantPaseo, tab: PaseoAgent): Promise<PaseoAgent> {
    if (!tab.archivedAt) return tab;
    return (await paseo.agents.ref(tab.id).reload())?.agent ?? tab;
  }

  // The person's router, archived or not, recorded as theirs; null when they have none.
  async function routerOf(paseo: AssistantPaseo, me: string): Promise<PaseoAgent | null> {
    const router = chosenTab(await byLabel(paseo, routerLabel, me), (await deps.workers.read()).router);
    if (router) await keepRouter(router);
    return router;
  }
  const keepRouter = (agent: Tabbed) => exclusive(async () => {
    const registry = await deps.workers.read();
    if (registry.router?.agentId !== agent.id) await deps.workers.save({ ...registry, router: recordOf(agent) });
  });

  // A router is created by the first messages for it, or idle when the person opens it before any came.
  async function createRouter(paseo: AssistantPaseo, me: string, workspaceId: string, prompt?: string) {
    const created = await paseo.workspaces.ref(workspaceId).agents.create({
      config: routerTabConfig(me, deps.persona.dir),
      title: "AI · Router",
      labels: { [routerLabel]: me, [assistantOfLabel]: me, [assistantAccessLabel]: tabAccess(), ...guidanceLabels(routerGuidance(me)) },
      ...prompt ? { prompt } : {},
    });
    await keepRouter(created);
    return created;
  }

  // The person's talk-to-myself tab, archived or not, recorded as theirs; null when they have none.
  async function selfOf(paseo: AssistantPaseo, me: string): Promise<PaseoAgent | null> {
    const self = chosenTab(await byLabel(paseo, selfLabel, me), (await deps.workers.read()).self);
    if (self) await keepSelf(self);
    return self;
  }
  // `access`: the tab has now been told the paths of that access.
  const keepSelf = (agent: Tabbed, access?: string) => exclusive(async () => {
    const registry = await deps.workers.read();
    const recorded = registry.self?.agentId === agent.id ? registry.self : { ...recordOf(agent), access: null };
    const self = access === undefined || recorded.access === access ? recorded : { ...recorded, access };
    if (self !== registry.self) await deps.workers.save({ ...registry, self });
  });
  // Whether the talk-to-myself tab knows other paths than today's: those of the access it was created with (its label),
  // or of the access it was last told about.
  async function moved(tab: PaseoAgent): Promise<boolean> {
    const recorded = (await deps.workers.read()).self;
    const knows = (recorded?.agentId === tab.id ? recorded.access : null) ?? tab.labels[assistantAccessLabel];
    return knows !== selfAccess(deps.taste.paths);
  }
  // Sends the talk-to-myself tab a turn from the plugin, after where things are now when they moved since it heard
  // (server/self.ts); a person with no tab gets a new one starting with the turn. A tab in a turn (a talk with the
  // person) takes it into that turn instead of having it cut off.
  async function promptSelf(paseo: AssistantPaseo, me: string, workspaceId: string, tab: PaseoAgent | null, turn: string): Promise<string> {
    if (!tab) {
      const created = await createSelfTab(paseo, workspaceId, me, deps.taste.paths, turn);
      await keepSelf(created);
      return created.id;
    }
    const notice = await moved(tab) ? selfMovedNotice(me, deps.taste.paths) : null;
    await paseo.agents.ref(tab.id).send(notice ? `${notice}\n\n${turn}` : turn, { activeTurnBehavior: "steer" });
    await keepSelf(tab, selfAccess(deps.taste.paths));
    return tab.id;
  }

  // Each recorded worker's agent, by the worker's id: the agent recorded, archived or not, or the one that runs the
  // worker's recorded Claude Code session.
  async function workersOf(paseo: AssistantPaseo, me: string, registry: WorkerRegistry): Promise<Map<string, PaseoAgent>> {
    const agents = await byLabel(paseo, workerLabel, me);
    return new Map(Object.entries(registry.workers).flatMap(([id, worker]) => {
      const agent = chosenTab(agents, { agentId: id, sessionId: worker.sessionId });
      return agent ? [[id, agent] as const] : [];
    }));
  }

  // Each due conversation's messages for the assistant since its cursor, read once per tick.
  async function pending(files: ChatClient, state: AssistantState, checking: Iterable<Conversation>, signals: AssistantSignals) {
    const found: Array<{ conversation: Conversation; id: string; read: ChatMessageView[]; wanted: ChatMessageView[] }> = [];
    for (const conversation of checking) {
      const id = conversationId(conversation);
      // `newer` reads keys after its cursor, and `from` sorts before the first key it allows.
      const cursor = state.delivered[id] ?? "";
      const { messages } = await files.newer(conversation, cursor > state.from ? cursor : state.from, pageSize);
      if (!messages.length) continue;
      const addressed = messages.filter(message => forAssistant(conversation, message, files.me, signals));
      found.push({ conversation, id, read: messages, wanted: addressed });
    }
    return found;
  }

  // Hands the router, in one prompt, every conversation whose sender has gone quiet. Returns the conversations that
  // still hold messages to deliver, for the next tick.
  async function deliver(paseo: AssistantPaseo, files: ChatClient, state: AssistantState, workspaceId: string,
    checking: Iterable<Conversation>, signals: AssistantSignals): Promise<Conversation[]> {
    const delivered = { ...state.delivered };
    const unfinished: Conversation[] = [];
    const ready: RoutedConversation[] = [];
    // Where each ready conversation's cursor goes once the router has it.
    const reached = new Map<string, string>();
    // Oldest waiting first, so a long queue is served in order.
    const waiting = (await pending(files, state, checking, signals)).sort((a, b) => (a.wanted[0]?.key ?? "") < (b.wanted[0]?.key ?? "") ? -1 : 1);
    for (const { conversation, id, read, wanted } of waiting) {
      if (!wanted.length) {
        delivered[id] = read.at(-1)!.key;
        continue;
      }
      // The sender may still be typing.
      if (now() - sentAt(wanted.at(-1)!.key) < quietMs) {
        unfinished.push(conversation);
        continue;
      }
      const sent = wanted.slice(0, maxPromptMessages);
      ready.push({ conversation, messages: sent });
      // Past the last message sent when some wait for the next prompt, past everything read otherwise.
      reached.set(id, wanted.length > sent.length ? sent.at(-1)!.key : read.at(-1)!.key);
      if (wanted.length > sent.length) unfinished.push(conversation);
    }
    if (ready.length) {
      try {
        await promptRouter(paseo, files.me, workspaceId, told => routingPrompt(files.me, ready, told));
        for (const [id, key] of reached) delivered[id] = key;
      } catch (error) {
        // Nothing ready is marked delivered; it is tried again next tick.
        unfinished.push(...ready.map(({ conversation }) => conversation));
        problem(`router: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (Object.keys(delivered).some(id => delivered[id] !== state.delivered[id])) await files.saveAssistantState({ ...state, delivered });
    return unfinished;
  }

  // The registry is written by the relay and by the router's assignments; one write at a time, so none overwrites another.
  let registryTurn: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = registryTurn.then(work);
    registryTurn = next.catch(() => {});
    return next;
  }
  const toldPersona = (agentId: string, version: string) => exclusive(async () => {
    const registry = await deps.workers.read();
    await deps.workers.save({ ...registry, persona: { ...registry.persona, [agentId]: version } });
  });
  const notice = (me: string) => personaChanged(me, deps.persona.dir, deps.persona.delegation);

  // Sends the router a prompt: a working router takes it into its turn, an idle or archived one starts a turn with its
  // context, and with none yet a new one starts with it. One that has not been told about the latest persona (an archived
  // one) is told with it; a new one reads the persona itself, as its system prompt says. One whose system prompt does not
  // hold today's guidance gets it too. Not from inside `exclusive`.
  async function promptRouter(paseo: AssistantPaseo, me: string, workspaceId: string, prompt: (told: RouterNotices) => string) {
    const { version } = await deps.persona.read();
    const router = await routerOf(paseo, me);
    const told = router ? (await deps.workers.read()).persona[router.id] === version : true;
    const text = prompt({ personaNotice: told ? null : notice(me), guidance: router ? guidanceFor(router, routerGuidance(me)) : null });
    const routerId = router
      ? (await paseo.agents.ref(router.id).send(text, { activeTurnBehavior: "steer" }), router.id)
      : (await createRouter(paseo, me, workspaceId, text)).id;
    if (!router || !told) await toldPersona(routerId, version);
  }

  // The talk-to-myself tab or the daily improvement can change the persona any time. Each version is kept in history,
  // and every open router and worker is told at once to read it again; an archived one is told with its next prompt
  // instead, since a message would wake it just for that.
  async function announcePersona(paseo: AssistantPaseo, me: string) {
    const persona = await deps.persona.read();
    await deps.persona.keep(persona);
    const { version } = persona;
    const { persona: told } = await deps.workers.read();
    const agents = [...(await byLabel(paseo, routerLabel, me)), ...(await byLabel(paseo, workerLabel, me))];
    for (const agent of agents) {
      if (agent.archivedAt || told[agent.id] === version) continue;
      await paseo.agents.ref(agent.id).send(notice(me), { activeTurnBehavior: "steer" });
      await toldPersona(agent.id, version);
    }
  }

  // Keeps each recorded tab on its agent: the Claude Code session Paseo reports for it, once its first turn starts and
  // whenever it starts another (its conversation cleared, say), and the agent that runs its recorded session when the
  // recorded agent is gone.
  async function keepRecords(paseo: AssistantPaseo, me: string) {
    const [router, self, workers] = await Promise.all([routerLabel, selfLabel, workerLabel].map(label => byLabel(paseo, label, me)));
    await exclusive(async () => {
      const registry = await deps.workers.read();
      const next = withAgents(registry, { router, self, workers });
      if (next !== registry) await deps.workers.save(next);
    });
  }

  // The router's view of its workers: a line each, then how far its checklist is, the item of the person's list its work
  // is on, and the steps of work still open. Steps are what workers wrote, so the list is fenced as data.
  async function listWorkers(paseo: AssistantPaseo): Promise<string> {
    const me = (await deps.chat()).me;
    const registry = await deps.workers.read();
    const live = await workersOf(paseo, me, registry);
    const { workers } = registry;
    const lines = Object.entries(workers).filter(([id]) => live.has(id)).sort(([, a], [, b]) => b.assignedAt - a.assignedAt).flatMap(([id, worker]) => [
      `${id} "${worker.title}" (${statusOf(live.get(id)!, now())}, last assigned ${utc(worker.assignedAt)}): ${worker.topic} · conversations: ${worker.conversations.join(", ")}`,
      `  ${checklistHead(worker)}${worker.escalation ? ` · on ${me}'s Cần lưu ý list: "${worker.escalation.title}"` : ""}`,
      ...situation(worker) ? stepLines(worker).map(line => `  ${line}`) : [],
    ]);
    return lines.length ? quoted("worker_reports", lines) : "No workers yet.";
  }

  const noSuchWorker = (registry: WorkerRegistry, live: Map<string, PaseoAgent>, id: string) =>
    new Error(`No worker "${id}". Workers: ${Object.keys(registry.workers).filter(key => live.has(key)).join(", ") || "none yet"}.`);

  // Delivers the router's message to a worker, with what the plugin knows for sure: the conversation, the chat messages
  // it is about, the work the worker owns when it is new or moved on, the checklist it reported, and the persona when the
  // worker has not seen it. A worker reports its checklist again after every assignment.
  async function assignNow(paseo: AssistantPaseo, input: AssignInput): Promise<string> {
    const files = await deps.chat();
    const me = files.me;
    const workspaceId = await workspaceOf(paseo);
    const conversation = parseConversationId(input.conversation);
    if (!conversation) throw new Error(`Unknown conversation id "${input.conversation}"; use the id from the prompt.`);
    const id = conversationId(conversation);
    const registry: WorkerRegistry = await deps.workers.read();
    const live = await workersOf(paseo, me, registry);
    const known: Worker | null = input.worker === undefined ? null : registry.workers[input.worker] ?? null;
    // A worker whose agent was deleted, with nothing left that runs its session, is gone.
    const agent = input.worker === undefined ? undefined : live.get(input.worker);
    if (input.worker !== undefined && (!known || !agent)) throw noSuchWorker(registry, live, input.worker);
    if (!known && (!input.title || !input.topic)) throw new Error("A new worker needs a title and a topic.");
    // The messages named must be in this conversation, so the worker reads what was really written.
    const keys = [...new Set(input.messages)];
    const recent = keys.length ? (await files.latest(conversation, pageSize)).messages : [];
    const about = keys.map(key => recent.find(message => message.key === key));
    const missing = keys.filter((_, index) => !about[index]);
    if (missing.length) throw new Error(`Not among the latest ${pageSize} messages of ${id}: ${missing.join(", ")}.`);
    const { version } = await deps.persona.read();
    // A worker that has not been told about the latest persona (an archived one) is told with this assignment, and one
    // whose system prompt does not hold today's guidance gets it; a new one has both in its system prompt.
    const prompt = (tab: PaseoAgent | null, work: { title: string; topic: string } | null) => assignmentPrompt({
      me, conversation, about: about as ChatMessageView[], work, worker: known, message: input.message,
      guidance: tab ? guidanceFor(tab, workerGuidance(me, deps.persona.delegation)) : null,
      personaNotice: tab === null || registry.persona[tab.id] === version ? null : notice(me),
    });

    let workerId: string;
    if (known && agent) {
      // The worker's agent, whatever access it was created with: a working one takes the assignment into its turn, an
      // idle or archived one starts a turn with its context.
      workerId = input.worker!;
      const work = input.topic ? { title: known.title, topic: input.topic } : null;
      await paseo.agents.ref(agent.id).send(prompt(agent, work), { activeTurnBehavior: "steer" });
      registry.workers[workerId] = {
        ...known, topic: input.topic ?? known.topic, assignedAt: now(),
        conversations: known.conversations.includes(id) ? known.conversations : [...known.conversations, id],
      };
    } else {
      const title = input.title!;
      const topic = input.topic!;
      const created = await paseo.workspaces.ref(workspaceId).agents.create({
        config: workerTabConfig(me, deps.persona.dir, deps.persona.delegation),
        title: `AI · ${title}`,
        labels: { [workerLabel]: me, [assistantOfLabel]: me, [assistantAccessLabel]: tabAccess(), ...guidanceLabels(workerGuidance(me, deps.persona.delegation)) },
        prompt: prompt(null, { title, topic }),
      });
      workerId = created.id;
      // Its session is recorded once Paseo reports one (`keepRecords`).
      registry.workers[workerId] = { ...noProgress(), title, topic, conversations: [id], assignedAt: now(), sessionId: null };
    }
    registry.persona[workerId] = version;
    // Workers whose agents were deleted are forgotten.
    for (const key of Object.keys(registry.workers)) {
      if (key !== workerId && !live.has(key)) { delete registry.workers[key]; delete registry.persona[key]; }
    }
    await deps.workers.save(registry);
    return `Sent to ${workerId} "${registry.workers[workerId].title}" about ${conversationTitle(conversation, me)}.`;
  }
  const assign = (paseo: AssistantPaseo, input: AssignInput) => exclusive(() => assignNow(paseo, input));

  // A worker's checklist, from assistant_checklist, kept where the router keeps its workers; the router is given it at a
  // following tick.
  const report = (agentId: string, items: ReportedStep[]) => exclusive(async () => {
    const registry = await deps.workers.read();
    const worker = registry.workers[agentId];
    if (!worker) throw new Error("Only a worker the router assigned work to reports a checklist, and you are not one.");
    const checklist = mergeChecklist(worker.checklist, items, now());
    registry.workers[agentId] = { ...worker, checklist, reportedAt: now() };
    await deps.workers.save(registry);
    return `Recorded: ${checklist.filter(step => step.status === "completed").length}/${checklist.length} completed. The router gets it within seconds.`;
  });

  // The router's message to a worker about its own work (assistant_follow_up), at most `maxFollowUps` times while that
  // work does not move, so the two cannot keep prompting each other.
  const followUp = (paseo: AssistantPaseo, input: FollowUpInput) => exclusive(async () => {
    const me = (await deps.chat()).me;
    const registry = await deps.workers.read();
    const live = await workersOf(paseo, me, registry);
    const worker = registry.workers[input.worker];
    const agent = live.get(input.worker);
    if (!worker || !agent) throw noSuchWorker(registry, live, input.worker);
    const state = progressState(worker);
    const count = worker.followedUp?.state === state ? worker.followedUp.count : 0;
    if (count >= maxFollowUps) {
      throw new Error(`You followed up ${input.worker} ${count} times and its open work has not moved since. If only ${me} can settle it, put it on ${me}'s list with ${progressToolNames.escalate}; otherwise wait for its report.`);
    }
    const { version } = await deps.persona.read();
    const personaNotice = registry.persona[input.worker] === version ? null : notice(me);
    // A working worker takes it into its turn; an idle or archived one starts a turn with its context.
    const guidance = guidanceFor(agent, workerGuidance(me, deps.persona.delegation));
    await paseo.agents.ref(agent.id).send(followUpPrompt({ worker, message: input.message, guidance, personaNotice }), { activeTurnBehavior: "steer" });
    registry.workers[input.worker] = { ...worker, followedUp: { state, count: count + 1 } };
    registry.persona[input.worker] = version;
    await deps.workers.save(registry);
    return `Sent to ${input.worker} "${worker.title}".`;
  });

  // The router puts a worker's open work on the person's list (assistant_escalate).
  const escalate = (paseo: AssistantPaseo, input: EscalateInput) => exclusive(async () => {
    const me = (await deps.chat()).me;
    const registry = await deps.workers.read();
    const live = await workersOf(paseo, me, registry);
    const worker = registry.workers[input.worker];
    const agent = live.get(input.worker);
    if (!worker || !agent) throw noSuchWorker(registry, live, input.worker);
    if (!situation(worker)) {
      throw new Error(`${input.worker} has nothing open: every step it reported is completed. For anything else ${me} must not miss, use ${attentionToolNames.add}.`);
    }
    const item = await putOnList(worker, agent, { title: input.title, detail: input.detail ?? null });
    registry.workers[input.worker] = { ...worker, escalation: { id: item.id, title: item.title, state: progressState(worker) }, raised: null };
    await deps.workers.save(registry);
    return `On ${me}'s Cần lưu ý list as ${item.id}; you are told when it is closed there.`;
  });

  // A worker's open work on the person's list: the open item it has there changed, or a new one. Picking it opens the
  // worker, and it is listed under the conversation the worker was last handed.
  function putOnList(worker: Worker, agent: PaseoAgent, text: { title: string; detail: string | null }): Promise<AttentionItem> {
    const at = new Date(now()).toISOString();
    return deps.attention.change(items => {
      const open = items.find(item => item.id === worker.escalation?.id && !item.doneAt);
      if (open) {
        // Put on the list again, it needs the person again, even when it waited on others.
        const changed = waitOnOthers(updateAttention(items, { id: open.id, title: text.title, detail: text.detail ?? "" }, at)!, open.id, false, at)!;
        return { items: changed, result: changed.find(item => item.id === open.id)! };
      }
      const added = addAttention(items,
        { kind: "blocker", title: text.title, detail: text.detail ?? undefined, conversation: worker.conversations.at(-1) ?? "" },
        { id: randomBytes(6).toString("hex"), now: at, by: agent.title ?? `AI · ${worker.title}`, agentId: agent.id,
          sessionId: agent.persistence?.sessionId ?? null });
      return { items: added.added ? added.items : null, result: added.item };
    });
  }
  const closeOnList = (itemId: string) =>
    deps.attention.change(items => ({ items: updateAttention(items, { id: itemId, done: true }, new Date(now()).toISOString()), result: null }));

  // Every checklist reported since the router last saw it, in one prompt, once its worker has been quiet for `quietMs`,
  // so a burst of reports arrives together. A report counts as given only once the router has the prompt.
  async function deliverReports(paseo: AssistantPaseo, me: string, workspaceId: string) {
    const registry = await deps.workers.read();
    const ready = Object.entries(registry.workers).filter(([, worker]) => unseenReport(worker) && now() - worker.reportedAt! >= quietMs);
    if (!ready.length) return;
    const live = await workersOf(paseo, me, registry);
    const reports = ready.filter(([id]) => live.has(id)).map(([id, worker]) => ({ id, worker, status: statusOf(live.get(id)!, now()) }));
    if (reports.length) await promptRouter(paseo, me, workspaceId, told => reportsPrompt(me, reports, told.personaNotice));
    await exclusive(async () => {
      const registry = await deps.workers.read();
      for (const [id, worker] of ready) if (registry.workers[id]) registry.workers[id] = { ...registry.workers[id], deliveredAt: worker.reportedAt };
      await deps.workers.save(registry);
    });
  }

  // Archives a settled, idle worker, as Paseo has it now: one that started a turn, or moved, since the workers were
  // listed keeps going. Runs inside `exclusive`, so no assignment lands between the check and the archive.
  async function retire(paseo: AssistantPaseo, id: string, worker: Worker) {
    const agent = (await paseo.agents.ref(id).refresh())?.agent;
    if (!agent || agent.archivedAt || working(agent) || !retireDue(worker, Date.parse(agent.updatedAt), now())) return;
    await paseo.agents.ref(id).archive();
  }

  // Every minute, the workers' open work: what stopped goes before the router, or on the person's list once the router
  // was asked `maxRaises` times about it, or at once when the router takes no prompt; an item on the list is closed once
  // its worker settled the work, and the router is told when someone closed it there. Stopped means its agent did nothing
  // for a while, idle, archived or stalled in a turn: no agent is trusted to come back by itself. A
  // worker whose work is settled and that stayed idle `retireAfterMs` is archived (`retireDue`); the router and the
  // talk-to-myself tab are not workers and stay open.
  let reviewedAt = -Infinity;
  async function reviewIfDue(paseo: AssistantPaseo, me: string, workspaceId: string) {
    if (now() - reviewedAt < reviewEveryMs) return;
    reviewedAt = now();
    const live = await workersOf(paseo, me, await deps.workers.read());
    const { raised, escalated } = await exclusive(async () => {
      const registry = await deps.workers.read();
      const items = await deps.attention.read();
      const raised: RaisedWorker[] = [];
      const escalated: EscalatedWorker[] = [];
      let changed = false;
      const update = (id: string, changes: Partial<Worker>) => { registry.workers[id] = { ...registry.workers[id], ...changes }; changed = true; };
      for (const [id, worker] of Object.entries(registry.workers)) {
        const agent = live.get(id);
        if (!agent) continue;
        const view = { id, worker, status: statusOf(agent, now()) };
        const escalation = worker.escalation;
        if (escalation) {
          const item = items.find(each => each.id === escalation.id);
          if (!item || item.doneAt) {
            // Someone closed it on the list: the router hears at once, and follows the work up from there.
            update(id, { escalation: null, raised: null, followedUp: null });
            if (situation(worker)) raised.push({ ...view, count: 1, closed: { title: escalation.title, how: item ? "done" : "removed" } });
            continue;
          }
          if (!situation(worker)) {
            await closeOnList(item.id);
            update(id, { escalation: null, raised: null });
          } else if (progressState(worker) === escalation.state) {
            // With the person while the work is as it was when put there; once it moved, followed up again.
            continue;
          }
        }
        const activeAt = Date.parse(agent.updatedAt);
        // A settled worker is archived once the router has its last report.
        if (!agent.archivedAt && !working(agent) && !unseenReport(worker) && retireDue(worker, activeAt, now())) {
          await retire(paseo, id, worker);
          continue;
        }
        // A report counts as the worker moving whether or not the router was given it, so a worker whose report cannot be
        // delivered is still checked once it has been quiet long enough.
        const decision = raiseDecision(worker, activeAt, now());
        if (decision.kind === "raise") raised.push({ ...view, count: decision.count, closed: null });
        if (decision.kind === "escalate") {
          const item = await putOnList(worker, agent, escalationItem(worker));
          update(id, { escalation: { id: item.id, title: item.title, state: progressState(worker) }, raised: null });
          escalated.push({ ...view, title: item.title });
        }
      }
      if (changed) await deps.workers.save(registry);
      return { raised, escalated };
    });
    if (!raised.length && !escalated.length) return;
    try {
      // A router stalled in its turn would only queue the prompt behind a turn that does not move.
      const router = await routerOf(paseo, me);
      if (router && working(router) && stalled(Date.parse(router.updatedAt), now())) {
        throw new Error(`the router is in a turn with no activity since ${utc(Date.parse(router.updatedAt))}`);
      }
      await promptRouter(paseo, me, workspaceId, told => reviewPrompt(me, raised, escalated, told.personaNotice));
    } catch (error) {
      // A router that takes no prompt cannot settle anything: what it would have been asked goes on the person's list now.
      const routerError = error instanceof Error ? error.message : String(error);
      problem(`could not hand the router stalled work: ${routerError}`);
      await exclusive(async () => {
        const registry = await deps.workers.read();
        for (const { id } of raised) {
          const worker = registry.workers[id];
          const agent = live.get(id);
          if (!worker || !agent || worker.escalation) continue;
          const item = await putOnList(worker, agent, escalationItem(worker, routerError));
          registry.workers[id] = { ...worker, escalation: { id: item.id, title: item.title, state: progressState(worker) }, raised: null };
        }
        await deps.workers.save(registry);
      });
      return;
    }
    // Counted as asked only once the router has the prompt.
    if (raised.length) await exclusive(async () => {
      const registry = await deps.workers.read();
      for (const { id, worker, count } of raised) {
        if (registry.workers[id]) registry.workers[id] = { ...registry.workers[id], raised: { state: progressState(worker), at: now(), count } };
      }
      await deps.workers.save(registry);
    });
  }

  // The person's own recent messages in every conversation, for the daily improvement.
  async function ownHistory(files: ChatClient): Promise<ConversationMessages[]> {
    return Promise.all((await files.joined()).map(async conversation => ({ conversation, messages: (await files.latest(conversation, learnHistory)).messages })));
  }

  // How many messages the person wrote themselves since the last improvement saw.
  const newMessages = (me: string, conversations: ConversationMessages[], learned: Learned | null) => conversations.reduce((sum, { messages }) =>
    sum + messages.filter(message => message.author === me && !message.via && message.key > (learned?.through ?? "")).length, 0);

  // The person's work since the last improvement and older work not read yet, as the next work corpus. The
  // assistant's own tabs are left out: the plugin wrote their prompts.
  async function ownWork(paseo: AssistantPaseo, me: string, learned: Learned | null) {
    const tabs = await Promise.all([routerLabel, workerLabel, selfLabel].map(label => byLabel(paseo, label, me)));
    const skipAgents = new Set(tabs.flat().map(agent => agent.id));
    const cursor = learned?.work ?? null;
    const turns = await readWorkHistory({ usageDir: deps.taste.paths.sessions.usage, handle: me, skipAgents, cursor, maxBytes: maxWorkBytes });
    return workCorpus(me, turns, cursor, maxWorkBytes);
  }
  // What the person's router and workers did in their name since the last review, then older acts not reviewed yet.
  async function assistantWork(paseo: AssistantPaseo, me: string, learned: Learned | null) {
    const tabs = new Map<string, AssistantTab>();
    for (const [label, role] of [[routerLabel, "router"], [workerLabel, "worker"]] as const) {
      for (const agent of await byLabel(paseo, label, me)) tabs.set(agent.id, { role, title: agent.title ?? role });
    }
    const cursor = learned?.review ?? null;
    const acts = await readAssistantHistory({ usageDir: deps.taste.paths.sessions.usage, handle: me, tabs, tools: actTools, cursor, maxBytes: maxReviewBytes });
    return actsCorpus(me, acts, cursor, maxReviewBytes);
  }
  // Reading the sessions takes seconds, so while too little is new they are read again at most once an hour.
  let workReadAt = -Infinity;

  // The scheduler of the daily improvement: checked every tick, it starts at most once a day.
  async function improveIfDue(paseo: AssistantPaseo, files: ChatClient, workspaceId: string) {
    const learned = await deps.taste.learned();
    // Cheap checks first: this runs every tick, an improvement at most once a day.
    if (!learningDue(learned, now())) return;
    const previous = await selfOf(paseo, files.me);
    if (previous && working(previous)) return;
    const conversations = await ownHistory(files);
    const chatNew = newMessages(files.me, conversations, learned);
    if (chatNew < learnAfterMessages && now() - workReadAt < workRereadMs) return;
    workReadAt = now();
    const work = await ownWork(paseo, files.me, learned);
    const review = await assistantWork(paseo, files.me, learned);
    if (chatNew + work.count + review.count < learnAfterMessages) return;
    // A new turn of the person's tab, so a talk in it is kept.
    await promptSelf(paseo, files.me, workspaceId, previous, await improvement({ me: files.me, taste: deps.taste, conversations, work, review, now: now() }));
  }

  // The workspace of the directory holding the persona, found once: opening the directory every tick would be a daemon
  // call every few seconds. Callers share one lookup, since each concurrent open creates a workspace of its own. It is
  // looked up again after a tick fails, in case the workspace was archived.
  let opened: Promise<string> | null = null;
  function workspaceOf(paseo: AssistantPaseo): Promise<string> {
    opened ??= (async () => {
      await mkdir(deps.persona.dir, { recursive: true });
      return (await paseo.workspaces.open(deps.persona.dir)).id;
    })().catch(error => { opened = null; throw error; });
    return opened;
  }

  // The person's router and workers that are open (not archived), how many of them are in a turn, and how many were
  // created with access other than today's.
  async function tabCounts(paseo: AssistantPaseo, me: string) {
    const { entries } = await paseo.agents.list({ filter: { labels: { [assistantOfLabel]: me }, includeArchived: false } });
    const tabs = entries.map(entry => entry.agent).filter(tab => tab.labels[routerLabel] === me || tab.labels[workerLabel] === me);
    return { open: tabs.length, running: tabs.filter(working).length, olderAccess: tabs.filter(tab => tab.labels[assistantAccessLabel] !== tabAccess()).length };
  }

  return {
    // What the chat broker says changed. The person's own messages never reach the assistant.
    notice(event: ChatEvent, me: string) {
      if (event.type === "ready") due = null;
      else if (event.type === "message" && event.author !== me) due?.set(conversationId(event.conversation), event.conversation);
      else if (event.type === "delegation") {
        noteDelegation(deps.attention, event.conversation, event.key, event.decision, now())
          .catch(error => deps.log?.(`[chat] AI Assistant: cannot list the decision ${event.key} (${error instanceof Error ? error.message : String(error)}).`));
      }
    },

    // `paseo` is null until a handler or hook has handed the plugin its client; the state still starts then, so
    // what arrives in the meantime is delivered once it comes.
    async tick(paseo: AssistantPaseo | null) {
      if (running) return;
      running = true;
      try {
        const files = await deps.chat();
        // The workspace is opened through the Paseo client; a host whose assistant never ran starts from its first tick.
        if (!paseo) {
          if ((await files.assistantState())?.workspaceId == null) firstSeen ??= padTime(now() + 1);
          return;
        }
        const workspaceId = await workspaceOf(paseo);
        // First, so nothing that fails after it (a router that takes no prompt fails `deliverReports`) stops the check.
        await reviewIfDue(paseo, files.me, workspaceId);
        const state = await stateFor(files, workspaceId);
        // Events during the delivery land in the new map; what this tick could not finish goes back in it.
        const signals = await subscribedSignals(files);
        // A signal room's alerts reach every handle's event stream; when every conversation is read, the subscribed rooms
        // are read too, joined or not.
        const checking = due ?? new Map([
          ...(await files.joined()).map(conversation => [conversationId(conversation), conversation] as const),
          ...[...signals.keys()].map(id => [id, parseConversationId(id)!] as const),
        ]);
        due = new Map();
        try {
          for (const conversation of await deliver(paseo, files, state, workspaceId, checking.values(), signals)) {
            due.set(conversationId(conversation), conversation);
          }
        } catch (error) {
          due = null;
          throw error;
        }
        await keepCatalog(files);
        await announcePersona(paseo, files.me);
        await keepRecords(paseo, files.me);
        await deliverReports(paseo, files.me, workspaceId);
        await improveIfDue(paseo, files, workspaceId);
        lastProblem = "";
      } catch (error) {
        // A tick runs on a timer: chat not configured or a daemon that cannot be reached is logged, and the next tick tries again.
        problem(error instanceof Error ? error.message : String(error));
        opened = null;
      } finally {
        running = false;
      }
    },

    // The router's tools.
    workers: listWorkers,
    assign,
    followUp,
    escalate,
    // The workers' tools: the conversations a worker may read and answer, and its checklist.
    async assignedTo(agentId: string): Promise<string[]> {
      return (await deps.workers.read()).workers[agentId]?.conversations ?? [];
    },
    report,

    // The router, for the person to watch: theirs, woken with its context when archived; a new idle one in the
    // assistant's workspace only when they have none.
    async openRouter(paseo: AssistantPaseo): Promise<{ agentId: string }> {
      const workspaceId = await workspaceOf(paseo);
      const me = (await deps.chat()).me;
      const router = await routerOf(paseo, me);
      return { agentId: router ? (await resumed(paseo, router)).id : (await createRouter(paseo, me, workspaceId)).id };
    },

    // The talk-to-myself tab, for the person to talk to: theirs, woken with its context when archived, and told where
    // things are now when they moved since it heard; a new one, starting with the doctor, only when they have none.
    async openSelf(paseo: AssistantPaseo): Promise<{ agentId: string }> {
      const workspaceId = await workspaceOf(paseo);
      const me = (await deps.chat()).me;
      const tab = await selfOf(paseo, me);
      if (!tab) return { agentId: await promptSelf(paseo, me, workspaceId, null, startPrompt(me)) };
      const self = await resumed(paseo, tab);
      if (!working(self) && await moved(self)) await promptSelf(paseo, me, workspaceId, self, doctorTurn);
      return { agentId: self.id };
    },

    // Starts the person's router or talk-to-myself tab over: a new tab, recorded as theirs so every button and prompt
    // reaches it, and the old one archived. What the old one learned is kept: the talk-to-myself tab (the new one, when
    // that is what started over) gets a turn to read the old session and write the lessons (server/self.ts). A tab that
    // never ran has no session, so a new router has nothing to learn from and a new talk-to-myself tab starts as usual.
    // A tab in a turn is not started over: what it was working on would be cut off.
    async renew(paseo: AssistantPaseo, renewed: RenewableTab): Promise<{ agentId: string }> {
      const workspaceId = await workspaceOf(paseo);
      const me = (await deps.chat()).me;
      const old = renewed === "router" ? await routerOf(paseo, me) : await selfOf(paseo, me);
      if (old && working(old)) throw new Error(`${renewed === "router" ? "Router" : "Talk to myself"} đang chạy một lượt; đợi nó xong rồi tạo agent mới.`);
      const sessionId = old?.persistence?.sessionId;
      const lessons = sessionId ? renewalPrompt(me, deps.taste.paths, renewed, sessionId) : null;
      const agentId = renewed === "router"
        ? (await createRouter(paseo, me, workspaceId)).id
        : await promptSelf(paseo, me, workspaceId, null, lessons ?? startPrompt(me));
      if (old && !old.archivedAt) await paseo.agents.ref(old.id).archive();
      if (renewed === "router" && lessons) await promptSelf(paseo, me, workspaceId, await selfOf(paseo, me), lessons);
      return { agentId };
    },

    // The talk-to-myself tab's doctor.
    async doctor(paseo: AssistantPaseo) {
      const files = await deps.chat();
      const learned = await deps.taste.learned();
      const self = await selfOf(paseo, files.me);
      return doctorReport({
        now: now(),
        workspace: deps.persona.dir,
        learned,
        newMessages: newMessages(files.me, await ownHistory(files), learned),
        selfWorking: self !== null && working(self),
        persona: await deps.persona.read(),
        decisions: (await readdir(deps.taste.paths.decisions).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
          throw error;
        })).filter(name => name.endsWith(".md")).sort(),
        tabs: await tabCounts(paseo, files.me),
      });
    },

    // The assistant's workspace, for the Chat screen to open.
    workspace: workspaceOf,

    // Whether the talk-to-myself tab is in a turn, for the Chat screen.
    async selfWorking(paseo: AssistantPaseo) {
      const self = await selfOf(paseo, (await deps.chat()).me);
      return self !== null && working(self);
    },

    // The Chat screen's view of the assistant's tabs.
    async tabs(paseo: AssistantPaseo) {
      const { open, running } = await tabCounts(paseo, (await deps.chat()).me);
      return { open, running };
    },
  };
}

export type AssistantRelay = ReturnType<typeof assistantRelay>;
