import type { SessionRecord, WorkCursor } from "./work-turns";
import { takeNewThenOlder } from "./work-turns";

// What the AI Assistant did in the person's name, from its own tabs' transcripts (the router and every worker): each
// message it sent, each piece of work it handed out or followed up, each item it put on or changed in the person's
// attention list, with the prompt it was working on and what it said just before. The daily improvement reviews these
// decisions against the persona and what the person said (server/self.ts). Pure: server/work-history.ts reads the files.

export interface AssistantTab { role: "router" | "worker"; title: string }

export interface AssistantAct {
  at: string;
  sessionId: string;
  tab: AssistantTab;
  // The tool, without the MCP server prefix Claude Code puts before it.
  tool: string;
  // What the tool was called with, as JSON.
  input: string;
  // The prompts the tab was working on: who asked, and what, then anything sent to it before it acted.
  asked: string;
  // What the tab said just before, cut to its end: why it acted.
  reason: string;
}

const maxInput = 1500;
const maxAsked = 600;
const maxReason = 500;

const head = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const tail = (text: string, max: number) => text.length > max ? `…${text.slice(-max)}` : text;
const withoutReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
// Claude Code names a plugin's tool `mcp__<server>__<tool>`.
const shortName = (name: string) => {
  const at = name.lastIndexOf("__");
  return at < 0 ? name : name.slice(at + 2);
};

interface Part { type?: string; text?: string; name?: string; input?: unknown }
interface TranscriptRecord { type?: string; timestamp?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: string | Part[] } }

const partsOf = (record: TranscriptRecord): Part[] => {
  const content = record.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
};

// The acts in one tab's transcript, oldest first. `tools` are the ones that act in the person's name. A session that
// was resumed or forked carries the history of the one it came from, which that one's own record already covers.
export function assistantActs(lines: Iterable<string>, session: SessionRecord, tab: AssistantTab, tools: ReadonlySet<string>): AssistantAct[] {
  const copied = session.source === "resume" || session.source === "fork";
  const acts: AssistantAct[] = [];
  // The prompts since the tab last acted: a prompt that comes before it acts (an interruption, a resume, a person
  // writing in the tab) adds to what it works on rather than replacing it.
  let asked: string[] = [];
  let actedSince = true;
  let reason = "";
  for (const line of lines) {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A transcript being written can end in a partial line.
    }
    if (record.isSidechain || record.isMeta || !record.timestamp) continue;
    const parts = partsOf(record);
    if (record.type === "user") {
      // A tool result is the answer to a call, not a new prompt.
      if (parts.some(part => part.type === "tool_result")) continue;
      const text = withoutReminders(parts.map(part => part.type === "text" ? part.text ?? "" : "").join("\n"));
      if (!text) continue;
      asked = actedSince ? [head(text, maxAsked)] : [...asked, head(text, maxAsked)];
      actedSince = false;
      reason = "";
      continue;
    }
    if (record.type !== "assistant") continue;
    for (const part of parts) {
      if (part.type === "text" && part.text?.trim()) reason = tail(part.text.trim(), maxReason);
      if (part.type !== "tool_use" || !part.name || !tools.has(shortName(part.name))) continue;
      if (copied && record.timestamp < session.startedAt) continue;
      acts.push({
        at: record.timestamp, sessionId: session.sessionId, tab, tool: shortName(part.name),
        input: head(JSON.stringify(part.input ?? {}), maxInput), asked: asked.join("\n— then: "), reason,
      });
      actedSince = true;
    }
  }
  return acts;
}

// An act, with the prompts it worked on in full, or, when an earlier act of the same session worked on the same
// prompts, a pointer to that act: one prompt often leads to several acts, and is quoted once.
const actBlock = (act: AssistantAct, sameAs: string | null) => [
  `## ${act.at.slice(0, 16)} · ${act.tab.role} "${act.tab.title}" · session ${act.sessionId} · ${act.tool}`,
  ...!act.asked ? [] : sameAs ? [`> Working on: the same prompts as its act at ${sameAs}`] : [`> Working on: ${act.asked.replace(/\n/g, "\n> ")}`],
  ...act.reason ? [`> Said before: ${act.reason.replace(/\n/g, "\n> ")}`] : [],
  `Did: ${act.input}`,
].join("\n");

const promptsKey = (act: AssistantAct) => `${act.sessionId}\u0000${act.asked}`;

// The next review corpus within `maxBytes`, as the work corpus picks it (`takeNewThenOlder`): what is new since the last
// review, then older acts it never saw. Returns the blocks newest first and where the cursor moves to.
export function actsCorpus(me: string, acts: AssistantAct[], cursor: WorkCursor | null, maxBytes: number) {
  const seen = new Set<string>();
  const unique = acts.filter(act => {
    const key = `${act.at}\u0000${act.tool}\u0000${act.input}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Each act carries its share of the prompts it quotes with the acts that share them.
  const shares = new Map<string, number>();
  for (const act of unique) shares.set(promptsKey(act), (shares.get(promptsKey(act)) ?? 0) + 1);
  const size = (act: AssistantAct) =>
    Buffer.byteLength(actBlock({ ...act, asked: "" }, null)) + Buffer.byteLength(act.asked) / shares.get(promptsKey(act))! + 60;
  const picked = takeNewThenOlder(unique, cursor, maxBytes, size);
  // The earliest act kept of each prompt quotes it.
  const quotedAt = new Map<string, string>();
  for (const act of [...picked.kept].reverse()) if (!quotedAt.has(promptsKey(act))) quotedAt.set(promptsKey(act), act.at);
  const blocks = picked.kept.map(act => {
    const first = quotedAt.get(promptsKey(act))!;
    return actBlock(act, first === act.at ? null : first.slice(11, 19));
  });
  return {
    corpus: [`# What ${me}'s AI Assistant did in ${me}'s name (router and worker tabs), newest first`, ...blocks].join("\n\n"),
    cursor: picked.cursor,
    count: picked.kept.length,
  };
}
