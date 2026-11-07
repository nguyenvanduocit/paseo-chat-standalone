import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { addAttention, attentionFileSchema, pruneAttention, type AttentionItem } from "../shared/attention";
import { conversationId, type Conversation } from "../shared/chat";

// The person's attention list (shared/attention.ts) in one file on their own home, beside the assistant's other state.
// Agents and the Chat screen change it through `change`, one at a time, so two writers never lose each other's item.

export function attentionStore(path: string, now = () => Date.now()) {
  async function read(): Promise<AttentionItem[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // A file that is not the schema's is a bug to see, not a list to drop: the next save would erase it.
    return attentionFileSchema.parse(JSON.parse(raw)).items;
  }

  async function save(items: AttentionItem[]) {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
    await writeFile(partial, JSON.stringify({ items: pruneAttention(items, now()) }, null, 2));
    await rename(partial, path);
  }

  let turn: Promise<unknown> = Promise.resolve();
  // `apply` returns the list to save, or null to save nothing, and what to hand back to the caller.
  function change<Result>(apply: (items: AttentionItem[]) => { items: AttentionItem[] | null; result: Result }): Promise<Result> {
    const next = turn.then(async () => {
      const { items, result } = apply(await read());
      if (items) await save(items);
      return result;
    });
    turn = next.catch(() => {});
    return next;
  }

  return { path, read, change };
}

export type AttentionStore = ReturnType<typeof attentionStore>;

// An AI of the person made a decision of a kind only people make (`decision`, an id of the team's delegation catalog)
// without pointing at the message where a person decided it (chat broker `delegation::breach`). One open
// blocker per message; picking it opens the conversation, where the person confirms or takes the decision back.
export function noteDelegation(store: AttentionStore, conversation: Conversation, key: string, decision: string, now: number) {
  return store.change(items => {
    const added = addAttention(items, {
      kind: "blocker",
      title: `AI đã tự quyết một việc chỉ người được quyết (${decision}) mà không có lời của chính người quyết; hãy xác nhận hoặc rút lại`,
      conversation: conversationId(conversation),
      messageKey: key,
    }, { id: randomBytes(6).toString("hex"), now: new Date(now).toISOString(), by: "Chat", agentId: null, sessionId: null });
    return { items: added.added ? added.items : null, result: added.item };
  });
}

