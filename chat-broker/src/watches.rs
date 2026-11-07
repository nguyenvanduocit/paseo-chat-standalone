//! Which agents wait on which conversation, and what is due to them. An agent that sent a message
//! asking for replies, or that its person mentioned, waits on that conversation for `WATCH_FOR_MS`, and past that for
//! as long as a request it wrote in stays open, up to `REQUEST_WATCH_MS` after the request was sent. Others' later
//! messages that concern it, and the mention, are due to it until its host acknowledges them. The broker keeps the
//! watches, so a daemon restart loses none; the host's chat plugin hands what is due to the agent. An agent its person
//! subscribed to a signal waits on the signal's room for as long as the subscription names it. Pure: `now`
//! is an argument.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::model::{Conversation, Message, Status, is_after, is_message_key, key_ms};
use crate::signals::{self, AUTHOR};
use crate::state::{State, Thread};

pub const WATCH_FOR_MS: i64 = 24 * 60 * 60_000;
/// How long an open request keeps its agents waiting after it was sent: two weeks, a sprint.
pub const REQUEST_WATCH_MS: i64 = 14 * 24 * 60 * 60_000;

/// One agent waiting on one conversation, in `watches/<handle>.json` of the agent's person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watch {
    pub agent: String,
    /// The conversation id.
    pub conversation: String,
    /// Messages keyed after this are new to the agent.
    pub after: String,
    pub until: i64,
    /// Keys of the person's messages that mentioned the agent and have not reached it yet.
    pub mentions: Vec<String>,
}

impl Watch {
    fn is(&self, agent: &str, conversation: &Conversation) -> bool {
        self.agent == agent && self.conversation == conversation.id()
    }

    fn is_valid(&self) -> bool {
        Conversation::parse(&self.conversation).is_some()
            && is_after(&self.after)
            && self.mentions.iter().all(|key| is_message_key(key))
    }
}

/// A `watches/<handle>.json` file, or None when it is not a list of watches.
pub fn parse(value: Value) -> Option<Vec<Watch>> {
    serde_json::from_value::<Vec<Watch>>(value)
        .ok()
        .filter(|watches| watches.iter().all(Watch::is_valid))
}

fn upsert<'a>(
    watches: &'a mut Vec<Watch>,
    agent: &str,
    conversation: &Conversation,
    after: &str,
) -> &'a mut Watch {
    let at = match watches
        .iter()
        .position(|watch| watch.is(agent, conversation))
    {
        Some(at) => at,
        None => {
            watches.push(Watch {
                agent: agent.to_owned(),
                conversation: conversation.id(),
                after: after.to_owned(),
                until: 0,
                mentions: Vec::new(),
            });
            watches.len() - 1
        }
    };
    &mut watches[at]
}

/// Whether a request of `thread` keeps the agent of `watch` waiting: one it wrote in that is open and younger than
/// `REQUEST_WATCH_MS`, or one someone else (not `me`) closed after the agent's cursor, until that reaches it.
fn held_by_request(watch: &Watch, me: &str, now: i64, thread: &Thread) -> bool {
    thread.requests.iter().any(|(key, request)| {
        request.agents.contains(&watch.agent)
            && if request.is_open() {
                now - key_ms(key) < REQUEST_WATCH_MS
            } else {
                request.at.as_str() > watch.after.as_str()
                    && thread
                        .messages
                        .get(&request.at)
                        .is_some_and(|closing| closing.author != me)
            }
    })
}

/// Whether the watch still waits: within its time, held by a signal subscription, or held by a request.
pub fn alive(watch: &Watch, me: &str, now: i64, state: &State) -> bool {
    watch.until >= now
        || signals::holds(state, me, &watch.agent, &watch.conversation)
        || Conversation::parse(&watch.conversation)
            .and_then(|conversation| state.thread(&conversation))
            .is_some_and(|thread| held_by_request(watch, me, now, thread))
}

/// Drops the watches of `me` that no longer wait.
pub fn prune(watches: &mut Vec<Watch>, me: &str, now: i64, state: &State) {
    watches.retain(|watch| alive(watch, me, now, state));
}

/// The agent sent `key` and waits for what comes after it; a later message moves the cursor and extends the wait.
pub fn sent(
    watches: &mut Vec<Watch>,
    agent: &str,
    conversation: &Conversation,
    key: &str,
    now: i64,
) {
    let watch = upsert(watches, agent, conversation, key);
    watch.after = watch.after.as_str().max(key).to_owned();
    watch.until = watch.until.max(now + WATCH_FOR_MS);
}

/// The person's message `key` mentioned the agent: it is due to the agent, with what comes after it. A new watch
/// starts just before the mention, so the mention itself is read with the replies.
pub fn mentioned(
    watches: &mut Vec<Watch>,
    agent: &str,
    conversation: &Conversation,
    key: &str,
    now: i64,
) {
    let before = format!("{:013}", key_ms(key) - 1);
    let watch = upsert(watches, agent, conversation, &before);
    watch.mentions.push(key.to_owned());
    watch.until = watch.until.max(now + WATCH_FOR_MS);
}

