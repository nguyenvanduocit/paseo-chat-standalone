//! The chat's data as stored and as answered: conversation ids, messages, attachments. Parsing here is the one
//! boundary; past it a value is trusted. Mirrors `chat-plugin/shared/chat.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::text::js_length;

pub const MAX_BODY_LENGTH: usize = 4000;
pub const MAX_ATTACHMENTS: usize = 4;
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_NAME_LENGTH: usize = 200;
pub const MAX_QUERY_LENGTH: usize = 200;
pub const MAX_DM_MEMBERS: usize = 10;
const MAX_AGENT_NAME_LENGTH: usize = 200;

fn pattern(expression: &str) -> Regex {
    Regex::new(expression).expect("a fixed pattern compiles")
}

static HANDLE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"));
static MESSAGE_ID: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Za-z0-9-]{8,64}$"));
static MESSAGE_KEY: LazyLock<Regex> = LazyLock::new(|| pattern(r"^\d{13}-[A-Za-z0-9-]{8,64}$"));
static IMAGE_ID: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[a-f0-9]{64}$"));
static AGENT_ID: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Za-z0-9_-]{1,128}$"));
static NAME_KEY: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[a-f0-9]{32}$"));

pub fn is_handle(text: &str) -> bool {
    HANDLE.is_match(text)
}

pub fn is_message_id(text: &str) -> bool {
    MESSAGE_ID.is_match(text)
}

pub fn is_message_key(text: &str) -> bool {
    MESSAGE_KEY.is_match(text)
}

/// "" (nothing read yet) or a message key.
pub fn is_cursor(text: &str) -> bool {
    text.is_empty() || is_message_key(text)
}

/// Where a read starts: a cursor, or a send time alone (13 digits), which sorts before every key sent at or after it.
/// The AI Assistant starts from the moment it was turned on this way.
pub fn is_after(text: &str) -> bool {
    is_cursor(text) || (text.len() == 13 && text.bytes().all(|b| b.is_ascii_digit()))
}

pub fn is_image_id(text: &str) -> bool {
    IMAGE_ID.is_match(text)
}

pub fn is_name_key(text: &str) -> bool {
    NAME_KEY.is_match(text)
}

/// The directory name of a project, room or member list: 32 hex characters of its SHA-256, so any name fits the
/// file system's name limit.
pub fn name_key(name: &str) -> String {
    hex::encode(Sha256::digest(name.as_bytes()))[..32].to_owned()
}

/// `<13-digit ms>-<id>`: keys sort in send order.
pub fn message_key(ms: i64, id: &str) -> String {
    format!("{:013}-{id}", ms.max(0))
}

/// The milliseconds a key starts with.
pub fn key_ms(key: &str) -> i64 {
    key.get(..13).and_then(|ms| ms.parse().ok()).unwrap_or(0)
}

/// The message id a key ends with.
pub fn key_id(key: &str) -> &str {
    key.get(14..).unwrap_or_default()
}

/// A project room or a direct message between two to ten handles, members sorted and unique.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Conversation {
    Room { project: String, room: String },
    Dm { members: Vec<String> },
}

/// JavaScript's `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// JavaScript's `decodeURIComponent`; None where it throws (a bad escape, bytes that are not UTF-8).
pub fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = text.get(at + 1..at + 3)?;
            decoded.push(u8::from_str_radix(pair, 16).ok()?);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn valid_name(name: &str) -> bool {
    (1..=MAX_NAME_LENGTH).contains(&js_length(name))
}

impl Conversation {
    /// A direct message between `handles`, sorted and unique; None unless that is two to ten valid handles.
    pub fn dm<S: AsRef<str>>(handles: &[S]) -> Option<Conversation> {
        let mut members: Vec<String> = handles.iter().map(|h| h.as_ref().to_owned()).collect();
        members.sort();
        members.dedup();
        ((2..=MAX_DM_MEMBERS).contains(&members.len()) && members.iter().all(|m| is_handle(m)))
            .then_some(Conversation::Dm { members })
    }

