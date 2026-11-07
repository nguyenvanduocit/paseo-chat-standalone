import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionRecordSchema } from "./work-turns";

// Whose each Claude Code session is (docs/standalone.md). The SessionStart hook (hooks/session-start.mts) records the
// Paseo agent a session runs under in `<pending>/<sessionId>.json`; this moves the record to
// `<usage>/<owner>/<sessionId>.json`, where the daily improvement reads the owner's sessions (server/work-history.ts).
// The owner is the agent's, decided as for chat (server/daemon.ts `ownerOf`).

// What is known of an agent's owner: the agent is gone, or it is there and acts for `owner` (null: no one yet).
export type AgentOwner = { found: false } | { found: true; owner: string | null };

export interface SessionOwnersInput {
  pendingDir: string;
  usageDir: string;
  ownerOfAgent: (agentId: string) => Promise<AgentOwner>;
  log: (message: string) => void;
}

// One pass over the pending records. A record whose agent has no owner yet stays until its workspace is claimed; one
// whose agent is gone is dropped, since nothing can tell its owner any more.
export async function attributeSessions({ pendingDir, usageDir, ownerOfAgent, log }: SessionOwnersInput): Promise<void> {
  let names: string[];
  try {
    names = await readdir(pendingDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter(name => name.endsWith(".json") && !name.startsWith("."))) {
    const path = join(pendingDir, name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue; // The hook is still writing it.
    }
    const parsed = sessionRecordSchema.safeParse(raw);
    const agentId = parsed.success ? parsed.data.agentIds[0] : undefined;
    if (!parsed.success || agentId === undefined) {
      log(`[chat] Dropped session record ${name}: not one the SessionStart hook writes.`);
      await rm(path, { force: true });
      continue;
    }
    const agent = await ownerOfAgent(agentId);
    if (agent.found && agent.owner === null) continue;
    if (agent.found && agent.owner !== null) {
      const dir = join(usageDir, agent.owner);
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(join(dir, name), JSON.stringify(parsed.data), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await rm(path, { force: true });
  }
}
