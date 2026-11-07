# chat

A Paseo plugin for chat between the people who share one Paseo daemon, with an AI Assistant for each of them.

## Who you are

One daemon serves several people ([`docs/standalone.md`](../docs/standalone.md)): the handles in the daemon's
`CHAT_PEOPLE`. Each of them is listed in chat and has their AI Assistant running from the plugin's start, whether or
not a client of theirs is open; any other handle is refused. The first time a client opens Chat (the screen, the
workspace panel or **Cần lưu ý**) it asks **Bạn là ai?** and names the person picked in every call. Web and desktop
keep the choice in the window's `localStorage`. The mobile app gives plugins no storage that lasts, so there name the
app's connection to the daemon with your handle (e.g. `nam`): a client whose host label is one person's handle is that
person without asking. **Settings → Workspace Chat → Đổi người** picks again.

An agent acts for one person in chat. A tab the plugin opens carries its person's handle (conversation tabs under
`chat.owner`, the AI Assistant's tabs under `chat.assistant-of`). Any other agent acts for the owner of its workspace,
or for its parent agent's owner: the Chat panel of a workspace shows whose it is, with **Nhận workspace này** to
claim one no one owns and **Bỏ nhận** to let go of your own. An agent in a workspace no one owns gets an error from
the chat tools that says so, rather than speaking for someone by guess.

The identity is the client's own word, not a proof: everyone on the daemon runs as the same OS user, and their agents
can read every file on it. Use one daemon only for people who trust each other.

## Chat

Chat lets the people on this daemon talk to each other, and lets an agent reach
a person or a room for the task it is working on.

**Scope.** Chat is messaging between the daemon's people inside Paseo's own chat UI. A conversation
reuses Paseo's tab, composer and message items, and only those, so it has no reactions,
editing, deleting, typing or "seen" indicators: Paseo's timeline has no item for them.
Calls are a separate project.

**Reading a conversation.** Every view of a conversation reads as Discord and Slack read:
one sender's messages less than 5 minutes apart form a group, with their avatar, name and
time once, at the top; a reply always starts a group, with what it answers on one line above
it (`↪ author text`). The notification window also draws a line for each day (**Hôm nay**,
**Hôm qua**, then the date). The rule lives in [`shared/message-text.ts`](shared/message-text.ts).

**Chat** in the sidebar opens the chat screen (also **⌘K → Open Chat**). It has four columns:
**AI** first; **Cần lưu ý** (below); your conversations, newest first, each with its last message and unread count
(`@` when it mentions you); and everyone in chat with their presence and working agents (see **Presence** below).
Below 1480 px wide, AI and people share the first column, then Cần lưu ý, then conversations; below 1180 px AI, Cần
lưu ý and people share the left column; below 820 px all four stack, AI first. Side columns share one width (at least
300 px) and conversations take twice it, so the columns stay even at any width. Pick a person to message them
directly, or **Nhóm** to start a group of up to ten.

The **AI** column is the AI Assistant (see **AI Assistant** below): its card with whether it is on and the persona,
then **Worker trả lời tin nhắn**, the workers answering messages for you. Each names the work the router gave it and
whom it answers (**Trả lời carol, paseo-chung**). Workers that wait on you come first, the longest waiting first:
a permission to grant (**Cần cấp quyền**), an error (**Lỗi**), a finished turn you have not looked at (**Xong,
chưa xem**). Then the workers working (**Đang chạy**, with how long the turn has run), then idle ones that worked
in the last day, the newest 8; archived and older idle workers are only counted. Under **Điều phối** come the
**Router** and **Talk to myself** rows, with their state. The heading counts every tab of the assistant that waits on
you or is running. Picking a worker opens it; the router and talk-to-myself rows open theirs, archived or not, with its
context, and create one only when there is none. Their **⋯** menu has **Tạo agent mới**, which starts the tab over (see
**Starting a tab over** below) and opens the new one. Your other agents are not listed. The column reads this host's daemon every 5 seconds; the order lives in
[`shared/assistant-agents.ts`](shared/assistant-agents.ts).