    /// A room; None unless project and room are each 1 to 200 characters.
    pub fn room(project: &str, room: &str) -> Option<Conversation> {
        (valid_name(project) && valid_name(room)).then(|| Conversation::Room {
            project: project.to_owned(),
            room: room.to_owned(),
        })
    }

    /// `dm:<a>,<b>` or `room:<project>/<room>`, as the plugin's `parseConversationId` reads it.
    pub fn parse(id: &str) -> Option<Conversation> {
        if let Some(members) = id.strip_prefix("dm:") {
            return Conversation::dm(&members.split(',').collect::<Vec<_>>());
        }
        let rest = id.strip_prefix("room:")?;
        let (project, room) = rest.split_once('/')?;
        if project.is_empty() || room.is_empty() || room.contains('/') {
            return None;
        }
        Conversation::room(&decode_component(project)?, &decode_component(room)?)
    }

    /// The one string a conversation is known by.
    pub fn id(&self) -> String {
        match self {
            Conversation::Dm { members } => format!("dm:{}", members.join(",")),
            Conversation::Room { project, room } => {
                format!(
                    "room:{}/{}",
                    encode_component(project),
                    encode_component(room)
                )
            }
        }
    }

    pub fn is_dm(&self) -> bool {
        matches!(self, Conversation::Dm { .. })
    }

    /// Whether `handle` may read and write it: everyone for a room, the members for a direct message.
    pub fn admits(&self, handle: &str) -> bool {
        match self {
            Conversation::Room { .. } => true,
            Conversation::Dm { members } => members.iter().any(|member| member == handle),
        }
    }

    /// Its directory under the chat root.
    pub fn dir(&self) -> String {
        match self {
            Conversation::Dm { members } => format!("dms/{}", name_key(&members.join(","))),
            Conversation::Room { project, room } => {
                format!("threads/{}/{}", name_key(project), name_key(room))
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
}

/// A message an agent sent for its person: `agent` is what to call it, `agent_id` the Paseo agent that sent it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Via {
    pub agent: String,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none", default)]
    pub agent_id: Option<String>,
}

/// A Paseo agent id.
pub fn is_agent_id(text: &str) -> bool {
    AGENT_ID.is_match(text)
}

impl Via {
    pub fn is_valid(&self) -> bool {
        js_length(&self.agent) <= MAX_AGENT_NAME_LENGTH
            && self
                .agent_id
                .as_deref()
                .is_none_or(|id| AGENT_ID.is_match(id))
    }
}

/// How hard a message asks for attention: an urgent one opens a window over its reader's screen, a normal one
/// shows a toast. A stored message without one reads as normal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    #[default]
    Normal,
    Urgent,
}

/// Where a request stands, as a reply in its chain says. `working` and `input-required` keep it open;
/// `completed`, `failed` and `canceled` close it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Working,
    InputRequired,
    Completed,
    Failed,
    Canceled,
}

impl Status {
    pub fn closes(self) -> bool {
        matches!(self, Status::Completed | Status::Failed | Status::Canceled)
    }
}

fn is_false(value: &bool) -> bool {
    !value
}

/// What is stored: written once, never rewritten. `wait`: the sending agent waits for answers, so the message opens a
/// request unless it is already inside one. `status`: where the request of its reply chain stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub key: String,
    pub id: String,
    pub author: String,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub attachments: Vec<Attachment>,
    #[serde(rename = "replyTo", skip_serializing_if = "Option::is_none", default)]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub via: Option<Via>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default, skip_serializing_if = "is_false")]
    pub wait: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<Status>,
}

impl Message {
    /// A stored message the plugin's `messageSchema` accepts.
    pub fn parse(value: serde_json::Value) -> Option<Message> {
        let message: Message = serde_json::from_value(value).ok()?;
        let valid = message.reply_to.as_deref().is_none_or(is_message_key)
            && message.via.as_ref().is_none_or(Via::is_valid)
            && (message.status.is_none() || message.reply_to.is_some());
        valid.then_some(message)
    }
}
