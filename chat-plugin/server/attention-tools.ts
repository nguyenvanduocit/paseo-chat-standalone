import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  addAttention, attentionAddSchema, attentionUpdateSchema, openAttention, updateAttention, waitOnOthers, waitingOnOthers,
  type AttentionItem,
} from "../shared/attention";
import { parseConversationId } from "../shared/chat";
import type { AttentionStore } from "./attention";
import { progressToolNames } from "./progress";

// The tools the AI Assistant's router and workers keep the person's attention list with (shared/attention.ts). What
// they should record is in their system prompts (server/assistant-router.ts, server/assistant-tabs.ts).

export const attentionToolNames = { list: "attention_list", add: "attention_add", update: "attention_update" } as const;

// What the router and the workers record, in one place for both.
export function attentionGuidance(me: string): string {
  return [
    `Keep ${me}'s attention list with ${attentionToolNames.add}: what ${me} must not miss from the conversations you read, and nothing else.`,
    `- todo: something asked of ${me}, or promised in ${me}'s name, with \`due\` when a deadline is said.`,
    "- event: a meeting, release, deadline or incident at a time; `due` is when it happens.",
    "- note: a decision, number, credential location or warning worth finding again.",
    `Write the title as one line ${me} can act on, in the language of the conversation; pass the conversation id and the`,
    `message key. Check ${attentionToolNames.list} first and use ${attentionToolNames.update} instead of adding again;`,
    "mark an item done when the chat shows it is settled. Most messages need no item.",
    `Done is a state, not words: never write that something is done ("ĐÃ XONG", "done") into a title or detail; mark it`,
    `done with ${attentionToolNames.update}. A blocker marked done stays listed as waiting on others until its worker settles the work.`,
  ].join("\n");
}

const line = (item: AttentionItem) =>
  `${item.id} [${item.kind}${waitingOnOthers(item) ? ", waiting on others" : ""}] ${item.title}${item.due ? ` · due ${item.due}` : ""} · ${item.conversation}${item.detail ? ` · ${item.detail}` : ""}`;
const failure = (value: string) => ({ text: value, isError: true });

export function attentionTools(store: AttentionStore, now = () => new Date().toISOString()): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: attentionToolNames.list,
      title: "List your person's open attention items",
      description: "List the open items of your person's attention list (todos, events, notes, and blockers: workers' stuck work): id, kind, title, due time, conversation and detail.",
      input: z.object({}),
      async execute() {
        const open = openAttention(await store.read());
        return { text: open.length ? open.map(line).join("\n") : "No open items." };
      },
    }),
    defineAgentTool({
      name: attentionToolNames.add,
      title: "Add to your person's attention list",
      description: "Record something your person must not miss: a todo, an event at a time, or a note. The same open item twice is kept once.",
      input: attentionAddSchema.extend({
        conversation: z.string().min(1).describe("The conversation id it came from, e.g. \"dm:alice,bob\"."),
        messageKey: z.string().optional().describe("Key of the message it came from."),
        due: attentionAddSchema.shape.due.describe("ISO 8601 time with offset, e.g. 2026-11-06T15:00:00+07:00: an event's start, a todo's deadline."),
      }),
      async execute(input, { agent, paseo }) {
        if (!parseConversationId(input.conversation)) return failure(`Unknown conversation id "${input.conversation}".`);
        // The session the agent is in now, kept beside its id so a fork of it can find its transcript.
        const sessionId = (await paseo.agents.ref(agent.id).refresh())?.agent.persistence?.sessionId ?? null;
        const at = { id: randomBytes(6).toString("hex"), now: now(), by: agent.title?.slice(0, 80) || "AI Assistant", agentId: agent.id, sessionId };
        const { item, added } = await store.change(items => {
          const result = addAttention(items, input, at);
          return { items: result.added ? result.items : null, result };
        });
        return { text: added ? `Added ${item.id}.` : `Already listed as ${item.id}; use ${attentionToolNames.update} to change it.` };
      },
    }),
    defineAgentTool({
      name: attentionToolNames.update,
      title: "Change an item of your person's attention list",
      description: "Change an item's title, detail or due time, or mark it done (or open again) when the chat shows it is settled. On a blocker only done applies: done means your person's part is done, and the blocker stays listed as waiting on others; false means it needs them again.",
      input: attentionUpdateSchema,
      async execute(input) {
        // A blocker is closed by the person, or by the plugin once its worker's work is settled; the router is told when
        // the person closed it, so no agent closes it in their name (server/assistant.ts). An agent can only say the
        // person's part is done, which keeps it in sight.
        const result = await store.change(items => {
          if (items.some(item => item.id === input.id && item.kind === "blocker")) {
            const { id, done, ...rest } = input;
            if (done === undefined || Object.values(rest).some(value => value !== undefined)) return { items: null, result: "blocker" as const };
            return { items: waitOnOthers(items, id, done, now()), result: done ? "waiting" as const : "needed" as const };
          }
          const next = updateAttention(items, input, now());
          return { items: next, result: next ? "updated" as const : "missing" as const };
        });
        if (result === "blocker") {
          return failure(`${input.id} is a blocker: only done applies to it. Its title and detail change with ${progressToolNames.escalate}, and it closes by itself once its worker reports the work settled with ${progressToolNames.checklist}.`);
        }
        if (result === "waiting") return { text: `${input.id} stays listed as waiting on others; it closes once its worker reports the work settled.` };
        if (result === "needed") return { text: `${input.id} needs your person again.` };
        return result === "updated" ? { text: `Updated ${input.id}.` } : failure(`No item "${input.id}"; see ${attentionToolNames.list}.`);
      },
    }),
  ];
}
