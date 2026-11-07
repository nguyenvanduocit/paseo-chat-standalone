//! The chat held in memory, and every answer computed from it. Pure: no clock, no disk; `now` is an argument, and
//! changes arrive through the plain mutators the shell (`chat.rs`) calls after a file is written.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::classify::Classification;
use crate::isotime::iso_ms;
use crate::model::{Conversation, Message, Priority, Status, key_id, key_ms};
use crate::signals::SignalFile;
use crate::text::{matches, mentions_in, words};
use crate::watches::Watch;

/// A person counts as online while their people file was written this recently.
pub const ONLINE_WINDOW_MS: i64 = 60_000;
/// Online without input for this long is `afk`.
pub const AFK_AFTER_MS: i64 = 5 * 60_000;
/// A people or agents file that keeps its meaning is rewritten at most this often.
pub const REFRESH_MS: i64 = 20_000;
pub const PAGE_SIZE: usize = 200;
pub const SEARCH_LIMIT: usize = 50;

/// A request: a message an agent sent waiting for answers, outside any other request's reply chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    /// None while no reply in its chain has said where it stands.
    pub status: Option<Status>,
    /// The key of the message that set `status`, or of the request itself.
    pub at: String,
    /// The agents that wrote in its chain, the one that opened it first.
    pub agents: BTreeSet<String>,
}

impl Request {
    pub fn is_open(&self) -> bool {
        self.status.is_none_or(|status| !status.closes())
    }

    fn json(&self, key: &str) -> Value {
        let state = self.status.map_or(json!("open"), |status| json!(status));
        json!({"key": key, "state": state, "at": self.at})
    }
}

/// One conversation: its messages by key, what the classifier made of them, who has read how far and who a room
/// message mentioned.
#[derive(Clone, Debug)]
pub struct Thread {
    pub conversation: Conversation,
    pub messages: BTreeMap<String, Message>,
    /// Message key to its classification; a message the classifier has not answered for has none.
    pub classifications: HashMap<String, Classification>,
    /// Message id to key: a retry with the same id finds its message.
    pub ids: HashMap<String, String>,
    pub reads: HashMap<String, String>,
    pub invited: BTreeSet<String>,
    /// Request key to where it stands.
    pub requests: HashMap<String, Request>,
    /// Message key to the request whose reply chain holds it, the request's own key included.
    pub request_of: HashMap<String, String>,
}

impl Thread {
    pub fn new(conversation: Conversation) -> Thread {
        Thread {
            conversation,
            messages: BTreeMap::new(),
            classifications: HashMap::new(),
            ids: HashMap::new(),
            reads: HashMap::new(),
            invited: BTreeSet::new(),
            requests: HashMap::new(),
            request_of: HashMap::new(),
        }
    }

    /// Adds the newest message of the conversation: every older one is already indexed. Messages loaded in any
    /// order are added with `load` and indexed once with `reindex`.
    pub fn insert(&mut self, message: Message) {
        let key = message.key.clone();
        self.load(message);
        self.index(&key);
    }

    /// Adds a message without indexing it.
    pub fn load(&mut self, message: Message) {
        self.ids
            .insert(key_id(&message.key).to_owned(), message.key.clone());
        self.messages.insert(message.key.clone(), message);
    }

    /// Indexes every message, oldest first: a reply always comes after the message it answers.
    pub fn reindex(&mut self) {
        self.requests.clear();
        self.request_of.clear();
        let keys: Vec<String> = self.messages.keys().cloned().collect();
        for key in keys {
            self.index(&key);
        }
    }

    /// The request of `key`, from the messages before it.
    fn index(&mut self, key: &str) {
        let message = &self.messages[key];
        let agent = message.via.as_ref().and_then(|via| via.agent_id.clone());
        let inside = message
            .reply_to
            .as_ref()
            .and_then(|parent| self.request_of.get(parent))
            .cloned();
        let (status, wait) = (message.status, message.wait);
        let request = match inside {
            Some(request) => request,
            None if wait && status.is_none() => {
                self.requests.insert(
                    key.to_owned(),
                    Request {
                        status: None,
                        at: key.to_owned(),
                        agents: BTreeSet::new(),
                    },
                );
                key.to_owned()
            }
            None => return,
        };
        self.request_of.insert(key.to_owned(), request.clone());
        let entry = self
            .requests
            .get_mut(&request)
            .expect("a message's request is indexed before it");
        if let Some(status) = status {
            entry.status = Some(status);
            entry.at = key.to_owned();
        }
        entry.agents.extend(agent);
    }

