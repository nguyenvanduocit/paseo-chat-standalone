import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import { agentIdPattern, conversationId } from "../shared/chat";
import { alertSchema, isMine, signalRoom, subscriberTarget, type Signal } from "../shared/signals";
import { ChatBrokerError } from "./chat";
import type { AgentChat } from "./agent-tools";

// The tools every agent has for signals: Grafana alerts whose rule carries the
// label `signal=<alert>`, which the chat broker pulls and posts, grouped per poll, in `room:signals/<alert>`. They act as
// the host's person, like the chat tools.

export const signalToolNames = {
  register: "chat_signal_register",
  subscribe: "chat_signal_subscribe",
  unsubscribe: "chat_signal_unsubscribe",
  list: "chat_signal_list",
} as const;

const text = (value: string) => ({ text: value });
const failure = (value: string) => ({ text: value, isError: true });
const alert = alertSchema.describe("The alert's name: lowercase letters, digits and dashes, e.g. \"paseo-ops\".");
const iso = (ms: number) => new Date(ms).toISOString();
const roomOf = (name: string) => conversationId(signalRoom(name));
const reading = (name: string) => `Read its alerts with chat_read or chat_search on conversation "${roomOf(name)}".`;

// A broker from before signals answers 404 on every signal route.
function brokerFailure(error: unknown, name?: string) {
  if (error instanceof ChatBrokerError && error.code === "signal_exists") {
    return failure(`Signal "${name}" already exists; ${signalToolNames.list} shows who created it; subscribe with ${signalToolNames.subscribe}.`);
  }
  if (error instanceof ChatBrokerError && error.status === 404) return failure(`The chat broker has no signal${name ? ` "${name}"` : "s"} (${error.message}).`);
  return failure(error instanceof Error ? error.message : String(error));
}

// One signal as agents read it: its room, creator, firing count, last change and who hears it.
export function signalLines(signal: Signal, me: string): string[] {
  const last = signal.lastChangeAt === null ? "no alert yet" : `last change ${iso(signal.lastChangeAt)}`;
  const subscribers = signal.subscriptions.map(subscription =>
    `${subscription.handle}${subscription.handle === me ? " (you)" : ""} → ${subscriberTarget(subscription)}, since ${iso(subscription.at)}` +
    (subscription.handedOverAt === null ? "" : ` (handed over ${iso(subscription.handedOverAt)})`));
  return [
    `${signal.alert} (${signal.conversation}) — created by ${signal.createdBy}${signal.createdBy === me ? " (you)" : ""} ${iso(signal.createdAt)}; ` +
      `${signal.firing} firing; ${last}`,
    `  subscribers: ${subscribers.length ? subscribers.join("; ") : "none"}`,
  ];
}

// How alerts reach a new signal: the label on a rule of the Grafana the broker pulls (`GRAFANA_URL`), then its poll.
export function grafanaSetup(signal: Signal, me: string): string {
  const name = signal.alert;
  return [
    `Signal "${name}" is registered.`,
    ...signalLines(signal, me),
    `Next, add the label \`signal=${name}\` to the alert rule on the Grafana the chat broker pulls (its GRAFANA_URL). ` +
      "A broker started without GRAFANA_URL and GRAFANA_TOKEN pulls nothing.",
    `The chat broker pulls Grafana every 30 seconds by default: the alerts of "${name}" arrive in conversation "${roomOf(name)}" within about ` +
      "30 seconds of firing, every new alert of one poll in one message. An alert is resolved once two polls in a row miss it, in a reply " +
      "to its firing message. An alert silenced in Grafana stays out of chat.",
    `Subscribe with ${signalToolNames.subscribe} to hear the alerts. ${reading(name)}`,
  ].join("\n");
}

// `assistant` (or null) is the person's AI Assistant; an agent id is that agent; absent is the agent calling.
const subscribeTarget = z.union([z.literal("assistant"), z.string().regex(agentIdPattern), z.null()]).optional()
  .describe("Who hears the alerts: omit for yourself (this agent), \"assistant\" for your person's AI Assistant, or another agent id of this host.");

