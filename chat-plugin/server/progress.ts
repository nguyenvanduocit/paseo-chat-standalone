import { createHash } from "node:crypto";
import { z } from "zod";
import { maxAttentionDetailLength, maxAttentionTitleLength } from "../shared/attention";
import { fold } from "../shared/fold";
import { maxStepLength, maxStepNoteLength, maxSteps, stepStatuses, type Step, type StepStatus, type Worker } from "./workers";

// Assign, then report. A worker that takes work sends the router its checklist with assistant_checklist, and every
// change after that goes through the same tool into the router's registry (server/workers.ts); its waiting and blocked
// steps are its blockers. The relay (server/assistant.ts) hands the router every report, checks the workers every minute
// for work that stopped before it was settled and puts it before the router, and puts on the person's Cần lưu ý list
// what the router did not settle, or could not be handed. The check trusts no agent to be alive: a worker archived, one
// whose turn went silent and a router that takes no prompt are caught all the same. The router follows a
// worker up with assistant_follow_up, and puts stuck work on the list itself with assistant_escalate. This module is the rules; the tools are with the router's and the workers'
// (server/assistant-router.ts, server/assistant-tabs.ts), the reading, writing and sending in the relay.

export const progressToolNames = { checklist: "assistant_checklist", followUp: "assistant_follow_up", escalate: "assistant_escalate" } as const;

// The relay checks the workers this often.
export const reviewEveryMs = 60_000;
// Open work is put before the router once it has not moved for this long: a worker that stopped with steps left, with a
// blocked step, or without a checklist since its last assignment. With only waiting steps, after `waitMs`.
export const stallMs = 15 * 60_000;
export const waitMs = 2 * 60 * 60_000;
// The same open work is put before the router again after this long; when it was put there `maxRaises` times, the
// plugin puts it on the person's list instead.
export const raiseEveryMs = 60 * 60_000;
export const maxRaises = 2;
// The router follows a worker up at most this many times while its open work does not move, so a router and a worker
// cannot keep prompting each other.
export const maxFollowUps = 3;

export const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

const isOpen = (step: Step) => step.status !== "completed";
const unreported = (worker: Worker) => worker.reportedAt === null || worker.reportedAt < worker.assignedAt;

// What keeps a worker's work open, the most pressing first; null once it is settled: it reported since it was last
// assigned work, and every step is completed.
export type Situation = "unreported" | "blocked" | "waiting" | "unfinished";
export function situation(worker: Worker): Situation | null {
  if (unreported(worker)) return "unreported";
  const open = worker.checklist.filter(isOpen);
  if (open.some(step => step.status === "blocked")) return "blocked";
  if (open.some(step => step.status === "waiting")) return "waiting";
  return open.length ? "unfinished" : null;
}

// The worker's open work as one value, to tell whether it moved: an assignment it has not reported on, and the text and
// status of each open step. A note, or a step reported already completed, does not move it.
export function progressState(worker: Worker): string {
  const open = worker.checklist.filter(isOpen).map(step => [fold(step.text), step.status]);
  const pending = unreported(worker) ? worker.assignedAt : null;
  return createHash("sha256").update(JSON.stringify({ pending, open })).digest("hex").slice(0, 16);
}

// What a worker reports: its whole checklist, in order.
export const checklistInput = z.object({
  items: z.array(z.object({
    text: z.string().trim().min(1).max(maxStepLength).describe("The step, in one line."),
    status: z.enum(stepStatuses).describe(
      "pending, in_progress or completed; waiting for something that comes by itself (a reply, CI, a deploy); blocked when you need help (access, a decision, a failure you cannot fix).",
    ),
    note: z.string().trim().max(maxStepNoteLength).optional()
      .describe("Required when waiting or blocked: what or whom it waits for, and what would settle it."),
  })).min(1).max(maxSteps).describe("Your whole checklist, every step until the work is settled."),
});
export type ReportedStep = z.infer<typeof checklistInput>["items"][number];

// A waiting or blocked step says what it waits for; the index of the first that does not, or -1.
export const unexplainedStep = (items: readonly ReportedStep[]) =>
  items.findIndex(step => (step.status === "waiting" || step.status === "blocked") && !step.note);

// The reported checklist, each step keeping its `since` when the last report had it with the same status.
export function mergeChecklist(previous: readonly Step[], reported: readonly ReportedStep[], now: number): Step[] {
  return reported.map(step => {
    const before = previous.find(old => old.status === step.status && fold(old.text) === fold(step.text));
    return { text: step.text, status: step.status, note: step.note || null, since: before?.since ?? now };
  });
}

// When the worker last moved: its last report, its last assignment, or the last thing its agent did (`activeAt`).
const lastMoved = (worker: Worker, activeAt: number) =>
  Math.max(worker.reportedAt ?? 0, worker.assignedAt, Number.isFinite(activeAt) ? activeAt : 0);