    /// The messages from `key` up its reply chain, `key`'s own first.
    pub fn chain<'a>(&'a self, key: &str) -> impl Iterator<Item = &'a Message> + 'a {
        std::iter::successors(self.messages.get(key), move |message| {
            message
                .reply_to
                .as_ref()
                .and_then(|parent| self.messages.get(parent))
        })
    }

    pub fn last_key(&self) -> Option<&str> {
        self.messages.keys().next_back().map(String::as_str)
    }

    /// The milliseconds the next key starts with: now, or one past the newest key, so keys strictly increase.
    pub fn next_ms(&self, now: i64) -> i64 {
        self.last_key()
            .map_or(now, |last| now.max(key_ms(last) + 1))
    }

    pub fn last_read(&self, handle: &str) -> &str {
        self.reads.get(handle).map_or("", String::as_str)
    }

    pub fn by_id(&self, id: &str) -> Option<&Message> {
        self.ids.get(id).and_then(|key| self.messages.get(key))
    }

    /// Listed for `handle`: a room they have read, written or been mentioned in; a direct message they are in.
    pub fn includes(&self, handle: &str) -> bool {
        match &self.conversation {
            Conversation::Dm { .. } => self.conversation.admits(handle),
            Conversation::Room { .. } => {
                self.reads.contains_key(handle) || self.invited.contains(handle)
            }
        }
    }

    /// A message with the message it replies to, in full, or null, and its classification, or null.
    pub fn view(&self, message: &Message) -> Value {
        let reply = message
            .reply_to
            .as_ref()
            .and_then(|key| self.messages.get(key))
            .map_or(Value::Null, message_json);
        let classification = self
            .classifications
            .get(&message.key)
            .map_or(Value::Null, |classification| json!(classification));
        let request = self
            .request_of
            .get(&message.key)
            .and_then(|key| Some(self.requests.get(key)?.json(key)))
            .unwrap_or(Value::Null);
        let mut view = as_object(message_json(message));
        view.insert("reply".to_owned(), reply);
        view.insert("classification".to_owned(), classification);
        view.insert("request".to_owned(), request);
        Value::Object(view)
    }

    fn views<'a>(&self, messages: impl Iterator<Item = &'a Message>) -> Vec<Value> {
        messages.map(|message| self.view(message)).collect()
    }

    /// Messages keyed after `after`, oldest first, at most `limit`.
    pub fn after(&self, after: &str, limit: usize) -> Vec<Value> {
        use std::ops::Bound::{Excluded, Unbounded};
        self.views(
            self.messages
                .range::<str, _>((Excluded(after), Unbounded))
                .map(|(_, message)| message)
                .take(limit),
        )
    }

    /// The newest `limit` messages, oldest first.
    pub fn latest(&self, limit: usize) -> Vec<Value> {
        let skip = self.messages.len().saturating_sub(limit);
        self.views(self.messages.values().skip(skip))
    }

    /// Newest first, at most `SEARCH_LIMIT`, each with its conversation id.
    pub fn search(&self, query_words: &[String]) -> Vec<(String, Value)> {
        let id = self.conversation.id();
        self.messages
            .values()
            .rev()
            .filter(|message| matches(query_words, &message.body))
            .take(SEARCH_LIMIT)
            .map(|message| {
                let mut view = as_object(self.view(message));
                view.insert("conversation".to_owned(), Value::String(id.clone()));
                (message.key.clone(), Value::Object(view))
            })
            .collect()
    }

    /// The inbox line of this conversation for `handle`.
    pub fn summary(&self, handle: &str) -> Value {
        let read = self.last_read(handle);
        let unread: Vec<&Message> = self
            .messages
            .iter()
            .filter(|(key, message)| key.as_str() > read && message.author != handle)
            .map(|(_, message)| message)
            .collect();
        let addressed = |message: &Message| {
            self.conversation.is_dm() || mentions_in(&message.body).iter().any(|h| h == handle)
        };
        let id = self.conversation.id();
        json!({
            "id": id,
            "conversation": id,
            "last": self.messages.values().next_back().map_or(Value::Null, message_json),
            "unread": unread.len(),
            "mentioned": unread.iter().any(|message| mentions_in(&message.body).iter().any(|h| h == handle)),
            // An urgent message reaches its reader only addressed to them, so a room cannot pop a window for everyone.
            "urgent": unread.iter().any(|message| message.priority == Priority::Urgent && addressed(message)),
            "lastRead": read,
        })
    }
}

fn message_json(message: &Message) -> Value {
    serde_json::to_value(message).expect("a message serializes")
}