**Cần lưu ý** is what you must not miss from your chats, kept by the AI Assistant. Besides its column on the chat
screen it has its own tab in the Chat panel and its own sidebar row, **Cần lưu ý**, counting the open items and
opening a screen with one column per kind, **AI bị vướng** first, then **Việc cần làm**, **Sự kiện** and **Ghi chú**,
side by side from 960 px wide and stacked below. It holds a todo (something asked of you,
or promised in your name), an event at a time (a meeting, a release, a deadline) or a note (a decision, a number,
a warning), and **AI bị vướng**: a worker's work its router could not settle, drawn as a warning (see
[AI Assistant](#ai-assistant)). The router and the workers record the others with `attention_add` as they read the messages written to you
directly or mentioning you, check `attention_list` so the same item is kept once, and mark an item done with
`attention_update` when the chat shows it is settled; every routing prompt and assignment tells them so, since
their system prompts are fixed when their tabs are created. Items with a time come first, soonest first, with
**Quá hạn** once past; the rest follow, newest first. Each row names its conversation and the agent that wrote it,
and picking it opens that agent, where the work behind it is; an item written before the agent was recorded opens
its conversation instead. Each item keeps the agent's id, the provider session it was in (a Claude Code session id)
and the key of the chat message it came from. Its **⋯** menu forks that agent (**Fork để hỏi tiếp**): a new tab in the
agent's workspace, with its provider, model and mode, whose first turn reads the agent's activity with Paseo's
`get_agent_activity` (or the session's transcript) and the chat message, sums up where the item stands and waits for
you ([`server/attention-fork.ts`](server/attention-fork.ts)). Paseo 0.15.0 gives a plugin neither a fork nor a way to
open an agent at a given message, so the fork reads that history itself and picking a row opens the agent at its
latest turn. The menu also marks the item done (**Đánh dấu xong**) or removes it (**Bỏ khỏi danh sách**). The list is yours alone: it lives on your host in
`~/.paseo/assistant/attention.json`, done items are dropped after 30 days and open ones past the newest 300.
Messages you write yourself, and rooms that do not mention you, do not reach the assistant, so nothing is noted
from them. The rules live in [`shared/attention.ts`](shared/attention.ts). The sidebar
row shows the total unread count. While any message is unread, the chat icon in every
workspace header turns the accent colour and pulses (one fade every 1.4 seconds, held
still under the system's reduced-motion setting), and its tooltip gives the count; it
returns to normal within 3 seconds of the last message being read.

Conversations are of two kinds:

- **Direct messages** between two to ten handles. Only members can read or write them.
- **Project rooms**. Every project has one room, `<project>-chung`, with nothing to set
  up: open a workspace and press the chat icon in the workspace header (or choose **Open
  Workspace Chat**), and the Chat panel opens in the Explorer. It is a list with four tabs.
  **Thành viên**, selected on open, starts with a line counting who is active, who is AFK and how
  many agents the team has working, then lists everyone in chat, on every host and project: active
  first, then AFK, then offline (see **Presence** below); under each name, how many of their agents
  are working, then the projects their host has workspaces of, as of their last time online (chat
  does not record workspace names). Your unread direct message with someone shows its count on their row.
  **Tin nhắn** lists your one-to-one
  conversations and **Nhóm** your rooms and groups of three or more, the project's room among
  them even before anyone writes in it. Each splits what is unread (**Chưa đọc**) from the rest
  (**Gần đây**), newest first in each, and its tab carries its unread count. Each conversation shows
  its name and last time (24-hour today, the weekday this week, else the date), then a second
  line with who wrote last and what. A read one is muted; an unread one reads in the foreground
  with the unread count (`@` when it mentions you). Picking a person or a conversation opens that conversation's
  tab in the middle of the window; a person opens your direct message with them. The list
  refreshes with the inbox, every 3 seconds. **Cần lưu ý** is the AI Assistant's list (above), its tab counting the
  open items. Every workspace of the project, on every host, opens the same room.
  A room appears in your conversation list once you
  have opened, read or written in it, or someone has mentioned you there. Rooms created
  earlier under other names stay in the list of everyone who joined them.

A conversation opens as a Paseo agent tab. A project room's tab is in a workspace of
that project: the one named like the project, else the project's own checkout. A direct
message's tab, or a room's whose project this daemon has no workspace for, is in the
workspace of `~/Chat/<handle>`, the person's own. A tab found only in another workspace stays open there, and a new one opens where the
conversation belongs, with its history replayed. Tabs are served by the plugin's `chat` agent provider, so it has Paseo's own composer, timeline, Markdown and
image attach. Every message reads as Markdown (bold, lists, links, code), drawn by Paseo's own
Markdown renderer. Your messages, and what your agents sent for you, are Paseo user messages, which
Paseo draws as typed text; the plugin registers a timeline transformer that draws them as its bubble
on the right (kind `chat-my-message`), in the style of Paseo's user bubble. It recognises a chat
tab's user message by its `messageId`, which is the chat message key for every message the tab
draws: the history it opens with and what arrives later (sent from another device, the Chat panel
or an agent's `chat_send`). A message typed in the tab's own composer keeps Paseo's bubble and reads
as typed: Paseo records it under the composer's own id, the same shape as a user message in any
other agent tab, and a timeline transformer is told nothing else about the item. Everyone else's are the plugin's
bubble on the left, under their name and time, drawn by a timeline renderer the plugin registers
(kind `chat-message`) because Paseo's timeline has no bubble for them. Your bubble has no name or
time, so your name and time sit above the first of your messages in a group, as a line of their own (kind `chat-sender`) ending at the
bubble's right edge; your own messages carry no avatar. Paseo draws the bubble of what you send
after whatever the tab drew last, so when your next message would start a group (after someone
else's message, or once your group's 5 minutes have passed) the tab ends with an empty sender line,
which the plugin fills in place once your message lands below it. Each conversation keeps one
tab, found again by its `chat.conversation` label. Opening the tab shows the latest 200
messages and marks the conversation read: Paseo opens a new agent without history, so the
plugin then reloads it, and the reopened session replays the conversation into Paseo's
stored timeline. Opening a tab also adds the conversation to the `chat` provider's model
list and refreshes Paseo's catalog, which is where the tab's model pill gets its name.

A message from someone else that arrives while the tab is open runs as a turn, so Paseo
marks the tab as needing attention, with its own unread dot and notification; the plugin
counts that as reading the conversation. Paseo clears attention when you open or leave the tab,
focus its composer or send, not when a message arrives in the tab you are watching, so a
reply you just read keeps its dot until then. That is Paseo's attention model for every
agent and the plugin leaves it as is. A plugin reload, daemon restart or rollout closes
the tab's session; Paseo reopens it from the conversation stored with the agent. Sending
needs no turn: the message is written and the tab is ready for the next one.

Messages are up to 4000 characters with up to four PNG, JPEG, WebP or GIF images of up
to 10 MB. Images live only at the chat broker: the message links each as a Markdown image at
`<CHAT_BROKER_URL>/v1/images/<sha256>`, which the broker serves without a
credential, so Paseo draws it with a plain image request and no file is written into the
tab's workspace. Your own messages are Paseo user messages, which carry text only, so their
images follow your bubble as a Markdown item of their own. The daemon checks the type from the
file's bytes (SVG and images over 40 megapixels are refused) and strips JPEG EXIF/IPTC
except orientation and PNG text chunks; WebP and GIF are stored as uploaded.

### Presence

Everyone in chat reads as one of three, with a dot on their avatar:

- **Đang hoạt động** (green): a Paseo window of theirs is open and has had input in the last 5 minutes.
- **AFK** (amber), with how long since their last input: a window is open, without input for 5 minutes.
- **Offline** (grey), with when they were last seen: no window is open.

Input is a key, click, pointer move, wheel or touch anywhere in a Paseo window on the web and desktop app;
on iOS and Android, the app being in the foreground. Each inbox poll says how long ago its window had input,
and the person's daemon keeps the newest of all their windows. A window that only reopened (a reload, a
rollout) counts as no input until the person uses it. Coming back from AFK shows within one poll.

Separately, each person's row says how many of their host's agents are working (**3 agent đang chạy**):
agents in a turn, sub-agents and AI Assistant tabs included, chat tabs not. The daemon counts them every
5 seconds and writes the count whenever it changes, so it shows while the person is AFK or offline too. A
daemon gets its Paseo client from a window or an agent starting a turn, so after a reload the count starts
with the first of them. A count its daemon has not refreshed for a minute (host down) reads as none.

### Mentions

A message can mention people and your own agents. Each mention shows as a pill.

- **In a chat tab**, open Paseo's attach menu in the composer and pick **Nhắc tên**. It lists the people in chat
  and the agents on your host, and each pick becomes one of Paseo's attachment pills. When you send, the
  mentions lead the message.
- **In the Chat panel and the pop-up**, type `@`. People and your agents are offered (in a direct message,
  only its members). Click one, or press Enter for the first, and it becomes a pill above the text.
  Backspace in an empty box removes the last pill.
- Typing `@handle` by hand still mentions that person.

A person is stored in the message as `@handle` and an agent as `@[title](agent:<agent id>)`; mentions inside
Markdown code are text. Messages show mentions as pills: in the panel and the pop-up as tinted text, and in
someone else's message in a tab as inline code. Your own bubble and previews read `@title`.

A mentioned person gets the `@` badge and the pop-up, the same as a typed `@handle`. A mentioned agent must
be one of yours. Your daemon sends it the message as a prompt once it is idle, without interrupting a running
turn, and then forwards what concerns it in that conversation, the same as after `chat_send`. Only
messages you wrote are delivered: a message an agent sent for you does not prompt other agents. An agent id
that is not on your host is skipped. The attach item also appears in other agents' composers; there it
attaches a short note naming the handle or agent.

### Notifications

Each message has a priority, `normal` or `urgent`. In a chat tab's composer the **Khẩn** attachment
pill (next to **Nhắc tên**) marks the message urgent and adds no text; an agent passes
`priority: "urgent"` to `chat_send`. Every other message is normal, as is a stored message
that carries none. A retry with the same id cannot change the priority it stored.

While any Paseo window is open, an unread urgent message sent to you directly or mentioning you
opens a window over whatever you are doing. An urgent room message that does not mention you
opens nothing, so one message cannot interrupt a whole room. The window shows the unread messages of that conversation (up
to the latest 20), drawn as in the conversation tab, and a reply box. Enter or the send
button (**Gửi**) sends the reply, **Đóng** closes the window, and
**Mở chat** opens the conversation's tab. Each of the three marks the conversation read.
Messages that arrive while the window is open are added to it. Several conversations
queue and open one window at a time. A conversation that is read somewhere else in the
meantime, such as in its tab or in another Paseo window, leaves the queue. A conversation
whose tab is open is left to Paseo's own attention instead, so it is not announced twice.

Normal direct messages and mentions show a toast. **Settings → Workspace Chat** uses Paseo's settings rows, and a change saves at once. It turns the window off. When it is off, urgent direct messages and
mentions show a toast as well. The same settings choose which other messages show a toast:
direct messages and mentions, every message, or none. With the default, a room message
without a mention only moves the unread count. Nothing reaches a person whose Paseo is
closed; they see the unread count next time.

### Agents

Every interactive agent session gets these tools, the AI Assistant's router and workers included. They act as the host's person.
Paseo hands plugin tools to agents through its MCP server, so the daemon needs
`daemon.mcp.injectIntoAgents: true` (Paseo's default is off); the image seeds it on
unless the config already sets it.

| Tool | What it does |
|---|---|
| `chat_people` | Lists people in chat: active, away or offline, and how many of their agents are working |
| `chat_conversations` | Lists your conversations with ids and unread counts |
| `chat_read` | Reads the latest messages of a conversation (`to` or `conversation`); a message's images show as `[images: <id>, …]` |
| `chat_search` | Searches one conversation or all of yours |
| `chat_send` | Sends to people (`to: ["alice"]`) or a conversation; optional `replyTo`, `images` (absolute paths of up to 4 image files on the host), and `priority: "urgent"` to open a window on the recipient's screen |
| `chat_image` | Saves a chat image by id to `~/.paseo/chat-images/<id>.<ext>` and returns the path; the agent reads that file to see it |
| `chat_open` | Opens a conversation on your person's screen |
| `chat_signal_register` | Registers a signal: the chat broker pulls the Grafana alerts whose rule carries the label `signal=<alert>` and posts them in `room:signals/<alert>`; returns the signal and tells the agent to add that label to the alert rule on the Grafana the chat broker pulls (its `GRAFANA_URL`) |
| `chat_signal_subscribe` | Subscribes to a signal: by default the calling agent hears its alerts as prompts, `agent: "assistant"` sends them to your AI Assistant; one subscription per person and alert |
| `chat_signal_unsubscribe` | Ends your person's subscription to a signal |
| `chat_signal_list` | Lists signals (`mine`, `alert` filters): creator, firing count, last change (firing or resolved message), subscribers, and subscriptions handed to the AI Assistant because their agent was gone |

Every 30 seconds the chat broker pulls the firing alerts of
the Grafana at the broker's `GRAFANA_URL` labelled `signal=<alert>`, posts every new alert of one poll as one message of the signal's room, and
answers it with a resolved message once two polls in a row miss the alert; a silenced alert stays out of chat. The broker keeps the subscriptions and an agent's watch on its signal room, so a
subscribed agent hears alerts through the same delivery as replies, and when the plugin reports that agent gone the
broker hands the subscription to the person's AI Assistant. The relay reads the
signal subscriptions every tick (`GET /v1/signals`; a broker without them counts as none) and hands the router every
alert of a room the AI Assistant subscribes to. An alert's history is the room itself: `chat_read` and `chat_search`.
**Settings → Workspace Chat → Signals** lists every signal with who subscribes; you subscribe your AI Assistant or
leave there, and a signal's creator deletes it.

Paseo's agent tools answer in text only, so images travel as files: an agent sees one with `chat_image`
and its own file-reading tool, and attaches one by path. The AI Assistant's `assistant_reply` takes the
same `images`.

A message an agent sends carries `via` with the agent's title and id. An agent can also prompt a
conversation's tab directly (Paseo's agent-to-agent message); Paseo wraps that prompt in a
`paseo-system` envelope, and the tab sends what the agent wrote, without the envelope, with `via`
holding the sending agent's title and id. The same goes for an AI Assistant tab's replies. Others see
it as a plain message from the agent's person; `chat_read` marks it for agents. In your own
conversation tab it is your Markdown bubble marked "Sent by AI": the tab draws it in Paseo's
`agent-message` envelope, the daemon turns that into an `agent_message` tool call keyed by the chat
message key (whose card draws the body as plain text), and a second timeline transformer
(`chat-my-agent-message`) draws that call as your bubble. A transform gets the call's id, name and
body but not the sending agent, and timeline renderers get no navigation, so the mark neither names
nor opens the agent. Messages stored before the id was kept stay your own bubble, unmarked. A `chat_send` that waits for replies (the default) opens a request, unless it answers inside one.
A reply in a request may say where it stands with `status`: `working`, `input-required`, `completed`,
`failed` or `canceled`; the last three close it, and a message that closes one never waits. Every
message shows what it says of its request as a muted line under its text ("Yêu cầu, chờ trả lời",
"Yêu cầu: Đã xong"), and `chat_read` marks it for agents.
After `chat_send`, new messages from others in that conversation that concern the agent are sent to
it as a prompt at once: those in its requests or answering what it sent, and plain messages in a
direct message, or in a room for 24 hours. A `working` status needs nothing and is not sent. The
agent keeps hearing them for 24 hours, and past that while a request it wrote in is open, up to 14
days. A working agent takes them into its turn (Paseo's steer, as Paseo hands one agent's message to
another), an idle one starts a turn. Agents, on all sides together, send up to 20 messages in a
conversation at once, then one every 30 seconds: past that, `chat_send` answers the agent with an error
telling it to slow down and when to send again. A message you write mentioning an agent of your host reaches it the same way, with what
comes after. The chat broker keeps who waits on what (`watches/<handle>.json`) until the agent got
it, so a daemon or broker restart loses none; the daemon hands it over once a window or an agent
brings it a Paseo client. Sending to an unknown handle fails and lists the known ones.

### AI Assistant

The AI Assistant answers what others send you directly (direct messages of two to ten people)
or mention you in (`@handle` in a room). It is always on. Its tabs open in the workspace of your persona directory,
`~/.paseo/chat/<handle>/persona`; the daemon creates the directory and opens its workspace when it starts. One
**router** tab (**AI · Router**) receives all of it, from every conversation, and writes each piece of work to the
**worker** tab that owns it. A worker owns one piece of work (a task, a question, an
incident, a merge request) and keeps its context: when someone asks about the same work later, or someone else
asks about it, the router hands it back to the same worker, waking it if it was archived, so the work is never
started over. The **AI Assistant** card at the top of the Chat screen's AI column, and the row at the top of the
Chat panel, show the persona and how many of its router and worker tabs are open and running. The card's **Mở**
opens the workspace. The panel row opens a dialog with **Router** and **Talk to myself**. A router or worker created in a workspace picked
before the assistant had its own keeps working there while its agent exists. **Router**, on the card and in the dialog, opens the router tab to watch which worker
each message went to; before any message came, it opens a new idle router, which the next message goes to.

When the broker reports a new message, the daemon collects that conversation's new messages for the assistant and,
once the sender has been quiet for 8 seconds, hands them to the router, every conversation ready at that moment in
one prompt, so a thought split over several messages arrives together. A router still working takes them into its
turn (Paseo's steer); a finished one starts a turn. One prompt carries at most 20 messages of a conversation. Your own
messages are not delivered. Messages someone sent through an agent (`via`) are, since people ask through their agents,
except a `working` status, which needs no answer; so two people's assistants answering each other slow down instead
of prompting each other at full speed, the broker takes 20 agent messages in a conversation at once, then one every 30
seconds. Turning the assistant on starts it from then; what arrives while it is off is not delivered. How far each
conversation has been sent to the router is stored with chat (`assistant/<handle>.json`), so a plugin reload,
rollout or daemon restart neither loses nor repeats a message.

The router's job is to route: its system prompt tells it never to do the work and never to answer anyone. Its own
tools are `assistant_workers`, which lists every
worker with its title, topic, status (working, idle, archived), the conversations it was handed, its checklist and
the **Cần lưu ý** item its work is on, `assistant_follow_up` and `assistant_escalate` (below), and
`assistant_assign`, which sends a worker the router's own message: an existing worker by id, or a new one with a
title and a topic. The router decides what goes in that message (who asks what, what they wait for, that someone
else asked the same, what was decided before) and lists the keys of the chat messages it is about. The tool checks
the worker, the conversation and the keys, delivers the message to that worker, and adds only what the plugin knows
for sure: the conversation, the author and time of each named message, the work the worker owns when it is new or
has moved on, how to answer, and a note to read your persona again when it changed since the worker last read it. The worker reads the named messages as written with `assistant_read`.
Beside those, the router has every tool a worker has, none refused: Claude's own tools, the chat tools and other
plugins' tools, with the same approvals and Auto mode, so it reads the persona and keeps Claude Code's memory like any
agent. A conversation is not tied
to one worker: messages about two things go to two workers, and when a conversation turns to other work, the router
assigns it to the worker of that work. The workers, what each works on and the checklist it reports are kept in
`~/.paseo/assistant/workers.json`, written only by the plugin. The plugin archives a worker once its work is settled
(it reported since its last assignment, every step `completed`, nothing `waiting` or `blocked`) and it has been idle 5
minutes; the router and **Talk to myself** stay open.

The router, the **Talk to myself** tab and every worker last as long as their agents exist. `workers.json` records
each by its Paseo agent id and the Claude Code session that agent runs (Paseo's `persistence.sessionId`, there once
the tab's first turn starts; every tick keeps it current). The router is called up for every message to route and a
worker the router hands work to is woken with its context, archived or not, whatever workspace it is in; **Router**
and **Talk to myself** open the recorded tab, an archived one un-archived first with its session resumed and its
timeline (Paseo's reload). When the recorded agent is gone, the agent that runs its recorded session (the session
imported again with `paseo import`, say) takes its place, and its record moves to that agent at the next tick. Only
when neither exists is a new tab created, in the persona's workspace and without context: the router at the next
message for it or when you open it, a worker when the router assigns new work, the **Talk to myself** tab when you open
it or the daily improvement starts. On a host whose
`workers.json` records no router or **Talk to myself** tab yet, the newest open one is recorded, else the newest
archived one. Claude Code compacts a long-running router or worker on its own.

**Starting a tab over.** **Tạo agent mới** in the **⋯** menu of the **Router** or **Talk to myself** row replaces
that tab with a new one, in the persona's workspace with today's access and system prompt, recorded in `workers.json`
so every button and prompt reaches it, and archives the old one. What the old tab learned is not lost with its
context: the **Talk to myself** tab (the new one, when that is what started over) gets a turn naming the old tab's
Claude Code session and reads it unattended: decisions you made in a talk, or each decision the router made with a
verdict, go into the decision records, and the lessons into the persona, within the same authority as the daily
improvement. A **Talk to myself** tab in a talk with you takes that turn into its current one. Only **Talk to myself**
writes the persona, so a new router starts clean; the workers and their work stay in `workers.json`. A tab in a turn
is not started over, since what it works on would be cut off; a tab that never ran has no session to learn from.

Workers report to the router. Every
assignment and follow-up tells a worker to send its checklist with `assistant_checklist` before it starts, and the
whole list again whenever a step moves: each step `pending`, `in_progress`, `completed`, `waiting` (for something that
comes by itself: a reply, CI, a deploy) or `blocked` (it needs help: access, your decision, a failure it cannot fix).
A waiting or blocked step says in its note what or whom it waits for; those steps are the worker's blockers. Every
report reaches the router: once a worker has been quiet for 8 seconds, the reports the router has not seen go in one
prompt, the steps that changed marked. Every minute the plugin checks every worker whose agent still exists, idle,
archived or in a turn, so no agent has to be alive for stuck work to surface. Work that stopped before
it was settled (a blocked step, steps left with nothing waiting or blocked, or no checklist since the last assignment)
goes before the router after 15 minutes without moving, after 2 hours when it only waits, and again every hour while
nothing moves. A worker in a turn that did nothing for 15 minutes shows as `stalled` and is checked the same way. When
the router takes no prompt, or is stalled itself, that work goes on your **Cần lưu ý** list at once. The router settles it with `assistant_follow_up`, its message to the worker
about that work (at most 3 while the work does not move), or puts it on your **Cần lưu ý** list with
`assistant_escalate` when only you can settle it. Once the router was asked twice and nothing moved, the plugin puts it
there itself. A worker has one such item at a time; picking it opens the worker. It closes by itself once the worker
reports every step completed. When you mark it done or remove it while the work is open, the router is told at the
next check. No agent adds or closes one through the attention tools. When your part is done but the worker still
waits on others, an agent marks it done with `attention_update`, and it stays on the list as waiting on others: last,
muted, with an hourglass and "Bạn đã xong · AI chờ người khác", not counted, until the worker settles the work;
`assistant_escalate` again makes it need you again. Agents never write "done" into a title. A worker from before this is checked
only from its next assignment.

A worker acts for you with everything an agent of yours can do: the chat tools above reach any
person or conversation of yours, and it runs commands, edits files, browses and starts
sub-agents. Two tools of its own, `assistant_read` and `assistant_reply`, take a conversation id and work only in the
conversations assigned to it; a reply through them is marked as sent by **AI Assistant** (`via`). A third,
`assistant_checklist`, reports its work to the router (above). Every tab the
plugin creates runs in Claude's Auto mode, so it never stops to ask you: every Paseo tool
(`mcp__paseo`) runs without asking for a worker, and a classifier settles the rest. Your rules decide what a
worker does; nothing in Claude enforces them. Anyone who writes to you drives a worker, so a message can
ask it to read your other conversations or run a command as you.

The router's and the workers' system prompts are generic: their role, their tools, and where your **persona** is:
the directory `~/.paseo/chat/<handle>/persona/`, plain files in any shape (your rules, your taste, anything else about how
to answer), except `decisions/`, your decision records. Everyone on the daemon can read it: it is drawn from what you type while working with Claude Code and what you write in chat, direct messages included,
and keeps no credentials, database rows, customer data or private details about others. The rest of the assistant's
state (the corpora, workers, attention list, persona history) stays in `~/.paseo/chat/<handle>/assistant`. Each agent
reads every file of the persona itself before its first prompt and again whenever it is unsure it still
has them, for instance after Claude Code compacted it. Both read them with Claude's `Read`, allowed on that directory
without asking. The plugin's fixed rules win over the persona; within it, a rule wins over taste, and what a tab never
does wins over what it may do. A worker learns the work it owns
from its assignments, never from its system prompt. You shape the persona in one place: **Talk to myself**
on the card (or in the Chat panel's dialog) opens your agent tab **Talk to myself**, archived or not, with its
context; it is created in the assistant's workspace only when there is none.

- It is a candid, fair talk between you and the AI: it cites what it sees (a rule, a profile line,
  a message key), disagrees when the evidence does and concedes when you show it is wrong.
- It has full rights over the persona: it reads and writes the files in `~/.paseo/chat/<handle>/persona/`
  with Claude's own `Read`, `Write` and `Edit`, allowed there without asking, and organises them as it
  sees fit, as soon as something is settled, without asking. It extracts and refines: turns a taste line
  that keeps deciding answers into a rule, merges duplicates, sharpens vague rules and drops what the
  evidence contradicts. It has every other tool an agent of yours has too.
- It keeps your **decision records** in `~/.paseo/chat/<handle>/persona/decisions/`, one file per month: each decision
  you made, the options on the table (the AI's proposals included), what you chose and turned down, why (in your
  words, or marked inferred), how you got there (the evidence you asked for, whom you asked, the principle you applied)
  and the session ids and message keys it came from. They are the evidence your taste is drawn from: a way of
  deciding that recurs becomes a taste line or a rule in the persona. The router and the workers do not read them, and
  changing them is not a new version of the persona.
- The plugin only reads the persona: to tell the router and the workers when it changed, and to keep
  every version it sees once in `history/persona-<version>/`.
- Its tool `assistant_doctor` checks the assistant, one line per check (`ok` or `problem`, with
  how to fix it): the workspace, the daily improvement scheduler (when it last ran, when it
  runs next, what holds it back), the persona's files, how far back it has read your sessions, the decision record
  files and the open tabs. A new tab
  runs it first, then sums up where things stand.
- The daily improvement is scheduled by the plugin itself: every tick it checks whether a day has
  passed since the last one and at least 5 new entries came: your messages and prompts, and your
  assistant's acts. Then it rebuilds three corpora and hands the improvement to the tab as a new turn, so a
  talk in it is kept:
  - `corpus.md`: what you wrote in chat, newest first, each with the 3 messages before it; a message
    right after your assistant answered is marked as your reaction to it.
  - `work.md`: what you typed and chose in your own Claude Code sessions, newest first, each with
    what the AI had just said or asked: your prompts and your answers to its questions with options.
    Your sessions are the ones recorded under `~/.paseo/session-usage/<handle>/`: the SessionStart hook
    (`hooks/session-start.mts`) records the agent a session runs under, and the plugin files it under that
    agent's owner ([`docs/standalone.md`](../docs/standalone.md)); another handle's are never read. Left out: tool
    results, other agents' messages, background task notices, scheduled runs, resumed sessions'
    copied history and summaries, skill text, dispatches another agent wrote (`GOAL:`), chat messages
    a plugin delivered, and every session of the assistant's own tabs. Up to 300 KB.
  - `review.md`: what your assistant's router and workers did in your name, from their own sessions:
    every message it sent (`assistant_reply`, `chat_send`), piece of work it handed out or followed up
    (`assistant_assign`, `assistant_follow_up`), escalation (`assistant_escalate`) and Cần lưu ý change
    (`attention_add`, `attention_update`), each with the prompts it was working on (quoted once per
    prompt) and what it said just before. Up to 600 KB, about one busy day.
  Each corpus takes what is new since the last run, oldest first, then older history it never read,
  newest first, so day by day it reaches the first session; a session written to recently is read
  before one written to long ago, so a router running all day is not crowded out. With too little new,
  the sessions are read again at most once an hour. The tab may read a whole session when an excerpt
  is not enough.

  The improvement runs unattended: it asks you nothing and settles everything itself. It records
  your decisions; reviews each decision the assistant made in your name (was it its to settle, was the
  authority it claimed in your own words, was it right by what happened after, what is still open) and
  records it with a verdict (right, overstepped, wrong, open); reconsiders earlier records against later
  evidence; and improves the persona from all of it, turning a decision the assistant overstepped or got
  wrong into a sharper rule. It tightens freely; it widens what a tab may settle on its own, or removes
  something a tab never does, only where your own words in `corpus.md` or `work.md` say so, never from
  what other people, agents or the assistant wrote. A wrong or overstepped decision whose effect still
  stands goes on your Cần lưu ý; the tab never messages anyone or undoes anything itself.

When a file of the persona changes, or the persona directory moves, the router and every worker keep their context
and are sent a message to read the persona again from where it is now: an open one at once, an archived one with the
next prompt that wakes it. Paseo fixes a tab's system prompt and options when it creates the tab, so every tab the
assistant creates carries the version of its access (label `chat.assistant-access`) and keeps that access while its
agent exists; the doctor counts the router and worker tabs whose access is older than today's. The **Talk to myself**
tab, used again after the assistant's directories moved, is told once, with its next turn, where the persona, the
decision records, the evidence and the persona's history are now. A tab you delete in Paseo is replaced, when it is
next needed, by a new one with today's access and without the old one's context.

The plugin process gets its Paseo client only through a handler or a hook, so after a reload
delivery starts once a Paseo window polls the inbox or an agent session opens on the host;
what arrived in the meantime is delivered then.

### Storage

Chat lives in the **chat broker** ([`docs/chat-broker.md`](../docs/chat-broker.md)), the only process that reads and writes the chat
files. The plugin's server side calls its HTTPS API and listens to one event stream
(`GET /v1/events`), so it never touches the files. [`server/chat.ts`](server/chat.ts) is that
client. A tab reads new messages when the broker says its conversation has one, and the AI
Assistant and agents' reply watches read only conversations the broker named. Each of them
reads everything again when the stream reconnects. The Chat screen, panel and notifications
still ask the daemon for the inbox every 3 seconds, and each ask is one call to the broker.

The broker stamps the author from the handle each call names in `X-Chat-Handle`, behind the
daemon's key `CHAT_BROKER_KEY` (`Authorization: Bearer`), which the broker and the plugin share.
It checks direct-message membership, gives each message a key that only grows within its
conversation, slows each handle to 20 messages, then one per second, and 10 images, then one
per 5 seconds, and refuses new images once the store holds 4 GiB. Everyone in `CHAT_PEOPLE`
is in the people list from the plugin's start, so others can message them before they
open Paseo. A room @mention of a listed handle invites that person to the room, so the room
reaches their inbox before they ever open it.

The files keep their layout in the broker's `CHAT_BROKER_DATA_DIR`, so people and agents can
read the history with a shell. The broker reads them only when it starts, so an edit made while
it runs has no effect until its next start.

The daemon needs `CHAT_BROKER_KEY`, the broker's key, and `CHAT_BROKER_URL` when the broker is
not at `http://127.0.0.1:8080`. A daemon without the key answers every chat call with an error
saying so. Setup is in the [repository README](../README.md).

### Look

Every chat surface draws with Paseo's theme scale (spacing, font sizes, radii, icon sizes, control
heights), mirrored in [`client/paseo-theme.ts`](client/paseo-theme.ts) from Paseo 0.15.0, because the
plugin SDK hands plugins only the colors. The shared pieces (message list, composer,
buttons, badges, empty state) live in [`client/chat-ui.tsx`](client/chat-ui.tsx), and the text of a
message in [`shared/message-text.ts`](shared/message-text.ts), which the conversation tab uses too.
Markdown, icons, inputs, modals, loading and settings rows are the SDK's own components.

## Runtime and installation

The plugin has separate `index.client.tsx` and `index.server.ts` entries, with source under `client/`, `server/` and
`shared/`. It supports Paseo from the minimum in `paseo-plugin.json` (`requirements.paseo`, `>=0.15.0`, the first
release with `addHook`, screens and sidebar header items); the daemon and app must both satisfy it. Install it on a
daemon with local plugins enabled:

```sh
cd /absolute/path/to/chat-plugin
npm ci
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload chat   # after a change
```

## Checks

```sh
npm run typecheck
npm test
```

`npm test` keeps a few tests on what breaks most: the daemon's people (whom an agent acts for, who owns a workspace,
whose a chat tab is), direct-message membership between handles, `chat_send` acting for the calling agent's owner,
and a request through an agent reaching the router. The ones against the broker build `chat-broker/` with its
`harness` feature (`cargo` required, or a built binary in `CHAT_BROKER_BIN`) and start it with the daemon's key, on a
clock the test moves. Agent tests use a fake Paseo client.