export function signalTools(chat: AgentChat): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: signalToolNames.register,
      title: "Register a signal (Grafana alerts)",
      description: "Register a signal: the team chat broker pulls the Grafana alerts whose rule carries the label " +
        "`signal=<alert>` every 30 seconds and posts them, grouped per poll, in room \"signals/<alert>\". Returns the signal and how to " +
        "label the alert rule. Anyone can see every signal; you become its creator, the only one who can delete it.",
      input: z.object({ alert }),
      async execute(input, context) {
        try {
          const files = await chat(context);
          const { signal } = await files.registerSignal(input.alert);
          return text(grafanaSetup(signal, files.me));
        } catch (error) {
          return brokerFailure(error, input.alert);
        }
      },
    }),

    defineAgentTool({
      name: signalToolNames.subscribe,
      title: "Subscribe to a signal",
      description: "Subscribe to a signal's alerts. By default you (this agent) hear every new alert of room \"signals/<alert>\" as a prompt, " +
        "for as long as the subscription lasts; once you are gone they go to your person's AI Assistant. Your person has one " +
        "subscription per alert, so this replaces theirs. Read past alerts with chat_read or chat_search on the alert's room.",
      input: z.object({ alert, agent: subscribeTarget }),
      async execute(input, context) {
        try {
          const files = await chat(context);
          const agent = input.agent === undefined ? context.agent.id : input.agent === "assistant" ? null : input.agent;
          const { signal } = await files.subscribeSignal(input.alert, agent);
          const who = agent === null ? `${files.me}'s AI Assistant` : agent === context.agent.id ? "you (this agent)" : `agent ${agent}`;
          return text([
            `Subscribed: new alerts of "${input.alert}" go to ${who}${agent === null ? "" : `, and to ${files.me}'s AI Assistant once that agent is gone`}.`,
            ...signalLines(signal, files.me),
            reading(input.alert),
          ].join("\n"));
        } catch (error) {
          return brokerFailure(error, input.alert);
        }
      },
    }),

    defineAgentTool({
      name: signalToolNames.unsubscribe,
      title: "Unsubscribe from a signal",
      description: "End your person's subscription to a signal, whoever it goes to (an agent or their AI Assistant). Nobody can end someone else's.",
      input: z.object({ alert }),
      async execute(input, context) {
        try {
          const files = await chat(context);
          const { signal } = await files.unsubscribeSignal(input.alert);
          return text([`Unsubscribed ${files.me} from "${input.alert}".`, ...signalLines(signal, files.me)].join("\n"));
        } catch (error) {
          return brokerFailure(error, input.alert);
        }
      },
    }),

    defineAgentTool({
      name: signalToolNames.list,
      title: "List signals",
      description: "List the signals (Grafana alerts labelled `signal=<alert>`): each one's room, creator, how many " +
        "alerts are firing, when its last firing or resolved message was, and " +
        "who subscribes, an agent or the AI Assistant, marking a subscription handed to the AI Assistant because its agent was gone. " +
        "Read a signal's alert history with chat_read or chat_search on its conversation.",
      input: z.object({
        mine: z.boolean().default(false).describe("Only signals your person created or subscribes to."),
        alert: alertSchema.optional().describe("Only this alert."),
      }),
      async execute(input, context) {
        try {
          const files = await chat(context);
          const shown = (await files.signals())
            .filter(signal => (!input.mine || isMine(signal, files.me)) && (!input.alert || signal.alert === input.alert));
          return text(shown.flatMap(signal => signalLines(signal, files.me)).join("\n") ||
            (input.alert ? `No signal "${input.alert}".` : input.mine ? `${files.me} has no signals.` : `No signals yet; ${signalToolNames.register} creates one.`));
        } catch (error) {
          return brokerFailure(error);
        }
      },
    }),
  ];
}