fn as_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

/// `people/<handle>.json`: when a window of theirs was last open, last had input, and their host's projects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonFile {
    pub at: i64,
    pub active_at: i64,
    pub projects: Vec<String>,
}

impl PersonFile {
    pub fn json(&self) -> Value {
        json!({"at": self.at, "activeAt": self.active_at, "projects": self.projects})
    }
}

/// `agents/<handle>.json`: how many agents that handle's host had working at `at`; `running` is None when the
/// file holds something that is not a whole number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentsFile {
    pub at: i64,
    pub running: Option<i64>,
}

/// `focus/<handle>.json`: an agent asked that handle's clients to open a conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Focus {
    pub conversation: String,
    pub at: i64,
}

/// `images/<id>.json`, written after the bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageMeta {
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub size: u64,
}

/// `assistant/<handle>.json`: where that handle's AI Assistant opens tabs (null while it is off), the key before
/// which nothing is sent, and per conversation the key of the last message it has been sent or passed over.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantState {
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub from: String,
    pub delivered: IndexMap<String, String>,
}

impl AssistantState {
    /// The plugin's `assistantStateSchema`: every field present, of its type; anything else is no state.
    pub fn parse(value: Value) -> Option<AssistantState> {
        let object = value.as_object()?;
        if !object.contains_key("workspaceId") {
            return None;
        }
        serde_json::from_value(value).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Active,
    Afk,
    Offline,
}

impl Presence {
    pub fn name(self) -> &'static str {
        match self {
            Presence::Active => "active",
            Presence::Afk => "afk",
            Presence::Offline => "offline",
        }
    }

    pub fn of(file: &PersonFile, now: i64) -> Presence {
        if now - file.at > ONLINE_WINDOW_MS {
            Presence::Offline
        } else if now - file.active_at > AFK_AFTER_MS {
            Presence::Afk
        } else {
            Presence::Active
        }
    }
}

/// What the people list shows of one person, without the stamps that move on every refresh: a change here is a
/// `people` event.
pub type PersonShape = (String, Presence, Vec<String>, i64);

/// A handle's presence as it is reported, besides what its file holds.
#[derive(Clone, Debug, Default)]
pub struct Reporter {
    /// The newest input any window of this handle reported.
    pub active_at: i64,
    pub people_written_at: Option<i64>,
    pub agents_written_at: Option<i64>,
}

#[derive(Default)]
pub struct State {
    /// By conversation id.
    pub threads: BTreeMap<String, Thread>,
    pub people: BTreeMap<String, PersonFile>,
    pub agents: HashMap<String, AgentsFile>,
    pub focus: HashMap<String, Focus>,
    pub assistant: HashMap<String, AssistantState>,
    /// By handle: the agents of that handle's host waiting on conversations.
    pub watches: HashMap<String, Vec<Watch>>,
    /// By alert name.
    pub signals: BTreeMap<String, SignalFile>,
    pub images: HashMap<String, ImageMeta>,
    /// Bytes of every `images/<id>` file.
    pub image_bytes: u64,
    pub reporters: HashMap<String, Reporter>,
    /// The people list as last announced.
    pub announced: Vec<PersonShape>,
}

impl State {
    pub fn thread(&self, conversation: &Conversation) -> Option<&Thread> {
        self.threads.get(&conversation.id())
    }

    pub fn thread_mut(&mut self, conversation: &Conversation) -> &mut Thread {
        self.threads
            .entry(conversation.id())
            .or_insert_with(|| Thread::new(conversation.clone()))
    }

