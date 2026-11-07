import { z } from "zod";

// What the person decided while they worked, from their own Claude Code transcripts: every prompt they typed and every
// question of the AI they answered, each with what the AI had just said. The daily improvement learns the person's
// taste and their decisions from it (server/self.ts). Pure: server/work-history.ts reads the files.
//
// A transcript also holds what no person typed: tool results, another agent's message, a background task's notice, a
// scheduled run, a resumed session's summary, a skill's text, a dispatch another agent wrote (`GOAL:`, the team's
// dispatch format), and chat messages a plugin delivered (`<chat_messages>`,
// which the chat corpus already has). Only what the person typed or chose is kept.

// One session the person ran, as the SessionStart hook recorded it (`~/.paseo/session-usage/<handle>/<id>.json`).
export const sessionRecordSchema = z.object({
  sessionId: z.string(),
  transcriptPath: z.string(),
  cwd: z.string().default(""),
  source: z.string().default("startup"),
  startedAt: z.string(),
  agentIds: z.array(z.string()).default([]),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export interface WorkTurn {
  at: string;
  sessionId: string;
  cwd: string;
  // A prompt the person typed, or their answer to a question the AI asked with options.
  kind: "prompt" | "answer";
  text: string;
  // What the AI said or asked just before, cut to its end.
  before: string;
}

const maxText = 2000;
const maxBefore = 500;
const machineOrigins = new Set(["task_notification", "peer", "scheduled"]);
const machineStarts = [
  "<paseo-system", "<task-notification", "This session is being continued", "Base directory for this skill",
  "<command-", "<local-command", "[Request interrupted", "Caveat:", "Your last turn was cut off",
];
// What the chat plugin sends the AI Assistant's own tabs, now and in its earlier versions: a session that was sent one
// is an assistant tab, so nothing typed in it is the person's. Tabs that still exist are skipped by their labels too
// (server/work-history.ts); this catches the ones deleted since.
const assistantPrompts = [
  /^Assignment from the router\b/, /^## \S+'s persona changed/, /^New messages in \d+ conversation/,
  /^You are \S+'s AI Assistant/, /^Start: (run assistant_doctor|in a few lines)/, /^Daily improvement:/, /^Rewrite \S+'s taste profile/,
];
const machineText = (text: string) =>
  machineStarts.some(start => text.startsWith(start)) || /^GOAL\b/.test(text) || text.includes("<chat_messages>");

const head = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const tail = (text: string, max: number) => text.length > max ? `…${text.slice(-max)}` : text;
const withoutReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

interface Part { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; input?: unknown }
interface TranscriptRecord {
  type?: string; timestamp?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean;
  promptSource?: string | null; turnOrigin?: string | null;
  message?: { content?: string | Part[] };
  toolUseResult?: unknown;
}

const partsOf = (record: TranscriptRecord): Part[] => {
  const content = record.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
};

const askedSchema = z.object({
  questions: z.array(z.object({ question: z.string(), options: z.array(z.object({ label: z.string() })).default([]) })),
});
const answeredSchema = z.object({ answers: z.record(z.string(), z.string()) });

const questionText = (input: unknown) => {
  const asked = askedSchema.safeParse(input);
  if (!asked.success) return "";
  return asked.data.questions.map(({ question, options }) =>
    `Asked: ${question}${options.length ? ` (options: ${options.map(option => option.label).join(" | ")})` : ""}`).join("\n");
};

// The person's turns in one transcript, oldest first. A session that was resumed or forked carries the history of the
// one it came from, which that one's own record already covers, so only what came after it started is kept.
export function workTurns(lines: Iterable<string>, session: SessionRecord): WorkTurn[] {
  const copied = session.source === "resume" || session.source === "fork";
  const turns: WorkTurn[] = [];
  let before = "";
  let assistantTab = false;
  for (const line of lines) {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A transcript being written can end in a partial line.
    }
    if (record.isSidechain) continue;
    if (record.type === "assistant") {
      for (const part of partsOf(record)) {
        if (part.type === "text" && part.text?.trim()) before = part.text.trim();
        if (part.type === "tool_use" && part.name === "AskUserQuestion") before = questionText(part.input) || before;
      }
      continue;
    }
    if (record.type !== "user" || !record.timestamp || record.isMeta || record.isCompactSummary) continue;
    if (copied && record.timestamp < session.startedAt) continue;
    const parts = partsOf(record);
    const base = { at: record.timestamp, sessionId: session.sessionId, cwd: session.cwd, before: tail(before, maxBefore) };
    if (parts.some(part => part.type === "tool_result")) {
      const answered = answeredSchema.safeParse(record.toolUseResult);
      if (answered.success && Object.keys(answered.data.answers).length) {
        const text = Object.entries(answered.data.answers).map(([question, answer]) => `${question} → ${answer}`).join("\n");
        turns.push({ ...base, kind: "answer", text: head(text, maxText) });
        before = "";
      }
      continue;
    }
    if (record.promptSource === "system" || machineOrigins.has(record.turnOrigin ?? "")) continue;
    const text = withoutReminders(parts.map(part => part.type === "text" ? part.text ?? "" : part.type === "image" ? "(ảnh)" : "").join("\n"));
    if (assistantPrompts.some(prompt => prompt.test(text))) assistantTab = true;
    if (!text || machineText(text)) continue;
    turns.push({ ...base, kind: "prompt", text: head(text, maxText) });
    before = "";
  }
  return assistantTab ? [] : turns;
}

// Where the daily improvement got to in the person's work: every turn from `oldest` to `newest` was in a corpus once.
export const workCursorSchema = z.object({ newest: z.string(), oldest: z.string() });
export type WorkCursor = z.infer<typeof workCursorSchema>;

const turnBlock = (me: string, turn: WorkTurn) => [
  `## ${turn.at.slice(0, 16)} · session ${turn.sessionId}${turn.cwd ? ` · ${turn.cwd}` : ""}${turn.kind === "answer" ? " · answered a question" : ""}`,
  ...turn.before ? [`> AI: ${turn.before.replace(/\n/g, "\n> ")}`] : [],
  `${me}: ${turn.text}`,
].join("\n");

// Picks what the next corpus holds, within `maxBytes`: first what is new since the last one, oldest first so nothing is
// skipped, then, with what room is left, older items it never saw, newest first. Day after day it reaches the first
// session. Returns the items kept, newest first, where the cursor moves to, and how many were new.
export function takeNewThenOlder<T extends { at: string }>(items: T[], cursor: WorkCursor | null, maxBytes: number, size: (item: T) => number) {
  const newer = items.filter(item => !cursor || item.at > cursor.newest).sort((a, b) => a.at < b.at ? -1 : 1);
  const older = cursor ? items.filter(item => item.at < cursor.oldest).sort((a, b) => a.at < b.at ? 1 : -1) : [];
  const kept: T[] = [];
  let bytes = 0;
  let next = cursor;
  const take = (item: T) => {
    const bytesOf = size(item);
    if (bytes + bytesOf > maxBytes) return false;
    bytes += bytesOf;
    kept.push(item);
    next = next
      ? { newest: item.at > next.newest ? item.at : next.newest, oldest: item.at < next.oldest ? item.at : next.oldest }
      : { newest: item.at, oldest: item.at };
    return true;
  };
  // Without a cursor everything is older: the first corpus starts from the newest.
  if (!cursor) [...items].sort((a, b) => a.at < b.at ? 1 : -1).every(take);
  else newer.every(take) && older.every(take);
  return { kept: kept.sort((a, b) => a.at < b.at ? 1 : -1), cursor: next, newCount: newer.length };
}

export function workCorpus(me: string, turns: WorkTurn[], cursor: WorkCursor | null, maxBytes: number) {
  const seen = new Set<string>();
  const unique = turns.filter(turn => {
    const key = `${turn.at}\u0000${turn.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const picked = takeNewThenOlder(unique, cursor, maxBytes, turn => Buffer.byteLength(turnBlock(me, turn)) + 2);
  return {
    corpus: [`# What ${me} decided while working (Claude Code sessions), newest first`, ...picked.kept.map(turn => turnBlock(me, turn))].join("\n\n"),
    cursor: picked.cursor,
    count: picked.kept.length,
    newCount: picked.newCount,
  };
}
