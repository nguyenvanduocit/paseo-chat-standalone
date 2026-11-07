import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assistantActs, type AssistantAct, type AssistantTab } from "./assistant-acts";
import { sessionRecordSchema, workTurns, type SessionRecord, type WorkCursor, type WorkTurn } from "./work-turns";

// Reads the person's Claude Code sessions for the daily improvement: the ones they worked in (server/work-turns.ts keeps
// what they typed) and their AI Assistant's tabs (server/assistant-acts.ts keeps what it did in their name). The
// plugin records each session under its owner in `<usage>/<handle>/<id>.json` (server/session-owners.ts); transcripts
// of everyone on the daemon sit side by side, so only sessions in the person's own directory are read, never another
// handle's. A person has thousands of sessions and
// gigabytes of transcript, so a run reads what changed since the last corpus and then only as much older history as
// the corpus has room for.

async function sessionsOf(dir: string): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
    try {
      const parsed = sessionRecordSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // A record being written.
    }
  }));
  return records.filter(record => record !== null);
}

// The person's and the AI's lines of one transcript; other lines are not parsed.
async function linesOf(session: SessionRecord): Promise<string[]> {
  const lines: string[] = [];
  try {
    const reader = createInterface({ input: createReadStream(session.transcriptPath, "utf8"), crlfDelay: Infinity });
    for await (const line of reader) {
      if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) lines.push(line);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // Deleted since it was listed.
    throw error;
  }
  return lines;
}

const modifiedAt = (path: string) => stat(path).then(info => info.mtimeMs, () => null);

interface HistoryInput<T> {
  usageDir: string;
  handle: string;
  cursor: WorkCursor | null;
  maxBytes: number;
  // Which of the person's sessions to read, what to keep of one, and how many bytes an item takes in the corpus.
  keep: (record: SessionRecord) => boolean;
  parse: (lines: string[], record: SessionRecord) => T[];
  size: (item: T) => number;
}

// The time of the oldest item that still fits in `budget` when the newest are taken first; "" while all fit.
function cutoffOf<T extends { at: string }>(items: T[], budget: number, size: (item: T) => number): string {
  let bytes = 0;
  for (const item of [...items].sort((a, b) => a.at < b.at ? 1 : -1)) {
    bytes += size(item);
    if (bytes > budget) return item.at;
  }
  return "";
}

async function readHistory<T extends { at: string }>(input: HistoryInput<T>): Promise<T[]> {
  const records = (await sessionsOf(join(input.usageDir, input.handle))).filter(input.keep);
  const withTimes = (await Promise.all(records.map(async record => ({ record, mtime: await modifiedAt(record.transcriptPath) }))))
    .filter(({ mtime }) => mtime !== null); // Paseo deletes some transcripts; a mapping does not prove one exists.
  const { cursor } = input;
  const before = cursor?.oldest ?? "\uffff";
  const newer: T[] = [];
  const older: T[] = [];
  const read = new Set<string>();
  const parsed = async (record: SessionRecord) => input.parse(await linesOf(record), record);
  // Everything written since the last corpus, and what those sessions hold from before it, since a session that
  // started long ago (the assistant's router runs all day) keeps being written to.
  if (cursor) {
    for (const { record } of withTimes.filter(({ mtime }) => mtime! > Date.parse(cursor.newest))) {
      const found = await parsed(record);
      newer.push(...found.filter(item => item.at > cursor.newest));
      older.push(...found.filter(item => item.at < before));
      read.add(record.sessionId);
    }
  }
  // Then older history from the other sessions, the ones written to last first, while one can still hold an item
  // newer than the oldest the corpus has room for.
  const budget = input.maxBytes - newer.reduce((sum, item) => sum + input.size(item), 0);
  const rest = withTimes
    .filter(({ record }) => !read.has(record.sessionId) && record.startedAt < before)
    .sort((a, b) => b.mtime! - a.mtime!);
  let cutoff = cutoffOf(older, budget, input.size);
  for (const { record, mtime } of rest) {
    if (budget <= 0 || (cutoff && new Date(mtime!).toISOString() < cutoff)) break;
    older.push(...(await parsed(record)).filter(item => item.at < before));
    cutoff = cutoffOf(older, budget, input.size);
  }
  return [...newer, ...older];
}

export interface WorkHistoryInput {
  usageDir: string;
  handle: string;
  // The assistant's own tabs (router, workers, talk to myself): the plugin writes their prompts, not the person.
  skipAgents: ReadonlySet<string>;
  cursor: WorkCursor | null;
  maxBytes: number;
}

export function readWorkHistory(input: WorkHistoryInput): Promise<WorkTurn[]> {
  return readHistory({
    ...input,
    keep: record => !record.agentIds.some(id => input.skipAgents.has(id)),
    parse: workTurns,
    size: turn => turn.text.length + turn.before.length + 120,
  });
}

export interface AssistantHistoryInput {
  usageDir: string;
  handle: string;
  // The assistant's router and worker tabs, archived or not, by agent id.
  tabs: ReadonlyMap<string, AssistantTab>;
  // The tools that act in the person's name.
  tools: ReadonlySet<string>;
  cursor: WorkCursor | null;
  maxBytes: number;
}

export function readAssistantHistory(input: AssistantHistoryInput): Promise<AssistantAct[]> {
  const tabOf = (record: SessionRecord) => record.agentIds.map(id => input.tabs.get(id)).find(tab => tab !== undefined);
  return readHistory({
    ...input,
    keep: record => tabOf(record) !== undefined,
    parse: (lines, record) => assistantActs(lines, record, tabOf(record)!, input.tools),
    size: act => act.input.length + act.asked.length + act.reason.length + 160,
  });
}
