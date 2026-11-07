//! The chat broker's operations: check a request against the state, write the files it changes, then change the
//! state and announce it. One lock serializes every change, so keys, reads and files never race. A request is
//! answered only after its files are written.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use crate::classify::{self, Classification, Input};
use crate::clock::Clock;
use crate::delegation::{self, CATALOG};
use crate::error::ApiError;
use crate::events::Event;
use crate::image::{inspect_image, strip_metadata};
use crate::isotime::iso_ms;
use crate::limits::{AGENT_SEND_LIMIT, RateLimiter, SEND_LIMIT, UPLOAD_LIMIT};
use crate::log::Log;
use crate::metrics::{self, Counters, PollResult, Target};
use crate::model::{
    Attachment, Conversation, MAX_ATTACHMENTS, MAX_BODY_LENGTH, MAX_IMAGE_BYTES, Message, Priority,
    Status, Via, is_image_id, is_message_id, key_ms, message_key,
};
use crate::signals::{self, AUTHOR, Active, Alert, SignalFile};
use crate::state::{AssistantState, Focus, ImageMeta, PersonFile, State, Thread};
use crate::store::{self, Files};
use crate::text::{agent_mentions_in, is_blank, js_length, mentions_in};
use crate::watches::{self, Watch};

const EVENT_BUFFER: usize = 1024;

/// What `POST /v1/messages` carries, its fields already of the right types.
pub struct SendRequest {
    pub conversation: Conversation,
    pub id: String,
    pub body: String,
    pub attachments: Vec<String>,
    pub reply_to: Option<String>,
    pub via: Option<Via>,
    pub priority: Priority,
    /// The sending agent (`via.agentId`) waits for the replies.
    pub wait: bool,
    /// Where the request of the reply chain stands; only on a reply.
    pub status: Option<Status>,
}

/// A message checked and ready to write, with the agents whose watches it records.
struct Outgoing {
    conversation: Conversation,
    id: String,
    body: String,
    attachments: Vec<Attachment>,
    reply_to: Option<String>,
    via: Option<Via>,
    priority: Priority,
    wait: bool,
    status: Option<Status>,
    /// The sending agent, waiting for the replies.
    waiting_agent: Option<String>,
    /// The agents the person's message mentions.
    mentioned_agents: Vec<String>,
}

struct Inner {
    state: State,
    sends: RateLimiter,
    /// By conversation: what agents send there (`AGENT_SEND_LIMIT`).
    agent_sends: RateLimiter,
    uploads: RateLimiter,
    counters: Counters,
    /// By signal: its active alerts the last successful pull missed (`signals::step`). Kept in memory: after a restart
    /// an alert needs two misses again.
    missed: BTreeMap<String, BTreeSet<String>>,
}

pub struct Chat {
    files: Files,
    clock: Arc<dyn Clock>,
    log: Log,
    max_image_store_bytes: u64,
    inner: Mutex<Inner>,
    events: broadcast::Sender<Arc<Event>>,
    /// Event streams open now.
    streams: Arc<AtomicI64>,
}

/// Counts one open event stream for as long as it lives.
pub struct StreamCount(Arc<AtomicI64>);

impl Drop for StreamCount {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn signal_not_found() -> ApiError {
    ApiError::new(404, "signal_not_found", "Không có signal này.")
}

fn not_creator() -> ApiError {
    ApiError::new(403, "not_creator", "Chỉ người tạo signal mới xóa được.")
}

/// `Signal` as the API answers it, with what its room holds.
fn signal_view(state: &State, file: &SignalFile) -> Value {
    file.view(state.thread(&signals::conversation(&file.alert)))
}

pub fn not_a_member() -> ApiError {
    ApiError::new(
        403,
        "not_a_member",
        "Bạn không ở trong cuộc trò chuyện này.",
    )
}

/// Agents in a conversation sent more than `AGENT_SEND_LIMIT` allows. Read by the sending agent as its tool's error.
fn slow_down(wait_ms: i64) -> ApiError {
    let seconds = (wait_ms + 999) / 1000;
    ApiError::new(
        429,
        "slow_down",
        format!(
            "Các agent trong cuộc trò chuyện này đang nhắn quá nhanh, hãy nhắn chậm lại: \
             gửi lại tin này sau {seconds} giây, và gộp nhiều ý vào một tin."
        ),
    )
}

fn admit(conversation: &Conversation, me: &str) -> Result<(), ApiError> {
    if conversation.admits(me) {
        Ok(())
    } else {
        Err(not_a_member())
    }
}

/// The checks of a message that need nothing but the request, in the documented order.
pub fn check_message(id: &str, body: &str, attachments: &[String]) -> Result<(), ApiError> {
    if !is_message_id(id) {
        return Err(ApiError::new(400, "bad_id", "id không hợp lệ."));
    }
    if is_blank(body) && attachments.is_empty() {
        return Err(ApiError::new(400, "empty", "Tin nhắn trống."));
    }
    if js_length(body) > MAX_BODY_LENGTH {
        return Err(ApiError::new(
            400,
            "too_long",
            format!("Tin nhắn dài quá {MAX_BODY_LENGTH} ký tự."),
        ));
    }
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(ApiError::new(
            400,
            "too_many_images",
            format!("Mỗi tin kèm tối đa {MAX_ATTACHMENTS} ảnh."),
        ));
    }
    Ok(())
}

