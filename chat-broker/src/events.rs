//! What `GET /v1/events` pushes, and who may see each event. Pure: the server filters with `visible_to`.

use serde_json::{Value, json};

use crate::classify::Classification;
use crate::model::Conversation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Audience {
    Everyone,
    /// The members of a direct message.
    Members(Vec<String>),
    /// One handle: its own reads and focus.
    Only(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub name: &'static str,
    pub data: Value,
    pub audience: Audience,
}

/// Who a conversation's messages reach: everyone for a room, the members for a direct message.
fn readers_of(conversation: &Conversation) -> Audience {
    match conversation {
        Conversation::Dm { members } => Audience::Members(members.clone()),
        Conversation::Room { .. } => Audience::Everyone,
    }
}

impl Event {
    pub fn message(conversation: &Conversation, key: &str, author: &str) -> Event {
        Event {
            name: "message",
            data: json!({"conversation": conversation.id(), "key": key, "author": author}),
            audience: readers_of(conversation),
        }
    }

    /// What the classifier made of a message, to whoever its message reached.
    pub fn classified(
        conversation: &Conversation,
        key: &str,
        classification: &Classification,
    ) -> Event {
        Event {
            name: "classified",
            data: json!({"conversation": conversation.id(), "key": key, "classification": classification}),
            audience: readers_of(conversation),
        }
    }

    /// An AI of `handle` made a decision only people make without pointing at the person deciding; to that
    /// handle's host, which puts it on the person's attention list.
    pub fn delegation(
        handle: &str,
        conversation: &Conversation,
        key: &str,
        decision: &str,
    ) -> Event {
        Event {
            name: "delegation",
            data: json!({"conversation": conversation.id(), "key": key, "decision": decision}),
            audience: Audience::Only(handle.to_owned()),
        }
    }

    pub fn read(handle: &str, conversation: &Conversation, key: &str) -> Event {
        Event {
            name: "read",
            data: json!({"conversation": conversation.id(), "key": key}),
            audience: Audience::Only(handle.to_owned()),
        }
    }

    pub fn focus(handle: &str, conversation: &str, at: i64) -> Event {
        Event {
            name: "focus",
            data: json!({"conversation": conversation, "at": at}),
            audience: Audience::Only(handle.to_owned()),
        }
    }

    pub fn people() -> Event {
        Event {
            name: "people",
            data: json!({}),
            audience: Audience::Everyone,
        }
    }

    /// Something may be due to an agent of that handle's host: a reply or mention in a conversation it waits on.
    pub fn deliveries(handle: &str) -> Event {
        Event {
            name: "deliveries",
            data: json!({}),
            audience: Audience::Only(handle.to_owned()),
        }
    }

    pub fn ready(handle: &str) -> Event {
        Event {
            name: "ready",
            data: json!({"me": handle}),
            audience: Audience::Only(handle.to_owned()),
        }
    }

    pub fn visible_to(&self, handle: &str) -> bool {
        match &self.audience {
            Audience::Everyone => true,
            Audience::Members(members) => members.iter().any(|member| member == handle),
            Audience::Only(only) => only == handle,
        }
    }

    /// The event as an SSE frame.
    pub fn frame(&self) -> String {
        format!("event: {}\ndata: {}\n\n", self.name, self.data)
    }
}