// A worker in a turn whose agent did nothing for `stallMs` (a tool that never returns, a question nobody answers) has
// stalled: its work is checked as if it had stopped. `activeAt` is the agent's `updatedAt`, which Paseo moves with every
// event of a turn.
export const stalled = (activeAt: number, now: number) => now - activeAt >= stallMs;

// A worker whose work is settled (`situation` null: it reported since it was last assigned work, every step completed,
// nothing waiting or blocked) and that has not moved for this long is archived; the router wakes it with its context
// when it hands it work again.
export const retireAfterMs = 5 * 60_000;

// Whether an idle worker is archived now. `activeAt` is when its agent last did anything.
export function retireDue(worker: Worker, activeAt: number, now: number): boolean {
  if (situation(worker)) return false;
  return now - lastMoved(worker, activeAt) >= retireAfterMs;
}

export type RaiseDecision = { kind: "wait" } | { kind: "raise"; count: number } | { kind: "escalate" };

// For a worker whose open work is not on the person's list as it is now, idle, archived or in a turn: put it before the
// router (the how-many-th time), put it on the person's list, or wait. `activeAt` is when its agent last did anything, so
// a worker at work waits.
export function raiseDecision(worker: Worker, activeAt: number, now: number): RaiseDecision {
  const what = situation(worker);
  if (!what) return { kind: "wait" };
  if (worker.raised?.state === progressState(worker)) {
    if (now - worker.raised.at < raiseEveryMs) return { kind: "wait" };
    return worker.raised.count >= maxRaises ? { kind: "escalate" } : { kind: "raise", count: worker.raised.count + 1 };
  }
  return now - lastMoved(worker, activeAt) >= (what === "waiting" ? waitMs : stallMs) ? { kind: "raise", count: 1 } : { kind: "wait" };
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

// What the plugin writes on the person's list when the router did not settle a worker's open work, or could not be handed
// it (`routerError`), in the language of the list's screen.
export function escalationItem(worker: Worker, routerError: string | null = null): { title: string; detail: string } {
  const what = situation(worker);
  const open = worker.checklist.filter(isOpen);
  const first = (status: StepStatus) => open.find(step => step.status === status)!;
  const reason = (step: Step) => step.note ?? step.text;
  const named = `AI "${worker.title}"`;
  const title = what === "blocked" ? `${named} bị chặn: ${reason(first("blocked"))}`
    : what === "waiting" ? `${named} chờ quá lâu: ${reason(first("waiting"))}`
    : what === "unfinished" ? `${named} dừng khi còn ${open.length} bước chưa xong`
    : `${named} nhận việc mà chưa báo checklist`;
  const steps = open.map(step => `${step.text} (${step.status}${step.note ? `: ${step.note}` : ""})`).join("; ");
  return {
    title: clip(title, maxAttentionTitleLength),
    detail: clip(`${routerError === null ? `Router đã được nhắc ${maxRaises} lần mà việc không nhúc nhích.` : `Không gửi được cho Router (${routerError}).`}${steps ? ` Còn mở: ${steps}` : ""}`, maxAttentionDetailLength),
  };
}

// How far a worker is, in one line.
export function checklistHead(worker: Worker): string {
  const done = worker.checklist.filter(step => !isOpen(step)).length;
  const head = worker.checklist.length && worker.reportedAt !== null
    ? `checklist ${done}/${worker.checklist.length} completed, reported ${utc(worker.reportedAt)}`
    : "no checklist";
  return unreported(worker) ? `${head}; nothing reported since it was assigned work at ${utc(worker.assignedAt)}` : head;
}

// Its steps; those whose status changed after `changedAfter` are marked.
export function stepLines(worker: Worker, changedAfter: number | null = null): string[] {
  return worker.checklist.map(step => [
    `- [${step.status}${isOpen(step) ? ` since ${utc(step.since)}` : ""}] ${step.text}`,
    step.note ? ` — ${step.note}` : "",
    changedAfter !== null && step.since > changedAfter ? " (changed)" : "",
  ].join(""));
}

// What every assignment and follow-up tells a worker, since its system prompt is fixed when its tab is created.
export function progressGuidance(me: string): string {
  return [
    `Report to the router with ${progressToolNames.checklist}: it is how the router and ${me} know what you do and how far you are.`,
    "- Before you start, send your checklist for this work: every step until it is settled, even a single one. Send the",
    "  whole list each time, and again as the work moves: pending, in_progress, completed.",
    "- A step you cannot go on with is waiting (for something that comes by itself: a reply, CI, a deploy) or blocked (you",
    `  need help: access, ${me}'s decision, a failure you cannot fix), with a note saying what or whom it waits for.`,
    "- Never end a turn with work left and nothing waiting or blocked. The router reads every report; the plugin puts what",
    `  stays open before the router, and on ${me}'s Cần lưu ý list what the router does not settle.`,
  ].join("\n");
}
