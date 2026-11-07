# One daemon, several people: identity comes from the client

**Status:** accepted · 2026-11-07

## Decision

One machine runs one Paseo daemon and one chat broker. Several people connect their Paseo clients to that daemon.

- **Who uses the daemon.** `CHAT_PEOPLE` lists their handles (`server/daemon.ts` `peopleOf`). The daemon runs each
  one's chat client, reply watcher and AI Assistant from the plugin's start, and refuses any other handle, so a
  mistyped name never starts another router.
- **Who a client is.** Each client picks one of them (**Bạn là ai?**) and names it in every RPC as `as`
  (`shared/chat.ts` `personal`). Web and desktop keep the handle in `localStorage`. The mobile app gives a plugin no
  storage that outlives it, and the only lasting value per device a plugin sees is the label of each host connection
  (`useHosts`), so a client whose host labels name exactly one person is that person (`client/me.ts`
  `hostLabelPerson`).
- **Who the broker hears.** The plugin calls the broker with the daemon's key (`Authorization: Bearer
  <CHAT_BROKER_KEY>`) and the person's handle (`X-Chat-Handle`). The broker stamps authors and checks
  direct-message membership by that handle.
- **Whom an agent acts for** (`server/daemon.ts` `ownerOf`): the handle its labels carry (`chat.owner` on
  conversation tabs, `chat.assistant-of` on the AI Assistant's tabs), else the owner of its workspace, else its
  parent agent's owner (`paseo.parent-agent-id`). A person claims a workspace no one owns in its Chat panel; only the
  owner lets go of it. An agent with no owner gets an error from the chat tools, never a guess.
- **Whose a Claude Code session is.** Paseo keeps the Claude session each agent runs on (`persistence.sessionId`). Every
  tick the plugin records each one it has not yet in `~/.paseo/session-usage/<owner>/<sessionId>.json`, the owner
  decided as for chat (`server/session-owners.ts`), once its transcript exists; an agent whose workspace has no owner
  waits. An agent's first session counts from the agent's creation; a later one (resumed, forked) carries a copy of
  the history before it, so it counts from when the plugin first sees it.
- **Per person on the daemon:** persona and assistant state in `~/.paseo/chat/<handle>/`, direct-message tabs in
  `~/Chat/<handle>`, conversation tabs whose model id and persistence carry the handle (`server/provider.ts`).

## Why

The Paseo plugin SDK (0.15.0) gives a server handler only `{ paseo }` (`@getpaseo/plugin` `server/contracts.d.ts`,
`PluginHandlerContext`) and an agent tool only the agent's id, workspace and title (`server/agent-tools.d.ts`). The
daemon cannot tell which client called, so the client says it. Settings have only `scope: "host"`, so notification
preferences are shared by everyone on the daemon.

## Options considered

1. **Client picks its name (chosen).** Simple, and honest about what one OS user can enforce.
2. **A token per person.** Stops one client from speaking as another through the UI, but every agent on the daemon
   runs as the same OS user with full rights and can read every token, message and persona file. It would look like
   a boundary without being one.
3. **Wait for the SDK to name the caller.** The right place long term; not available in 0.15.0.

## Threat model

| Threat | Control |
|---|---|
| Another process on the machine, or the network, calls the broker | Broker binds `127.0.0.1` by default and needs `CHAT_BROKER_KEY` (at least 16 characters, compared by SHA-256) |
| A client speaks as another person | Not prevented: the handle is the client's word. Use one daemon only for people who trust each other |
| An agent sends as the wrong person | Owner comes from labels, workspace claim or parent; none of them, the tool fails with what to do |
| One person takes over another's workspace | `withClaim` refuses a workspace someone else owns |
| Images are fetched without the key | An image id is the SHA-256 of its bytes, known only to who saw the message |

## Consequences

- No privacy between the people on one daemon: direct messages, personas and decision records are files every agent
  there can read. The assistant's own prompts say so.
- Paseo's composer in a chat tab searches mentions without saying whose tab it is, so it offers every agent of the
  daemon. The Chat panel's and pop-up's reply boxes offer only the sender's own agents.
- The daily improvement learns only from Claude Code sessions a Paseo agent ran; a `claude` started by hand has no
  agent to own it. A session an agent left within one tick (5 seconds) is not recorded; what it held is in the next.
- Everyone on the daemon shares one Claude account: its limits and bill.
- Adding or removing a person is a change to `CHAT_PEOPLE` and a restart of the daemon.
- On mobile, the host label is the person: renaming the connection changes who you are.

## Revisit when

The plugin SDK tells a handler which client or user called it. Then `as` becomes the SDK's caller, and the picker goes.