/// `me` subscribed the agent to the signal of `conversation`, whose newest key is `last`: a new watch starts there,
/// so the alerts that come after it are due. A watch the agent already has keeps its cursor.
pub fn subscribed(watches: &mut Vec<Watch>, agent: &str, conversation: &Conversation, last: &str) {
    upsert(watches, agent, conversation, last);
}

/// The handle's live watches on `conversation`, if any: who to tell that something may be due.
pub fn waits_on(
    watches: &[Watch],
    me: &str,
    conversation: &Conversation,
    now: i64,
    state: &State,
) -> bool {
    let id = conversation.id();
    watches
        .iter()
        .any(|watch| watch.conversation == id && alive(watch, me, now, state))
}

/// Whether someone else's `message` concerns the agent of `watch`: it is in the reply chain of a message the agent
/// sent, or of a request the agent wrote in; or it answers nothing in particular, in a direct message, in a signal room
/// the agent is subscribed to, or anywhere while the watch is within its time; or it is a message of `grafana` in that
/// signal room (a resolved alert answers its firing one). A reply to some other message is someone else's thread.
fn concerns(watch: &Watch, now: i64, subscribed: bool, thread: &Thread, message: &Message) -> bool {
    let by_agent = |message: &Message| {
        message.via.as_ref().and_then(|via| via.agent_id.as_deref()) == Some(watch.agent.as_str())
    };
    let in_request = thread
        .request_of
        .get(&message.key)
        .and_then(|request| thread.requests.get(request))
        .is_some_and(|request| request.agents.contains(&watch.agent));
    match message.reply_to {
        None => thread.conversation.is_dm() || subscribed || watch.until >= now,
        Some(_) => {
            in_request
                || (subscribed && message.author == AUTHOR)
                || thread.chain(&message.key).skip(1).any(by_agent)
        }
    }
}

/// What of one watch's conversation is due to its agent: the mentions not yet delivered and the replies.
pub struct Due<'a> {
    pub thread: &'a Thread,
    pub mentions: Vec<&'a Message>,
    pub replies: Vec<&'a Message>,
}

impl Due<'_> {
    pub fn is_empty(&self) -> bool {
        self.mentions.is_empty() && self.replies.is_empty()
    }

    /// The send time of the oldest message waiting for the agent.
    pub fn oldest_ms(&self) -> Option<i64> {
        self.mentions
            .iter()
            .chain(&self.replies)
            .map(|message| key_ms(&message.key))
            .min()
    }
}

/// What is due to the agent of a live watch of `me`; None when the watch no longer waits or its conversation is not
/// held. A `working` status needs nothing of the agent and is not due.
pub fn due_of<'a>(watch: &Watch, me: &str, now: i64, state: &'a State) -> Option<Due<'a>> {
    use std::ops::Bound::{Excluded, Unbounded};
    if !alive(watch, me, now, state) {
        return None;
    }
    let conversation = Conversation::parse(&watch.conversation)?;
    let thread = state.thread(&conversation)?;
    let subscribed = signals::holds(state, me, &watch.agent, &watch.conversation);
    let wanted = |message: &Message| {
        message.author != me
            && message.status != Some(Status::Working)
            && concerns(watch, now, subscribed, thread, message)
    };
    let mut due = Due {
        thread,
        mentions: Vec::new(),
        replies: Vec::new(),
    };
    for (key, message) in thread
        .messages
        .range::<str, _>((Excluded(watch.after.as_str()), Unbounded))
    {
        if watch.mentions.contains(key) {
            due.mentions.push(message);
        }
        if wanted(message) {
            due.replies.push(message);
        }
    }
    Some(due)
}

/// What is due to each of the handle's agents (`due_of`), as `GET /v1/deliveries` answers it. `me` is the handle.
pub fn due(watches: &[Watch], me: &str, now: i64, state: &State) -> Vec<Value> {
    watches
        .iter()
        .filter_map(|watch| {
            let due = due_of(watch, me, now, state).filter(|due| !due.is_empty())?;
            let views = |messages: &[&Message]| -> Vec<Value> {
                messages
                    .iter()
                    .map(|message| due.thread.view(message))
                    .collect()
            };
            Some(json!({
                "agent": watch.agent,
                "conversation": watch.conversation,
                "mentions": views(&due.mentions),
                "replies": views(&due.replies),
            }))
        })
        .collect()
}

/// The agent got everything up to `through`: those messages are no longer due. Returns whether a watch changed.
pub fn delivered(
    watches: &mut [Watch],
    agent: &str,
    conversation: &Conversation,
    through: &str,
) -> bool {
    let Some(watch) = watches
        .iter_mut()
        .find(|watch| watch.is(agent, conversation))
    else {
        return false;
    };
    let before = (watch.after.clone(), watch.mentions.len());
    if through > watch.after.as_str() {
        watch.after = through.to_owned();
    }
    watch.mentions.retain(|key| key.as_str() > through);
    before != (watch.after.clone(), watch.mentions.len())
}

/// The agent is gone: nothing more is due to it there. Returns whether a watch was removed.
pub fn end(watches: &mut Vec<Watch>, agent: &str, conversation: &Conversation) -> bool {
    let before = watches.len();
    watches.retain(|watch| !watch.is(agent, conversation));
    watches.len() != before
}
