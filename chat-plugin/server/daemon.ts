import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { assistantOfLabel } from "../shared/assistant";
import { handleSchema } from "../shared/chat";
import { tabOwnerLabel } from "../shared/chat-tabs";

// One daemon serves several people (docs/standalone.md). Each client picks its person, and every call it makes names
// them; this file keeps who has picked themselves here, so their AI Assistant runs while no client of theirs is open,
// and whose each workspace is, so an agent in it acts for that person in chat.


const stateSchema = z.object({
  people: z.array(handleSchema).default([]),
  // Workspace id to the handle of the person who claimed it.
  workspaces: z.record(z.string(), handleSchema).default({}),
});
export type DaemonState = z.infer<typeof stateSchema>;

const empty = (): DaemonState => ({ people: [], workspaces: {} });

export function withPerson(state: DaemonState, handle: string): DaemonState {
  return state.people.includes(handle) ? state : { ...state, people: [...state.people, handle].sort() };
}

// A person claims a workspace no one owns, or lets go of their own. Someone else's workspace stays theirs: the
// owner lets go first, so one person never takes over the agents of another by accident.
export function withClaim(state: DaemonState, workspaceId: string, handle: string, claim: boolean): DaemonState {
  const owner = state.workspaces[workspaceId];
  if (owner && owner !== handle) throw new Error(`Workspace này là của ${owner}. ${owner} cần bỏ nhận trước.`);
  if (claim === (owner === handle)) return state;
  const workspaces = { ...state.workspaces };
  if (claim) workspaces[workspaceId] = handle;
  else delete workspaces[workspaceId];
  return { ...state, workspaces };
}

// Where Paseo keeps the agent an agent was started by (`PARENT_AGENT_ID_LABEL`, @getpaseo/protocol agent-labels).
const parentAgentLabel = "paseo.parent-agent-id";

// An agent's snapshot as deciding its owner reads it.
export function ownedAgent(agent: { id: string; workspaceId?: string | null; labels?: Record<string, string> | null }): OwnedAgent {
  const labels = agent.labels ?? {};
  return { id: agent.id, workspaceId: agent.workspaceId ?? null, parentAgentId: labels[parentAgentLabel] ?? null, labels };
}

// What deciding an agent's owner needs to know of it.
export interface OwnedAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  labels: Readonly<Record<string, string>>;
}

// Whom an agent acts for: the handle its labels carry, else the owner of its workspace, else its parent's owner. Null
// when none of these says, which the caller reports instead of guessing.
export async function ownerOf(
  agent: OwnedAgent,
  workspaces: Readonly<Record<string, string>>,
  parentOf: (id: string) => Promise<OwnedAgent | null>,
): Promise<string | null> {
  const seen = new Set<string>();
  for (let at: OwnedAgent | null = agent; at && !seen.has(at.id); at = at.parentAgentId ? await parentOf(at.parentAgentId) : null) {
    seen.add(at.id);
    const labelled = at.labels[tabOwnerLabel] ?? at.labels[assistantOfLabel];
    if (labelled) return labelled;
    const owner = at.workspaceId ? workspaces[at.workspaceId] : undefined;
    if (owner) return owner;
  }
  return null;
}

export const noOwner = "Agent này ở workspace chưa có chủ, nên chat không biết nó gửi thay ai. " +
  "Mở Chat panel của workspace và chọn \"Nhận workspace này\".";

export function daemonStore(path: string) {
  let writing: Promise<unknown> = Promise.resolve();
  async function read(): Promise<DaemonState> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
    // A file that is not this shape is a mistake to fix by hand, not something to overwrite with nobody.
    return stateSchema.parse(JSON.parse(raw));
  }
  return {
    path,
    read,
    // Changes run one at a time, so two clients claiming at once cannot lose either write.
    change(next: (state: DaemonState) => DaemonState): Promise<DaemonState> {
      const done = writing.then(async () => {
        const before = await read();
        const after = next(before);
        if (after === before) return before;
        await mkdir(dirname(path), { recursive: true });
        const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
        await writeFile(partial, JSON.stringify(after, null, 2));
        await rename(partial, path);
        return after;
      });
      writing = done.catch(() => {});
      return done;
    },
  };
}

export type DaemonStore = ReturnType<typeof daemonStore>;
