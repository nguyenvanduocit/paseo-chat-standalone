import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { conversationTitle, plainBody, type ChatMessageView, type Conversation } from "../shared/chat";
import { decisionsDir } from "./persona";
import { workCursorSchema } from "./work-turns";

// What the daily improvement learns the person's taste and decisions from: what they wrote in chat and what they typed
// and chose while working with Claude Code, and what it reviews: what their AI Assistant did in their name. All are
// rebuilt each time, beside when it last ran. Their talk-to-myself tab
// (server/self.ts) turns it into the persona (server/persona.ts) and the decision records beside it. The corpora live
// apart from the persona: they quote raw messages and sessions and are rebuilt each time. Where both are is chosen
// per person in index.server.ts.
//
//   <dir>/corpus.md          what the person wrote in chat, newest first, rebuilt before each daily improvement
//   <dir>/work.md            what the person typed and chose in their sessions (server/work-turns.ts), rebuilt likewise
//   <dir>/review.md          what their AI Assistant did in their name (server/assistant-acts.ts), rebuilt likewise
//   <dir>/learned.json       when the last daily improvement started, the newest message it saw, and how far back in
//                            the person's work and in the assistant's acts it has read
//   <dir>/workers.json       the assistant's workers (server/workers.ts)
//   <dir>/history/           every version of the persona the plugin saw

export interface TastePaths {
  dir: string; persona: string; decisions: string; corpus: string; work: string; review: string; learned: string; history: string;
  // The copy of the team's delegation catalog (server/delegation.ts).
  delegation: string;
  // Where Claude Code's sessions are: who ran each (`usage/<handle>/<id>.json`) and the transcripts every host shares.
  sessions: { usage: string; transcripts: string };
}

export const tastePaths = (dir: string, persona: string, sessions: TastePaths["sessions"]): TastePaths => ({
  dir, persona, decisions: join(persona, decisionsDir), corpus: join(dir, "corpus.md"), work: join(dir, "work.md"), review: join(dir, "review.md"),
  learned: join(dir, "learned.json"), history: join(dir, "history"), delegation: join(dir, "delegation.md"), sessions,
});

// `work` is null until the first improvement that read the person's sessions; `review` until the first that read the
// assistant's tabs.
const learnedSchema = z.object({
  at: z.number(), through: z.string(), work: workCursorSchema.nullable().default(null), review: workCursorSchema.nullable().default(null),
});
export type Learned = z.infer<typeof learnedSchema>;

// The daily improvement is due at most once a day, once there is enough new for it to learn from or review.
export const learnEveryMs = 24 * 60 * 60_000;
export const learnAfterMessages = 5;
const maxCorpusBytes = 200_000;
const contextMessages = 3;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path: string, data: string) {
  const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
  await writeFile(partial, data);
  await rename(partial, path);
}

export function tasteStore(paths: TastePaths) {
  return {
    paths,
    async learned(): Promise<Learned | null> {
      const parsed = learnedSchema.safeParse(JSON.parse(await readText(paths.learned) ?? "null"));
      return parsed.success ? parsed.data : null;
    },
    // Writes the corpora and records the improvement as started. The persona it changes is already in history: the relay
    // keeps every version it sees.
    async prepare(corpora: { chat: string; work: string; review: string }, learned: Learned) {
      await mkdir(paths.dir, { recursive: true });
      await writeAtomic(paths.corpus, corpora.chat);
      await writeAtomic(paths.work, corpora.work);
      await writeAtomic(paths.review, corpora.review);
      await writeAtomic(paths.learned, JSON.stringify(learned));
    },
  };
}

export type TasteStore = ReturnType<typeof tasteStore>;

export interface ConversationMessages { conversation: Conversation; messages: ChatMessageView[] }

const line = (message: ChatMessageView) => `${message.author}${message.via ? " (AI Assistant)" : ""}: ${plainBody(message.body) || `(${message.attachments.length} ảnh)`}`;

// What the person wrote themselves, newest first, each with the messages just before it. A message right after
// their assistant answered is what they thought of that answer, so it is marked.
export function corpusOf(me: string, conversations: ConversationMessages[]): { corpus: string; through: string; count: number } {
  const entries = conversations.flatMap(({ conversation, messages }) => messages.flatMap((message, at) => {
    if (message.author !== me || message.via) return [];
    const before = messages.slice(Math.max(0, at - contextMessages), at);
    const afterAssistant = before.at(-1)?.author === me && before.at(-1)?.via !== undefined;
    const block = [
      `## ${message.createdAt.slice(0, 16)} · ${conversationTitle(conversation, me)} · ${message.key}${afterAssistant ? " · after the assistant answered" : ""}`,
      ...before.map(earlier => `> ${line(earlier).replace(/\n/g, "\n> ")}`),
      line(message),
    ].join("\n");
    return [{ key: message.key, block }];
  })).sort((a, b) => a.key < b.key ? 1 : -1);
  const kept: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    bytes += Buffer.byteLength(entry.block) + 2;
    if (bytes > maxCorpusBytes) break;
    kept.push(entry.block);
  }
  return { corpus: [`# What ${me} wrote in chat`, ...kept].join("\n\n"), through: entries[0]?.key ?? "", count: entries.length };
}

// Whether the daily improvement may start: never run, or a day since the last. It starts only once at least
// `learnAfterMessages` new entries (the person's messages and prompts, the assistant's acts) came since then.
export function learningDue(learned: Learned | null, now: number): boolean {
  return !learned || now - learned.at >= learnEveryMs;
}