impl Chat {
    /// Load the chat under `root` into memory.
    pub fn open(
        root: impl Into<PathBuf>,
        clock: Arc<dyn Clock>,
        log: Log,
        max_image_store_bytes: u64,
    ) -> io::Result<Chat> {
        let files = Files::new(root);
        let mut state = store::load(files.root(), &log)?;
        let now = clock.now_ms();
        state.people_changed(now);
        let messages: usize = state.threads.values().map(|t| t.messages.len()).sum();
        log.info(format!(
            "loaded {} conversations, {messages} messages, {} people, {} images from {}",
            state.threads.len(),
            state.people.len(),
            state.images.len(),
            files.root().display()
        ));
        Ok(Chat {
            files,
            clock,
            log,
            max_image_store_bytes,
            inner: Mutex::new(Inner {
                state,
                sends: RateLimiter::new(SEND_LIMIT),
                agent_sends: RateLimiter::new(AGENT_SEND_LIMIT),
                uploads: RateLimiter::new(UPLOAD_LIMIT),
                counters: Counters::default(),
                missed: BTreeMap::new(),
            }),
            events: broadcast::channel(EVENT_BUFFER).0,
            streams: Arc::new(AtomicI64::new(0)),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.events.subscribe()
    }

    /// An event stream opened; it counts as open until the returned value is dropped.
    pub fn stream_opened(&self) -> StreamCount {
        self.streams.fetch_add(1, Ordering::SeqCst);
        StreamCount(self.streams.clone())
    }

    /// `GET /metrics`, in Prometheus' text format.
    pub fn metrics(&self) -> String {
        let inner = self.inner.lock();
        metrics::render(
            &inner.counters,
            &inner.state,
            self.streams.load(Ordering::SeqCst),
            self.now(),
        )
    }

    fn emit(&self, event: Event) {
        // No subscriber is not an error: nobody is listening right now.
        let _ = self.events.send(Arc::new(event));
    }

    fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    /// The chat's clock, for work that runs beside it.
    pub fn now_ms(&self) -> i64 {
        self.now()
    }

    /// Announce the people list when what it shows changed.
    fn announce_people(&self, state: &mut State) {
        if state.people_changed(self.now()) {
            self.emit(Event::people());
        }
    }

    /// Presence moves with time alone (active to afk to offline, agent counts going stale); called every few seconds.
    pub fn tick(&self) {
        let mut inner = self.inner.lock();
        self.announce_people(&mut inner.state);
    }

    /// Write the files naming a conversation that is not held yet, then hold it.
    fn ensure<'a>(
        &self,
        state: &'a mut State,
        conversation: &Conversation,
    ) -> Result<&'a mut Thread, ApiError> {
        if state.thread(conversation).is_none() {
            self.files
                .create_conversation(conversation)
                .map_err(|error| ApiError::io("the conversation files", &error))?;
        }
        Ok(state.thread_mut(conversation))
    }

    fn write_read(&self, thread: &mut Thread, me: &str, key: &str) -> Result<(), ApiError> {
        self.files
            .write_json(
                &format!("{}/reads/{me}.json", thread.conversation.dir()),
                &json!({ "key": key }),
            )
            .map_err(|error| ApiError::io("reads", &error))?;
        thread.reads.insert(me.to_owned(), key.to_owned());
        Ok(())
    }