    /// Conversations listed for `handle`, by id.
    pub fn joined<'a>(&'a self, handle: &'a str) -> impl Iterator<Item = &'a Thread> + 'a {
        self.threads
            .values()
            .filter(move |thread| thread.includes(handle))
    }

    /// Summaries newest last message first; conversations without one last.
    pub fn summaries(&self, handle: &str) -> Vec<Value> {
        let mut threads: Vec<&Thread> = self.joined(handle).collect();
        threads.sort_by(|a, b| {
            b.last_key()
                .unwrap_or_default()
                .cmp(a.last_key().unwrap_or_default())
                .then_with(|| a.conversation.id().cmp(&b.conversation.id()))
        });
        threads
            .into_iter()
            .map(|thread| thread.summary(handle))
            .collect()
    }

    /// The agents a handle's host reported; a count not refreshed within the online window is 0.
    fn running(&self, handle: &str, now: i64) -> i64 {
        self.agents
            .get(handle)
            .filter(|agents| now - agents.at <= ONLINE_WINDOW_MS)
            .and_then(|agents| agents.running)
            .map_or(0, |running| running.max(0))
    }

    /// Everyone with a people file, by handle.
    pub fn people(&self, now: i64) -> Vec<Value> {
        let iso = |at: i64| {
            if at == 0 {
                Value::Null
            } else {
                iso_ms(at).map_or(Value::Null, Value::String)
            }
        };
        self.people
            .iter()
            .map(|(handle, file)| {
                json!({
                    "handle": handle,
                    "presence": Presence::of(file, now).name(),
                    "lastSeenAt": iso(file.at),
                    "activeAt": iso(file.active_at),
                    "projects": file.projects,
                    "agents": self.running(handle, now),
                })
            })
            .collect()
    }

    pub fn people_shape(&self, now: i64) -> Vec<PersonShape> {
        self.people
            .iter()
            .map(|(handle, file)| {
                (
                    handle.clone(),
                    Presence::of(file, now),
                    file.projects.clone(),
                    self.running(handle, now),
                )
            })
            .collect()
    }

    /// Search one conversation, or every one listed for `handle`: newest first, at most `SEARCH_LIMIT`.
    pub fn search(&self, handle: &str, query: &str, only: Option<&Conversation>) -> Vec<Value> {
        let wanted = words(query);
        if wanted.is_empty() {
            return Vec::new();
        }
        let threads: Vec<&Thread> = match only {
            Some(conversation) => self.thread(conversation).into_iter().collect(),
            None => self.joined(handle).collect(),
        };
        let mut hits: Vec<(String, Value)> = threads
            .into_iter()
            .flat_map(|thread| thread.search(&wanted))
            .collect();
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        hits.into_iter()
            .take(SEARCH_LIMIT)
            .map(|(_, view)| view)
            .collect()
    }

    /// The people file a presence report leads to, and whether it is due: when the reporter's active/afk state
    /// changes it is written at once, otherwise at most every `REFRESH_MS`. A report without `projects` keeps the
    /// stored ones: the host lists them only when its refresh is due.
    pub fn presence_report(
        &mut self,
        handle: &str,
        projects: Option<Vec<String>>,
        idle_ms: Option<i64>,
        now: i64,
    ) -> Option<PersonFile> {
        let stored = self.people.get(handle).cloned();
        let reporter = self.reporters.entry(handle.to_owned()).or_default();
        reporter.active_at = reporter
            .active_at
            .max(stored.as_ref().map_or(0, |file| file.active_at));
        if let Some(idle) = idle_ms {
            reporter.active_at = reporter.active_at.max(now - idle);
        }
        let candidate = PersonFile {
            at: now,
            active_at: reporter.active_at,
            projects: projects
                .or_else(|| stored.as_ref().map(|file| file.projects.clone()))
                .unwrap_or_default(),
        };
        let refresh_due = reporter
            .people_written_at
            .is_none_or(|at| now - at >= REFRESH_MS);
        let changed = stored
            .as_ref()
            .is_none_or(|file| Presence::of(file, now) != Presence::of(&candidate, now));
        (refresh_due || changed).then_some(candidate)
    }

    /// The agents file a count leads to, when due: a change at once, the same count at most every `REFRESH_MS`.
    pub fn agents_report(&self, handle: &str, running: i64, now: i64) -> Option<AgentsFile> {
        let written_at = self
            .reporters
            .get(handle)
            .and_then(|reporter| reporter.agents_written_at);
        let same = self
            .agents
            .get(handle)
            .is_some_and(|file| file.running == Some(running));
        let due = !same || written_at.is_none_or(|at| now - at >= REFRESH_MS);
        due.then_some(AgentsFile {
            at: now,
            running: Some(running),
        })
    }

    pub fn wrote_person(&mut self, handle: &str, file: PersonFile, now: i64) {
        self.reporters
            .entry(handle.to_owned())
            .or_default()
            .people_written_at = Some(now);
        self.people.insert(handle.to_owned(), file);
    }

    pub fn wrote_agents(&mut self, handle: &str, file: AgentsFile, now: i64) {
        self.reporters
            .entry(handle.to_owned())
            .or_default()
            .agents_written_at = Some(now);
        self.agents.insert(handle.to_owned(), file);
    }

    /// Whether the people list differs from the one last announced; records it as announced.
    pub fn people_changed(&mut self, now: i64) -> bool {
        let shape = self.people_shape(now);
        if shape == self.announced {
            return false;
        }
        self.announced = shape;
        true
    }
}
