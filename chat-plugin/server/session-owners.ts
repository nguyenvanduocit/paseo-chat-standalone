import { readdir, readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionRecordSchema, type SessionRecord } from "./work-turns";

// Whose each Claude Code session is (docs/standalone.md). Paseo keeps the Claude session an agent runs on
// (`persistence.sessionId`), and the agent's owner is decided as for chat (server/daemon.ts `ownerOf`), so this records
// `<usage>/<owner>/<sessionId>.json` for each, where the daily improvement reads the owner's sessions
// (server/work-history.ts). A record is written once and never replaced.

// A Claude agent of this daemon with the session it runs on now and the person it acts for.
export interface AgentSession {
  agentId: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  owner: string;
}

// The record of a session first seen in a turn that started `now`. An agent's first session counts from the agent's
// creation; a later one (resumed, forked, cleared) starts with a copy of the history before it, so it counts from that
// turn's start (server/work-turns.ts drops a copied session's lines older than `startedAt`).
export function sessionRecordOf(session: AgentSession, transcriptPath: string, agentHasEarlier: boolean, now: string): SessionRecord {
  return {
    sessionId: session.sessionId,
    transcriptPath,
    cwd: session.cwd,
    source: agentHasEarlier ? "resume" : "fork",
    startedAt: agentHasEarlier ? now : session.createdAt,
    agentIds: [session.agentId],
  };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function sessionLedger({ usageDir, transcriptsDir }: { usageDir: string; transcriptsDir: string }) {
  // Agent id to the sessions recorded for it, read from the records once and kept up to date after.
  let known: Promise<Map<string, Set<string>>> | null = null;
  let writing: Promise<unknown> = Promise.resolve();
  async function load() {
    const byAgent = new Map<string, Set<string>>();
    for (const handle of await entries(usageDir)) {
      for (const name of (await entries(join(usageDir, handle))).filter(name => name.endsWith(".json"))) {
        let record: SessionRecord;
        try {
          const parsed = sessionRecordSchema.safeParse(JSON.parse(await readFile(join(usageDir, handle, name), "utf8")));
          if (!parsed.success) continue;
          record = parsed.data;
        } catch {
          continue;
        }
        for (const agentId of record.agentIds) byAgent.set(agentId, (byAgent.get(agentId) ?? new Set()).add(record.sessionId));
      }
    }
    return byAgent;
  }

  // Claude Code keeps a session's transcript at `<projects>/<cwd with every other character a dash>/<id>.jsonl`; a
  // transcript elsewhere under `<projects>` is found by looking. Null until Claude Code has written it.
  async function transcriptOf(session: AgentSession): Promise<string | null> {
    const name = `${session.sessionId}.jsonl`;
    const likely = join(transcriptsDir, session.cwd.replace(/[^A-Za-z0-9]/g, "-"), name);
    if (await exists(likely)) return likely;
    for (const dir of await entries(transcriptsDir)) {
      if (await exists(join(transcriptsDir, dir, name))) return join(transcriptsDir, dir, name);
    }
    return null;
  }

  async function recordNow(sessions: readonly AgentSession[], now: string): Promise<void> {
    known ??= load().catch(error => { known = null; throw error; });
    const byAgent = await known;
    for (const session of sessions) {
      const recorded = byAgent.get(session.agentId) ?? new Set<string>();
      if (recorded.has(session.sessionId)) continue;
      const transcriptPath = await transcriptOf(session);
      if (transcriptPath === null) continue;
      const dir = join(usageDir, session.owner);
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(join(dir, `${session.sessionId}.json`), JSON.stringify(sessionRecordOf(session, transcriptPath, recorded.size > 0, now)), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      byAgent.set(session.agentId, recorded.add(session.sessionId));
    }
  }

  return {
    // Records each session not recorded yet whose transcript exists. Calls run one at a time, so a turn ending while
    // every agent is being recorded cannot decide twice which session of an agent came first.
    record(sessions: readonly AgentSession[], now: string): Promise<void> {
      const done = writing.then(() => recordNow(sessions, now));
      writing = done.catch(() => {});
      return done;
    },
  };
}