    pub fn presence(
        &self,
        me: &str,
        projects: Option<Vec<String>>,
        idle_ms: Option<i64>,
    ) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        if let Some(file) = state.presence_report(me, projects, idle_ms, now) {
            self.files
                .write_json(&format!("people/{me}.json"), &file.json())
                .map_err(|error| ApiError::io("people", &error))?;
            state.wrote_person(me, file, now);
            self.announce_people(state);
        }
        Ok(json!({}))
    }

    pub fn agents(&self, me: &str, running: i64) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        if let Some(file) = state.agents_report(me, running, now) {
            self.files
                .write_json(
                    &format!("agents/{me}.json"),
                    &json!({"at": file.at, "running": running}),
                )
                .map_err(|error| ApiError::io("agents", &error))?;
            state.wrote_agents(me, file, now);
            self.announce_people(state);
        }
        Ok(json!({}))
    }

    /// List a handle in people/ before any client of theirs opens, so others can message them.
    pub fn register(&self, me: &str) -> Result<Value, ApiError> {
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        if !state.people.contains_key(me) {
            self.files
                .write_json(
                    &format!("people/{me}.json"),
                    &json!({"at": 0, "projects": []}),
                )
                .map_err(|error| ApiError::io("people", &error))?;
            state.people.insert(
                me.to_owned(),
                PersonFile {
                    at: 0,
                    active_at: 0,
                    projects: Vec::new(),
                },
            );
            self.announce_people(state);
        }
        Ok(json!({}))
    }

    pub fn inbox(&self, me: &str) -> Value {
        let now = self.now();
        let inner = self.inner.lock();
        let state = &inner.state;
        json!({
            "me": me,
            "conversations": state.summaries(me),
            "people": state.people(now),
            "focus": state.focus.get(me).map_or(Value::Null, |focus| json!(focus)),
        })
    }

    pub fn people(&self) -> Value {
        let now = self.now();
        Value::Array(self.inner.lock().state.people(now))
    }

    pub fn conversations(&self, me: &str) -> Value {
        let inner = self.inner.lock();
        Value::Array(
            inner
                .state
                .joined(me)
                .map(|thread| Value::String(thread.conversation.id()))
                .collect(),
        )
    }

    pub fn messages(
        &self,
        me: &str,
        conversation: &Conversation,
        after: &str,
        limit: usize,
    ) -> Result<Value, ApiError> {
        admit(conversation, me)?;
        let inner = self.inner.lock();
        let messages = inner
            .state
            .thread(conversation)
            .map(|thread| thread.after(after, limit))
            .unwrap_or_default();
        Ok(json!({ "messages": messages }))
    }

    pub fn latest(
        &self,
        me: &str,
        conversation: &Conversation,
        limit: usize,
    ) -> Result<Value, ApiError> {
        admit(conversation, me)?;
        let inner = self.inner.lock();
        let messages = inner
            .state
            .thread(conversation)
            .map(|thread| thread.latest(limit))
            .unwrap_or_default();
        Ok(json!({ "messages": messages }))
    }

    /// Send a message. Retrying with the same id returns the stored message instead of writing a second one.
    pub fn send(&self, me: &str, request: SendRequest) -> Result<Value, ApiError> {
        let SendRequest {
            conversation,
            id,
            body,
            attachments,
            reply_to,
            via,
            priority,
            wait,
            status,
        } = request;
        check_message(&id, &body, &attachments)?;
        if status.is_some() && reply_to.is_none() {
            return Err(ApiError::bad_request(
                "status chỉ dùng cho tin trả lời một yêu cầu (replyTo).",
            ));
        }
        if wait && status.is_some_and(Status::closes) {
            return Err(ApiError::bad_request(
                "Tin đóng yêu cầu (completed, failed, canceled) không chờ trả lời được.",
            ));
        }
        let waiting_agent = match (&via, wait) {
            (_, false) => None,
            (
                Some(Via {
                    agent_id: Some(agent),
                    ..
                }),
                true,
            ) => Some(agent.clone()),
            (_, true) => {
                return Err(ApiError::bad_request(
                    "Chỉ tin agent gửi (via.agentId) mới chờ được trả lời.",
                ));
            }
        };
        // A person's mention hands the message to the agent; agents do not prompt each other through mentions.
        let mentioned_agents = if via.is_none() {
            agent_mentions_in(&body)
        } else {
            Vec::new()
        };
        admit(&conversation, me)?;
        let mut inner = self.inner.lock();
        let Inner {
            state,
            sends,
            agent_sends,
            ..
        } = &mut *inner;
        if let Some(thread) = state.thread(&conversation)
            && let Some(existing) = thread.by_id(&id)
        {
            if existing.author != me
                || existing.body != body
                || existing.priority != priority
                || existing.status != status
            {
                return Err(ApiError::new(
                    409,
                    "id_taken",
                    "id đã được dùng cho tin khác.",
                ));
            }
            return Ok(json!({ "message": thread.view(existing) }));
        }
        if let Some(reply_to) = &reply_to
            && !state
                .thread(&conversation)
                .is_some_and(|thread| thread.messages.contains_key(reply_to))
        {
            return Err(ApiError::new(
                400,
                "reply_not_found",
                "Không tìm thấy tin được trả lời.",
            ));
        }
        if let Some(reply_to) = &reply_to
            && status.is_some()
            && !state
                .thread(&conversation)
                .is_some_and(|thread| thread.request_of.contains_key(reply_to))
        {
            return Err(ApiError::new(
                400,
                "not_a_request",
                "Tin được trả lời không thuộc yêu cầu nào, nên không có status để báo.",
            ));
        }
        let now = self.now();
        if sends.take(me, now).is_err() {
            return Err(ApiError::new(
                429,
                "rate_limited",
                "Gửi quá nhanh, hãy thử lại sau ít giây.",
            ));
        }
        if via.is_some()
            && let Err(wait_ms) = agent_sends.take(&conversation.id(), now)
        {
            return Err(slow_down(wait_ms));
        }
        let attachments = attachments
            .iter()
            .map(|attachment| {
                let meta = state
                    .images
                    .get(attachment)
                    .filter(|_| is_image_id(attachment))?;
                Some(Attachment {
                    id: attachment.clone(),
                    mime: meta.mime.clone(),
                    width: meta.width,
                    height: meta.height,
                })
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| ApiError::new(400, "image_missing", "Ảnh chưa được tải lên."))?;
        let key = self.write_message(
            &mut inner,
            me,
            Outgoing {
                conversation: conversation.clone(),
                id,
                body,
                attachments,
                reply_to,
                via,
                priority,
                wait,
                status,
                waiting_agent,
                mentioned_agents,
            },
            now,
        )?;
        let thread = inner
            .state
            .thread(&conversation)
            .expect("the conversation was just written to");
        Ok(json!({ "message": thread.view(&thread.messages[&key]) }))
    }

    /// Write a checked message as `me` and announce it; its key. The one path every message takes: its watches,
    /// its file, `me`'s read cursor, who it mentions, then the `message` event and `deliveries` for every handle with
    /// a live watch in the conversation.
    fn write_message(
        &self,
        inner: &mut Inner,
        me: &str,
        outgoing: Outgoing,
        now: i64,
    ) -> Result<String, ApiError> {
        let Outgoing {
            conversation,
            id,
            body,
            attachments,
            reply_to,
            via,
            priority,
            wait,
            status,
            waiting_agent,
            mentioned_agents,
        } = outgoing;
        let state = &mut inner.state;
        let known_people: Vec<String> = if conversation.is_dm() {
            Vec::new()
        } else {
            mentions_in(&body)
                .into_iter()
                .filter(|handle| handle != me && state.people.contains_key(handle))
                .collect()
        };
        let ms = state
            .thread(&conversation)
            .map_or(now, |thread| thread.next_ms(now));
        let key = message_key(ms, &id);
        // Written before the message: a retry after a failed write finds no message and records the watch again.
        if waiting_agent.is_some() || !mentioned_agents.is_empty() {
            let mut list = state.watches.get(me).cloned().unwrap_or_default();
            if let Some(agent) = &waiting_agent {
                watches::sent(&mut list, agent, &conversation, &key, now);
            }
            for agent in &mentioned_agents {
                watches::mentioned(&mut list, agent, &conversation, &key, now);
            }
            self.save_watches(state, me, list, now)?;
        }
        let thread = self.ensure(state, &conversation)?;
        let message = Message {
            key: key.clone(),
            id,
            author: me.to_owned(),
            body,
            created_at: iso_ms(ms).unwrap_or_default(),
            attachments,
            reply_to,
            via,
            priority,
            wait,
            status,
        };
        let dir = conversation.dir();
        self.files
            .write_json(
                &format!("{dir}/messages/{key}.json"),
                &serde_json::to_value(&message).expect("a message serializes"),
            )
            .map_err(|error| ApiError::io("the message", &error))?;
        thread.insert(message);
        inner.counters.messages_sent += 1;
        if thread.last_read(me) < key.as_str() {
            self.write_read(thread, me, &key)?;
        }
        // A room's reads/ file is its own person's; a mention marks someone who never opened the room.
        for handle in known_people {
            self.files
                .write_json(
                    &format!("{dir}/invited/{handle}.json"),
                    &json!({"by": me, "at": now}),
                )
                .map_err(|error| ApiError::io("invited", &error))?;
            thread.invited.insert(handle);
        }
        self.emit(Event::message(&conversation, &key, me));
        for (handle, list) in &state.watches {
            if watches::waits_on(list, handle, &conversation, now, state) {
                self.emit(Event::deliveries(handle));
            }
        }
        Ok(key)
    }

    /// Writes `me`'s watches, without those that no longer wait.
    fn save_watches(
        &self,
        state: &mut State,
        me: &str,
        mut list: Vec<Watch>,
        now: i64,
    ) -> Result<(), ApiError> {
        watches::prune(&mut list, me, now, state);
        self.files
            .write_json(&format!("watches/{me}.json"), &json!(list))
            .map_err(|error| ApiError::io("watches", &error))?;
        state.watches.insert(me.to_owned(), list);
        Ok(())
    }

    /// What is due to the agents of `me`'s host, by agent and conversation.
    pub fn deliveries(&self, me: &str) -> Value {
        let inner = self.inner.lock();
        let list = inner.state.watches.get(me).map_or(&[][..], Vec::as_slice);
        json!({ "deliveries": watches::due(list, me, self.now(), &inner.state) })
    }

    /// The agent got the messages of `conversation` up to `through`.
    pub fn delivered(
        &self,
        me: &str,
        agent: &str,
        conversation: &Conversation,
        through: &str,
    ) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let Inner {
            state, counters, ..
        } = &mut *inner;
        let mut list = state.watches.get(me).cloned().unwrap_or_default();
        let id = conversation.id();
        let before = list
            .iter()
            .find(|watch| watch.agent == agent && watch.conversation == id)
            .map(|watch| watch.after.clone());
        if watches::delivered(&mut list, agent, conversation, through) {
            self.save_watches(state, me, list, now)?;
            if let Some(after) = before {
                let passed = signals::messages_between(state, conversation, &after, through);
                counters.delivered(Target::Agent, &passed, now);
            }
        }
        Ok(json!({}))
    }

    /// The agent is gone from `me`'s host: nothing more of `conversation` is due to it. When `me` subscribed it to
    /// the signal of `conversation`, the subscription goes to `me`'s AI Assistant first.
    pub fn end_watch(
        &self,
        me: &str,
        agent: &str,
        conversation: &Conversation,
    ) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let Inner {
            state, counters, ..
        } = &mut *inner;
        if let Some(alert) = signals::alert_of(conversation)
            && let Some(mut file) = state.signals.get(alert).cloned()
            && file.hand_over(me, agent, now)
        {
            self.write_signal(state, file)?;
            counters.handover(alert);
        }
        let mut list = state.watches.get(me).cloned().unwrap_or_default();
        if watches::end(&mut list, agent, conversation) {
            self.save_watches(state, me, list, now)?;
        }
        Ok(json!({}))
    }

    /// Write a signal's file, then hold it.
    fn write_signal(&self, state: &mut State, file: SignalFile) -> Result<(), ApiError> {
        self.files
            .write_json(&format!("signals/{}.json", file.alert), &file.json())
            .map_err(|error| ApiError::io("the signal", &error))?;
        state.signals.insert(file.alert.clone(), file);
        Ok(())
    }

    /// Writes the watches of each of `handles` that has some, without those no longer held: after a subscription
    /// stopped naming an agent.
    fn prune_watches(
        &self,
        state: &mut State,
        handles: &[String],
        now: i64,
    ) -> Result<(), ApiError> {
        for handle in handles {
            if let Some(list) = state.watches.get(handle).cloned() {
                self.save_watches(state, handle, list, now)?;
            }
        }
        Ok(())
    }

    /// Create a signal: its file, with no subscription and nothing firing. `{ signal }`.
    pub fn register_signal(&self, me: &str, alert: &str) -> Result<Value, ApiError> {
        if !signals::is_alert(alert) {
            return Err(ApiError::new(
                400,
                "bad_alert",
                "Tên signal chỉ gồm chữ thường, số và dấu gạch ngang, tối đa 63 ký tự.",
            ));
        }
        let now = self.now();
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        if state.signals.contains_key(alert) {
            return Err(ApiError::new(409, "signal_exists", "Signal này đã có."));
        }
        let file = SignalFile::new(alert, me, now);
        let view = signal_view(state, &file);
        self.write_signal(state, file)?;
        Ok(json!({ "signal": view }))
    }

    /// Delete a signal, its subscriptions and what it holds as firing; its room keeps its messages. Only its creator.
    pub fn delete_signal(&self, me: &str, alert: &str) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        inner.missed.remove(alert);
        let state = &mut inner.state;
        let file = state.signals.get(alert).ok_or_else(signal_not_found)?;
        if file.created_by != me {
            return Err(not_creator());
        }
        let handles: Vec<String> = file
            .subscriptions
            .iter()
            .map(|subscription| subscription.handle.clone())
            .collect();
        self.files
            .remove(&format!("signals/{alert}.json"))
            .map_err(|error| ApiError::io("the signal", &error))?;
        state.signals.remove(alert);
        self.prune_watches(state, &handles, now)?;
        Ok(json!({}))
    }

    /// Every signal, by name. Everyone sees every signal.
    pub fn signals(&self) -> Value {
        let inner = self.inner.lock();
        let state = &inner.state;
        let views: Vec<Value> = state
            .signals
            .values()
            .map(|file| signal_view(state, file))
            .collect();
        json!({ "signals": views })
    }

    /// `me` listens to the signal: through `agent`, whose watch on the room lives as long as the subscription names
    /// it, or through `me`'s AI Assistant when None. Replaces `me`'s earlier subscription.
    pub fn subscribe_signal(
        &self,
        me: &str,
        alert: &str,
        agent: Option<String>,
    ) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        let mut file = state
            .signals
            .get(alert)
            .cloned()
            .ok_or_else(signal_not_found)?;
        file.subscribe(me, agent.clone(), now);
        // Held before the watch is written: saving prunes every watch nothing holds.
        self.write_signal(state, file)?;
        match &agent {
            Some(agent) => {
                let conversation = signals::conversation(alert);
                let last = state
                    .thread(&conversation)
                    .and_then(Thread::last_key)
                    .unwrap_or_default()
                    .to_owned();
                let mut list = state.watches.get(me).cloned().unwrap_or_default();
                watches::subscribed(&mut list, agent, &conversation, &last);
                self.save_watches(state, me, list, now)?;
            }
            None => self.prune_watches(state, &[me.to_owned()], now)?,
        }
        Ok(json!({ "signal": signal_view(state, &state.signals[alert]) }))
    }

    /// `me` stops listening to the signal; nothing changes when it was not.
    pub fn unsubscribe_signal(&self, me: &str, alert: &str) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        let mut file = state
            .signals
            .get(alert)
            .cloned()
            .ok_or_else(signal_not_found)?;
        if file.unsubscribe(me) {
            self.write_signal(state, file)?;
            self.prune_watches(state, &[me.to_owned()], now)?;
        }
        Ok(json!({ "signal": signal_view(state, &state.signals[alert]) }))
    }

    /// A pull of Grafana's alerts ended: with its alerts, or None when it failed. A failed pull changes nothing but
    /// its counter, so it never counts toward resolving an alert. A successful one routes each alert to the signal its
    /// `signal` label names and takes every signal one step (`signals::step`).
    pub fn pulled(&self, alerts: Option<&[Alert]>) -> Result<(), ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        let Some(alerts) = alerts else {
            inner.counters.poll(PollResult::Error);
            return Ok(());
        };
        inner.counters.poll(PollResult::Ok);
        inner.counters.last_poll_success_ms = Some(now);
        let routed = signals::route(alerts, |name| inner.state.signals.contains_key(name));
        inner.counters.unrouted_alerts = routed.unrouted;
        let names: Vec<String> = inner.state.signals.keys().cloned().collect();
        let none = BTreeMap::new();
        // A signal whose step cannot be stored is counted and left for the next pull; the others still step.
        let mut first_error = None;
        for name in names {
            let present = routed.by_signal.get(&name).unwrap_or(&none);
            if let Err(error) = self.step_signal(&mut inner, &name, present, now) {
                inner.counters.store_error(&name);
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// One signal's step after a successful pull: the firing message of its new alerts, a resolved message per firing
    /// message whose alerts are gone, then its file and its misses. The messages go first: a step repeated after a
    /// failed write derives the same ids and finds them.
    fn step_signal(
        &self,
        inner: &mut Inner,
        name: &str,
        present: &BTreeMap<String, &Alert>,
        now: i64,
    ) -> Result<(), ApiError> {
        let mut file = inner.state.signals[name].clone();
        let missed = inner.missed.get(name).cloned().unwrap_or_default();
        let step = signals::step(&file.active, &missed, present);
        let conversation = signals::conversation(name);
        let changed = !step.fired.is_empty() || !step.resolved.is_empty();
        if !step.fired.is_empty() {
            let (key, written) = self.write_signal_message(
                inner,
                &conversation,
                signals::firing(&file, &step.fired),
                None,
                now,
            )?;
            if written {
                inner.counters.signal_message(name, "firing");
            }
            for alert in &step.fired {
                file.active.insert(
                    alert.fingerprint.clone(),
                    Active {
                        message: key.clone(),
                        starts_at: alert.starts_at.clone(),
                        alertname: alert.labels.get("alertname").cloned().unwrap_or_default(),
                    },
                );
            }
        }
        for (firing_key, fingerprints) in &step.resolved {
            let planned = signals::resolved(firing_key, fingerprints, &file.active);
            let reply_to = inner
                .state
                .thread(&conversation)
                .filter(|thread| thread.messages.contains_key(firing_key))
                .map(|_| firing_key.clone());
            let (_, written) =
                self.write_signal_message(inner, &conversation, planned, reply_to, now)?;
            if written {
                inner.counters.signal_message(name, "resolved");
            }
            for fingerprint in fingerprints {
                file.active.remove(fingerprint);
            }
        }
        if changed {
            self.write_signal(&mut inner.state, file)?;
        }
        if step.missed.is_empty() {
            inner.missed.remove(name);
        } else {
            inner.missed.insert(name.to_owned(), step.missed);
        }
        Ok(())
    }

    /// Write a signal message through the path every message takes, unless its id is already in the room. Its key,
    /// and whether it was written now.
    fn write_signal_message(
        &self,
        inner: &mut Inner,
        conversation: &Conversation,
        planned: signals::Planned,
        reply_to: Option<String>,
        now: i64,
    ) -> Result<(String, bool), ApiError> {
        if let Some(existing) = inner
            .state
            .thread(conversation)
            .and_then(|thread| thread.by_id(&planned.id))
        {
            return Ok((existing.key.clone(), false));
        }
        let key = self.write_message(
            inner,
            AUTHOR,
            Outgoing {
                conversation: conversation.clone(),
                id: planned.id,
                body: planned.body,
                attachments: Vec::new(),
                reply_to,
                via: None,
                priority: Priority::Normal,
                wait: false,
                status: None,
                waiting_agent: None,
                mentioned_agents: Vec::new(),
            },
            now,
        )?;
        Ok((key, true))
    }

    /// A stored message with what the classifier reads around it; None when it needs no classification.
    pub fn classification_input(&self, conversation: &Conversation, key: &str) -> Option<Input> {
        let inner = self.inner.lock();
        classify::input(inner.state.thread(conversation)?, key)
    }

    /// Messages sent at or after `since_ms` that still need a classification, oldest first in each conversation.
    pub fn unclassified_since(&self, since_ms: i64) -> Vec<(Conversation, String)> {
        let inner = self.inner.lock();
        inner
            .state
            .threads
            .values()
            .flat_map(|thread| {
                thread
                    .messages
                    .keys()
                    .filter(|key| key_ms(key) >= since_ms)
                    .filter(|key| classify::input(thread, key).is_some())
                    .map(|key| (thread.conversation.clone(), key.clone()))
            })
            .collect()
    }

    /// Store what the classifier made of a message and announce it. A message already classified keeps its first
    /// classification.
    pub fn classified(
        &self,
        conversation: &Conversation,
        key: &str,
        classification: Classification,
    ) -> Result<(), ApiError> {
        let mut inner = self.inner.lock();
        let Some(thread) = inner.state.threads.get_mut(&conversation.id()) else {
            return Ok(());
        };
        if !thread.messages.contains_key(key) || thread.classifications.contains_key(key) {
            return Ok(());
        }
        self.files
            .write_json(
                &format!("{}/classifications/{key}.json", conversation.dir()),
                &json!(classification),
            )
            .map_err(|error| ApiError::io("the classification", &error))?;
        self.emit(Event::classified(conversation, key, &classification));
        let message = &thread.messages[key];
        let find = |key: &str| thread.messages.get(key);
        let breach =
            delegation::breach(&CATALOG, message, classification.decision.as_deref(), find)
                .then(|| message.author.clone());
        let decision = classification.decision.clone().unwrap_or_default();
        thread
            .classifications
            .insert(key.to_owned(), classification);
        if let Some(author) = breach {
            self.emit(Event::delegation(&author, conversation, key, &decision));
            inner.counters.delegation_breach(&author);
        }
        Ok(())
    }

    /// Mark read up to `key`, or the newest message; never moves the cursor back, nor past the newest message.
    pub fn read(
        &self,
        me: &str,
        conversation: &Conversation,
        key: Option<&str>,
    ) -> Result<Value, ApiError> {
        admit(conversation, me)?;
        let mut inner = self.inner.lock();
        let Some(thread) = inner.state.threads.get_mut(&conversation.id()) else {
            return Ok(json!({}));
        };
        let Some(newest) = thread.last_key().map(str::to_owned) else {
            return Ok(json!({}));
        };
        let wanted = key.map_or(newest.as_str(), |key| key.min(newest.as_str()));
        if wanted <= thread.last_read(me) {
            return Ok(json!({}));
        }
        let wanted = wanted.to_owned();
        self.write_read(thread, me, &wanted)?;
        self.emit(Event::read(me, conversation, &wanted));
        Ok(json!({}))
    }

    /// Opening a conversation joins it, so it is listed from then on, even before anyone writes in it.
    pub fn join(&self, me: &str, conversation: &Conversation) -> Result<Value, ApiError> {
        admit(conversation, me)?;
        let mut inner = self.inner.lock();
        let thread = self.ensure(&mut inner.state, conversation)?;
        if !thread.reads.contains_key(me) {
            self.write_read(thread, me, "")?;
        }
        Ok(json!({}))
    }

    /// Ask every open client of this handle to show the conversation.
    pub fn focus(&self, me: &str, conversation: &Conversation) -> Result<Value, ApiError> {
        admit(conversation, me)?;
        let focus = Focus {
            conversation: conversation.id(),
            at: self.now(),
        };
        let mut inner = self.inner.lock();
        self.files
            .write_json(&format!("focus/{me}.json"), &json!(focus))
            .map_err(|error| ApiError::io("focus", &error))?;
        self.emit(Event::focus(me, &focus.conversation, focus.at));
        inner.state.focus.insert(me.to_owned(), focus);
        Ok(json!({}))
    }

    pub fn assistant(&self, me: &str) -> Value {
        self.inner
            .lock()
            .state
            .assistant
            .get(me)
            .map_or(Value::Null, |state| json!(state))
    }

    /// Store `me`'s AI Assistant state; the signal messages its cursors passed in the signals it subscribes to count as
    /// delivered to an AI Assistant.
    pub fn save_assistant(&self, me: &str, assistant: AssistantState) -> Result<Value, ApiError> {
        let now = self.now();
        let mut inner = self.inner.lock();
        self.files
            .write_json(&format!("assistant/{me}.json"), &json!(assistant))
            .map_err(|error| ApiError::io("assistant", &error))?;
        let passed =
            metrics::assistant_passed(me, inner.state.assistant.get(me), &assistant, &inner.state);
        inner.counters.delivered(Target::Assistant, &passed, now);
        inner.state.assistant.insert(me.to_owned(), assistant);
        Ok(json!({}))
    }

    pub fn search(
        &self,
        me: &str,
        query: &str,
        only: Option<&Conversation>,
    ) -> Result<Value, ApiError> {
        if let Some(conversation) = only {
            admit(conversation, me)?;
        }
        let inner = self.inner.lock();
        Ok(json!({ "messages": inner.state.search(me, query, only) }))
    }

    /// Store an image: type from its bytes, metadata stripped, named by the SHA-256 of what is stored.
    pub fn upload(&self, me: &str, data: &[u8]) -> Result<Value, ApiError> {
        if self.inner.lock().uploads.take(me, self.now()).is_err() {
            return Err(ApiError::new(
                429,
                "rate_limited",
                "Tải ảnh quá nhanh, hãy thử lại sau ít giây.",
            ));
        }
        if data.len() > MAX_IMAGE_BYTES {
            return Err(ApiError::new(
                413,
                "too_large",
                format!("Ảnh lớn hơn {} MB.", MAX_IMAGE_BYTES / 1024 / 1024),
            ));
        }
        let info = inspect_image(data).ok_or_else(|| {
            ApiError::new(
                400,
                "not_an_image",
                "Chỉ nhận ảnh PNG, JPEG, WebP hoặc GIF.",
            )
        })?;
        let stored = strip_metadata(data, info.mime);
        let id = hex::encode(Sha256::digest(&stored));
        let attachment = json!({
            "attachment": {"id": id, "mime": info.mime.as_str(), "width": info.width, "height": info.height},
        });
        let mut inner = self.inner.lock();
        let state = &mut inner.state;
        if state.images.contains_key(&id) {
            return Ok(attachment);
        }
        let size = stored.len() as u64;
        if state.image_bytes + size > self.max_image_store_bytes {
            return Err(ApiError::new(
                507,
                "store_full",
                "Kho ảnh chat đã đầy. Liên hệ quản trị viên.",
            ));
        }
        let meta = ImageMeta {
            mime: info.mime.as_str().to_owned(),
            width: i64::from(info.width),
            height: i64::from(info.height),
            size,
        };
        let existed = self.files.exists(&format!("images/{id}"));
        self.files
            .write(&format!("images/{id}"), &stored)
            .map_err(|error| ApiError::io("the image", &error))?;
        if !existed {
            state.image_bytes += size;
        }
        self.files
            .write_json(&format!("images/{id}.json"), &json!(meta))
            .map_err(|error| ApiError::io("the image metadata", &error))?;
        state.images.insert(id, meta);
        Ok(attachment)
    }

    /// A stored image's type and bytes; None when it is not stored.
    pub fn image(&self, id: &str) -> Result<Option<(String, Vec<u8>)>, ApiError> {
        if !is_image_id(id) {
            return Err(ApiError::new(400, "bad_image", "Ảnh không hợp lệ."));
        }
        let Some(mime) = self
            .inner
            .lock()
            .state
            .images
            .get(id)
            .map(|meta| meta.mime.clone())
        else {
            return Ok(None);
        };
        match self.files.read(&format!("images/{id}")) {
            Ok(bytes) => Ok(Some((mime, bytes))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.log
                    .warning(format!("images/{id} has metadata but no bytes"));
                Ok(None)
            }
            Err(error) => Err(ApiError::Internal(format!(
                "images/{id} could not be read ({})",
                error.kind()
            ))),
        }
    }
}
