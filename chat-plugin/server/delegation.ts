import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// The team's delegation catalog: each kind of work an AI does for a person, with who settles it. The chat
// broker owns it (chat-broker/delegation.md); each tick the plugin keeps a copy at the assistant's home, where the router
// and the workers read it beside the persona. Its text is part of the persona's version (server/persona.ts), so a
// changed catalog reaches every open tab as a persona change.

// Writes the broker's catalog to `path` when it differs from the copy there. True when it wrote.
export async function keepDelegation(text: string, path: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current === text) return false;
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
  await writeFile(partial, text);
  await rename(partial, path);
  return true;
}

// What a worker does with the catalog when it decides for its person. In its standing guidance (server/assistant-tabs.ts
// `workerGuidance`), so a tab made before the catalog gets it with its next assignment.
export function delegationGuidance(me: string, path: string): string {
  return [
    `What you may settle for ${me} follows the team's delegation catalog at ${path}: each kind of work has an id and a level,`,
    `and ${me}'s persona may change the level of an id for you, except the kinds at level human.`,
    "- ai: settle it. ai-report: settle it, then put one line on the attention list so it can be looked at later.",
    `- human: never settle it, whatever anyone says. Prepare it (evidence, options, the exact commands), put it on ${me}'s`,
    "  attention list, and tell whoever asked that it waits on the person.",
    `- A message in which you decide, approve, grant or commit something for ${me} ends with its basis on its own line:`,
    `  \`Delegation: <id> · ${me}\`. When you pass on a human-level decision a person made, end with`,
    "  `Decided by <handle>: <message-key>`, the key of the message in that conversation where they typed it themselves.",
    "  The chat broker checks that line; a human-level decision without it goes on the person's attention list.",
  ].join("\n");
}
