// Claude Code SessionStart hook: records a session a Paseo agent started, so the chat plugin can tell whose it is and
// the daily improvement can learn from it (docs/standalone.md). One daemon serves several people, and a hook does not
// know which of them an agent acts for, so it records the agent (`PASEO_AGENT_ID`) and the plugin decides the owner
// (server/session-owners.ts). Run with `node` 23.6 or newer, which runs TypeScript without a build.
//
// Writes `~/.paseo/chat/sessions-pending/<sessionId>.json` once and never replaces it: a resumed or forked session
// starts under a new id and fires the hook again. A session outside a Paseo agent has no owner to find and is skipped.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const pendingDir = join(homedir(), ".paseo", "chat", "sessions-pending");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SessionStart { session_id?: string; transcript_path?: string; cwd?: string; source?: string }

function record(payload: SessionStart, agentId: string) {
  const sessionId = payload.session_id ?? "";
  if (!uuid.test(sessionId) || !payload.transcript_path) return;
  mkdirSync(pendingDir, { recursive: true });
  const partial = join(pendingDir, `.${sessionId}.${randomBytes(6).toString("hex")}.partial`);
  writeFileSync(partial, JSON.stringify({
    sessionId,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd ?? "",
    source: payload.source ?? "startup",
    startedAt: new Date().toISOString(),
    agentIds: [agentId],
  }));
  // Publish only if still absent: claim the name first, since renaming over an existing record would replace it.
  const path = join(pendingDir, `${sessionId}.json`);
  try {
    writeFileSync(path, "", { flag: "wx" });
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

const agentId = process.env.PASEO_AGENT_ID;
if (agentId) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try {
      record(JSON.parse(input) as SessionStart, agentId);
    } catch (error) {
      // A session runs on without its record; say so without the payload.
      console.error(`[chat] SessionStart record not written: ${(error as Error).message}`);
    }
  });
}
