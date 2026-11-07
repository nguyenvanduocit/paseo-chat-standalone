import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { personal } from "./chat";

// The AI Assistant: in the workspace of the directory holding the persona, one router tab receives every message that writes to them
// directly or mentions them, and assigns it to a worker tab by what the work is about. Workers do the work and answer;
// each follows the person's persona, a directory of files their talk-to-myself tab writes.

// The person's router tab carries their handle under this label, a worker tab under the next one, and every tab of the
// assistant under `assistantOfLabel` too, because Paseo filters agents by exact label values and the relay lists all
// of them at once.
export const routerLabel = "chat.assistant-router";
export const workerLabel = "chat.assistant-worker";
export const assistantOfLabel = "chat.assistant-of";
// The person's talk-to-myself tab carries their handle under this label.
export const selfLabel = "chat.assistant-self";
// Every tab the assistant creates carries the version of the access it was created with: Paseo fixes a tab's options
// then. A tab keeps that access while its agent exists; the doctor counts the ones older than today's (server/self.ts).
export const assistantAccessLabel = "chat.assistant-access";
// Every router and worker tab carries the version of the standing guidance its system prompt holds, since Paseo fixes a
// tab's system prompt when it creates the tab; a tab without today's version gets today's guidance in each prompt
// instead (server/assistant-tabs.ts `guidanceFor`).
export const assistantGuidanceLabel = "chat.assistant-guidance";

// What the Chat screen and panel show: the assistant's workspace, its tabs (router and workers) and the persona.
export const readAssistant = defineRpc({
  name: "chat.assistant",
  input: personal({}),
  output: z.object({
    // The workspace of the person's persona directory, where the assistant's tabs open.
    workspaceId: z.string(),
    tabs: z.object({ open: z.number().int(), running: z.number().int() }),
    // How many files the persona has, and when one was last written (null before the first).
    persona: z.object({ files: z.number().int(), updatedAt: z.string().nullable() }),
    // Whether the talk-to-myself tab is in a turn: talking with the person or running the daily improvement.
    selfWorking: z.boolean(),
  }),
});

// Opens the person's talk-to-myself tab, archived or not, with its context; creates it only when there is none.
export const openSelf = defineRpc({
  name: "chat.assistant-self",
  input: personal({}),
  output: z.object({ agentId: z.string() }),
});

// Opens the person's router tab, archived or not, so the person can watch it route; creates an idle one only when
// there is none.
export const openRouter = defineRpc({
  name: "chat.assistant-router",
  input: personal({}),
  output: z.object({ agentId: z.string() }),
});

// The tabs the person can start over: the router and the talk-to-myself tab.
export const renewableTabs = ["router", "self"] as const;
export type RenewableTab = typeof renewableTabs[number];

// Starts the person's router or talk-to-myself tab over: a new tab takes its place and the old one is archived. The
// talk-to-myself tab reads the old one's session unattended and writes what it learned into the persona and the
// decision records. Returns the new tab.
export const renewTab = defineRpc({
  name: "chat.assistant-renew",
  input: personal({ tab: z.enum(renewableTabs) }),
  output: z.object({ agentId: z.string() }),
});
