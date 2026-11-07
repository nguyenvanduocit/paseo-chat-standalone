import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { chosenTab, type TabCandidate } from "../shared/assistant-agents";

// The AI Assistant's tabs as the relay knows them: the person's router and talk-to-myself tab, each worker with what it
// works on, which conversations it was handed, the checklist it reports and how the plugin followed it up, and the
// persona version each agent of the assistant last saw. Each tab is recorded by its Paseo agent and the Claude Code
// session that agent runs, so the relay finds it again, archived or not (server/assistant.ts). Paseo's plugin client
// cannot change an agent's labels, so this lives in one file on the person's own home (`workers.json`, beside the
// rules), written only by the relay. A file written before keeps what it has; fields it no longer has are dropped on
// the next save.

export const maxWorkerTitleLength = 60;
export const maxWorkerTopicLength = 500;

// A step of a worker's checklist (server/progress.ts). Waiting and blocked steps are the worker's blockers: waiting for
// something that comes by itself (a reply, CI, a deploy), blocked when it needs help; the note says what or whom for.
export const stepStatuses = ["pending", "in_progress", "completed", "waiting", "blocked"] as const;
export type StepStatus = typeof stepStatuses[number];
export const maxSteps = 30;
export const maxStepLength = 200;
export const maxStepNoteLength = 500;

const stepSchema = z.object({
  text: z.string().min(1).max(maxStepLength),
  status: z.enum(stepStatuses),
  note: z.string().max(maxStepNoteLength).nullable(),
  // When the step got its status (ms); the plugin keeps it across reports.
  since: z.number(),
});
export type Step = z.infer<typeof stepSchema>;

// The Claude Code session a tab's agent runs, from Paseo's persistence handle. Null until Paseo reports one: a new
// agent has it once its first turn starts.
const sessionId = z.string().nullable();

// One of the person's tabs: its Paseo agent and the Claude Code session that agent runs.
const tabSchema = z.object({ agentId: z.string(), sessionId });
export type TabRecord = z.infer<typeof tabSchema>;

// The talk-to-myself tab also records the version of the access whose paths it was last told (`assistantAccessLabel`);
// null while it knows only the paths it was created with (server/self.ts `selfMovedNotice`).
const selfTabSchema = tabSchema.extend({ access: z.string().nullable().default(null) });
export type SelfTabRecord = z.infer<typeof selfTabSchema>;

const workerSchema = z.object({
  title: z.string().min(1).max(maxWorkerTitleLength),
  // What the worker works on, in the router's words; the router keeps it current as the work moves.
  topic: z.string().min(1).max(maxWorkerTopicLength),
  // Conversation ids the worker was handed; it may read and answer only these.
  conversations: z.array(z.string()),
  // When it was last handed work (ms).
  assignedAt: z.number(),
  // The Claude Code session its agent runs.
  sessionId: sessionId.default(null),
  // Its checklist as it last reported it with assistant_checklist.
  checklist: z.array(stepSchema).default([]),
  // When it last reported, and when the router was last given its report (ms; null: never).
  reportedAt: z.number().nullable().optional(),
  deliveredAt: z.number().nullable().optional(),
  // The plugin put its open work (`progressState`) before the router `count` times, the last at `at`.
  raised: z.object({ state: z.string(), at: z.number(), count: z.number().int() }).nullable().default(null),
  // The router followed it up `count` times while its open work was `state`.
  followedUp: z.object({ state: z.string(), count: z.number().int() }).nullable().default(null),
  // The person's Cần lưu ý item its stuck work went to, that item's title, and the open work it was put there for.
  escalation: z.object({ id: z.string(), title: z.string(), state: z.string() }).nullable().default(null),
}).transform(({ reportedAt, deliveredAt, ...worker }) => ({
  ...worker,
  // A worker from before workers reported counts as reported and given to the router when it was last assigned, so its
  // work is followed from its next assignment instead of all at once.
  reportedAt: reportedAt === undefined ? worker.assignedAt : reportedAt,
  deliveredAt: deliveredAt === undefined ? worker.assignedAt : deliveredAt,
}));
export type Worker = z.infer<typeof workerSchema>;

// What a new worker starts with, beside the work the router gives it.
export const noProgress = () => ({ checklist: [], reportedAt: null, deliveredAt: null, raised: null, followedUp: null, escalation: null });

const registrySchema = z.object({
  // What the Router and Talk to myself buttons open and the relay prompts; null until the relay first finds or creates it.
  router: tabSchema.nullable().default(null),
  self: selfTabSchema.nullable().default(null),
  // The workers by the id of their agent, the id the router hands work to.
  workers: z.record(z.string(), workerSchema).default({}),
  // The persona version (`Persona.version`) each agent of the assistant, router or worker, last saw, by agent id.
  persona: z.record(z.string(), z.string()).default({}),
});
export type WorkerRegistry = z.infer<typeof registrySchema>;

const empty = (): WorkerRegistry => ({ router: null, self: null, workers: {}, persona: {} });

export function workerStore(path: string) {
  return {
    path,
    // None yet, or a file that is not valid JSON of the schema: the relay starts with no tabs recorded rather than stop,
    // and finds the person's router and talk-to-myself tab again by their labels.
    async read(): Promise<WorkerRegistry> {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
        throw error;
      }
      try {
        const parsed = registrySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : empty();
      } catch {
        return empty();
      }
    },
    async save(registry: WorkerRegistry) {
      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
      await writeFile(partial, JSON.stringify(registry, null, 2));
      await rename(partial, path);
    },
  };
}

export type WorkerStore = ReturnType<typeof workerStore>;

// The registry with each recorded tab on its agent as Paseo has it now (`agents`, by label): the agent recorded, else
// the one that runs its recorded Claude Code session (that session imported again as another agent), with the session
// that agent reports. A worker moves to its new agent id with what it was told of the persona. The same registry when
// nothing changed; a tab with no agent left keeps its record.
export function withAgents(registry: WorkerRegistry, agents: { router: readonly TabCandidate[]; self: readonly TabCandidate[]; workers: readonly TabCandidate[] }): WorkerRegistry {
  let changed = false;
  const onAgent = <T extends TabRecord>(record: T, agent: TabCandidate | null): T => {
    const next = agent ? { ...record, agentId: agent.id, sessionId: agent.persistence?.sessionId ?? record.sessionId } : record;
    if (next.agentId === record.agentId && next.sessionId === record.sessionId) return record;
    changed = true;
    return next;
  };
  const persona = { ...registry.persona };
  const workers = Object.fromEntries(Object.entries(registry.workers).map(([id, worker]) => {
    const { agentId, sessionId } = onAgent({ agentId: id, sessionId: worker.sessionId }, chosenTab(agents.workers, { agentId: id, sessionId: worker.sessionId }));
    if (agentId !== id && id in persona) { persona[agentId] = persona[id]; delete persona[id]; }
    return [agentId, sessionId === worker.sessionId ? worker : { ...worker, sessionId }];
  }));
  const router = registry.router && onAgent(registry.router, chosenTab(agents.router, registry.router));
  const self = registry.self && onAgent(registry.self, chosenTab(agents.self, registry.self));
  return changed ? { ...registry, router, self, workers, persona } : registry;
}
