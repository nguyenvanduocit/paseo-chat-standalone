//! Signals: a room `room:signals/<name>` that gets the Grafana alerts labelled `signal=<name>`,
//! and who subscribes to it. Each successful pull is compared with the alerts a signal already announced: the new ones
//! share one firing message, and those missing from two successful pulls in a row share one resolved message per
//! firing message, replying to it. A subscription with an agent keeps that agent's watch alive in the room; one without
//! hands the room to the person's AI Assistant. Pure: no clock, no disk, no network.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::model::{Conversation, is_agent_id, is_handle, is_message_key, key_ms};
use crate::state::{State, Thread};
use crate::text::js_length;

/// The project every signal room lives in.
pub const PROJECT: &str = "signals";
/// Who signal messages are written as.
pub const AUTHOR: &str = "grafana";
/// The label that routes an alert to the signal of its value.
pub const LABEL: &str = "signal";
/// The largest answer of Grafana's alert list.
pub const MAX_ALERTS_BODY: u64 = 5 * 1024 * 1024;
/// Alerts one message lists a line each; the rest share one more line.
pub const MAX_LINES: usize = 20;
/// The longest message, in JavaScript characters, as every message.
const MAX_MESSAGE_BODY: usize = crate::model::MAX_BODY_LENGTH;
/// Labels shown on an alert's line besides `alertname` and `signal`.
const MAX_LABELS: usize = 4;
/// The longest label or value shown inside a code span.
const MAX_CODE_LENGTH: usize = 200;
/// The longest summary on an alert's line.
const MAX_SUMMARY_LENGTH: usize = 300;
/// The longest fingerprint a signal file holds; Grafana's are 16 hex characters.
const MAX_FINGERPRINT_LENGTH: usize = 64;

static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,62}$").expect("a fixed pattern compiles"));

pub fn is_alert(text: &str) -> bool {
    NAME.is_match(text)
}

/// The room of a signal.
pub fn conversation(alert: &str) -> Conversation {
    Conversation::room(PROJECT, alert).expect("a signal name is a valid room name")
}

/// The signal whose room `conversation` is, if it is one.
pub fn alert_of(conversation: &Conversation) -> Option<&str> {
    match conversation {
        Conversation::Room { project, room } if project == PROJECT && is_alert(room) => Some(room),
        _ => None,
    }
}

/// One handle listening to a signal: `agent` is the Paseo agent that gets it, None for the handle's AI Assistant.
/// `handed_over_at`: when the agent was found gone and the AI Assistant took over (ms).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subscription {
    pub handle: String,
    pub agent: Option<String>,
    pub at: i64,
    #[serde(rename = "handedOverAt")]
    pub handed_over_at: Option<i64>,
}

/// An alert a signal announced as firing and has not announced resolved: the key of the firing message that listed
/// it, and what its resolved line shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Active {
    pub message: String,
    #[serde(rename = "startsAt")]
    pub starts_at: String,
    pub alertname: String,
}

/// `signals/<alert>.json`. `active`: the firing alerts, by fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalFile {
    pub alert: String,
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub subscriptions: Vec<Subscription>,
    /// A file written before signals pulled alerts has none: nothing announced is firing.
    #[serde(default)]
    pub active: BTreeMap<String, Active>,
}

fn is_fingerprint(text: &str) -> bool {
    !text.is_empty() && text.len() <= MAX_FINGERPRINT_LENGTH
}

impl SignalFile {
    pub fn new(alert: &str, created_by: &str, created_at: i64) -> SignalFile {
        SignalFile {
            alert: alert.to_owned(),
            created_by: created_by.to_owned(),
            created_at,
            subscriptions: Vec::new(),
            active: BTreeMap::new(),
        }
    }

    /// A signal file as stored, or None when it is not one: a valid name and creator, at most one subscription per
    /// handle, and every active alert held by a message key.
    pub fn parse(value: Value) -> Option<SignalFile> {
        let file: SignalFile = serde_json::from_value(value).ok()?;
        let mut handles = BTreeSet::new();
        let valid = is_alert(&file.alert)
            && is_handle(&file.created_by)
            && file.subscriptions.iter().all(|subscription| {
                is_handle(&subscription.handle)
                    && subscription.agent.as_deref().is_none_or(is_agent_id)
                    && handles.insert(subscription.handle.as_str())
            })
            && file.active.iter().all(|(fingerprint, active)| {
                is_fingerprint(fingerprint) && is_message_key(&active.message)
            });
        valid.then_some(file)
    }

    pub fn json(&self) -> Value {
        json!(self)
    }

    pub fn subscription(&self, handle: &str) -> Option<&Subscription> {
        self.subscriptions
            .iter()
            .find(|subscription| subscription.handle == handle)
    }

    /// Sets `handle`'s subscription, replacing the one it had.
    pub fn subscribe(&mut self, handle: &str, agent: Option<String>, now: i64) {
        self.unsubscribe(handle);
        self.subscriptions.push(Subscription {
            handle: handle.to_owned(),
            agent,
            at: now,
            handed_over_at: None,
        });
    }

    /// Drops `handle`'s subscription; returns whether there was one.
    pub fn unsubscribe(&mut self, handle: &str) -> bool {
        let before = self.subscriptions.len();
        self.subscriptions
            .retain(|subscription| subscription.handle != handle);
        self.subscriptions.len() != before
    }

    /// `agent` of `handle` is gone: its subscription goes to the handle's AI Assistant. Returns whether one did.
    pub fn hand_over(&mut self, handle: &str, agent: &str, now: i64) -> bool {
        let Some(subscription) = self.subscriptions.iter_mut().find(|subscription| {
            subscription.handle == handle && subscription.agent.as_deref() == Some(agent)
        }) else {
            return false;
        };
        subscription.agent = None;
        subscription.handed_over_at = Some(now);
        true
    }

    /// `Signal` as the API answers it. `firing`: the alerts firing now; `lastChangeAt`: when the signal last wrote a
    /// firing or resolved message, since it was created (its room keeps the messages of a deleted signal of that name).
    pub fn view(&self, thread: Option<&Thread>) -> Value {
        let last_change_at = thread.and_then(|thread| {
            thread
                .messages
                .values()
                .rev()
                .take_while(|message| key_ms(&message.key) >= self.created_at)
                .find(|message| message.author == AUTHOR)
                .map(|message| key_ms(&message.key))
        });
        json!({
            "alert": self.alert,
            "conversation": conversation(&self.alert).id(),
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "firing": self.active.len(),
            "lastChangeAt": last_change_at,
            "subscriptions": self.subscriptions,
        })
    }
}

/// Whether `me` subscribed `agent` to the signal of `conversation` (a conversation id): its watch there lives on and
/// every signal message there concerns it.
pub fn holds(state: &State, me: &str, agent: &str, conversation: &str) -> bool {
    Conversation::parse(conversation)
        .as_ref()
        .and_then(alert_of)
        .and_then(|alert| state.signals.get(alert))
        .and_then(|file| file.subscription(me))
        .is_some_and(|subscription| subscription.agent.as_deref() == Some(agent))
}

/// The send times of the signal messages in signal room `conversation` keyed after `after`, up to `through`: what a
/// cursor moving from one to the other passes over.
pub fn messages_between(
    state: &State,
    conversation: &Conversation,
    after: &str,
    through: &str,
) -> Vec<i64> {
    use std::ops::Bound::{Excluded, Included};
    if alert_of(conversation).is_none() || through <= after {
        return Vec::new();
    }
    state.thread(conversation).map_or_else(Vec::new, |thread| {
        thread
            .messages
            .range::<str, _>((Excluded(after), Included(through)))
            .filter(|(_, message)| message.author == AUTHOR)
            .map(|(key, _)| key_ms(key))
            .collect()
    })
}

/// An alert of Grafana's Alertmanager API (`GET /api/alertmanager/grafana/api/v2/alerts`): the fields a message is
/// made of. Unknown fields are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Alert {
    pub fingerprint: String,
    #[serde(rename = "startsAt")]
    pub starts_at: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
    #[serde(rename = "generatorURL", default)]
    pub generator_url: Option<String>,
}

impl Alert {
    fn name(&self) -> &str {
        self.labels.get("alertname").map_or("", String::as_str)
    }
}

/// The alerts of Grafana's answer; None when it is not a JSON list whose every element has a fingerprint, a start
/// time and string maps of labels and annotations. A pull that gets None counts as failed, so a broken answer never
/// reads as every alert resolved.
pub fn parse_alerts(raw: &[u8]) -> Option<Vec<Alert>> {
    let alerts: Vec<Alert> = serde_json::from_slice(raw).ok()?;
    alerts
        .iter()
        .all(|alert| is_fingerprint(&alert.fingerprint) && !alert.starts_at.is_empty())
        .then_some(alerts)
}

/// A pull's alerts by the signal their `signal` label names, each signal's by fingerprint; `unrouted` counts those
/// whose label names no signal `known` has.
#[derive(Debug, Default)]
pub struct Routed<'a> {
    pub by_signal: BTreeMap<String, BTreeMap<String, &'a Alert>>,
    pub unrouted: usize,
}

pub fn route<'a>(alerts: &'a [Alert], known: impl Fn(&str) -> bool) -> Routed<'a> {
    let mut routed = Routed::default();
    for alert in alerts {
        match alert.labels.get(LABEL) {
            Some(name) if known(name) => {
                routed
                    .by_signal
                    .entry(name.clone())
                    .or_default()
                    .insert(alert.fingerprint.clone(), alert);
            }
            _ => routed.unrouted += 1,
        }
    }
    routed
}

/// What one successful pull changes for one signal.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Step<'a> {
    /// Present and not active: they share one firing message. By fingerprint.
    pub fired: Vec<&'a Alert>,
    /// Active and missing from this pull and the one before it: by the key of the firing message that listed them,
    /// their fingerprints.
    pub resolved: BTreeMap<String, Vec<String>>,
    /// Active and missing from this pull only: the next successful pull that misses them resolves them.
    pub missed: BTreeSet<String>,
}

/// One signal's step after a successful pull. `active`: what it announced as firing; `missed`: which of those the
/// previous successful pull missed; `present`: this pull's alerts of the signal, by fingerprint. An alert back before
/// its second miss stays active as it was: a flap writes nothing.
pub fn step<'a>(
    active: &BTreeMap<String, Active>,
    missed: &BTreeSet<String>,
    present: &BTreeMap<String, &'a Alert>,
) -> Step<'a> {
    let mut next = Step {
        fired: present
            .iter()
            .filter(|(fingerprint, _)| !active.contains_key(*fingerprint))
            .map(|(_, alert)| *alert)
            .collect(),
        ..Step::default()
    };
    for (fingerprint, held) in active {
        if present.contains_key(fingerprint) {
            continue;
        }
        if missed.contains(fingerprint) {
            next.resolved
                .entry(held.message.clone())
                .or_default()
                .push(fingerprint.clone());
        } else {
            next.missed.insert(fingerprint.clone());
        }
    }
    next
}

/// A message a pull writes, unless its id is already in the room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Planned {
    pub id: String,
    pub body: String,
}

/// `prefix` and 40 hex characters of SHA-256 of `seed`: an id the same change always gets again, so a pull repeated
/// after a failed write finds its message rather than writing a second one.
fn derived_id(prefix: char, seed: &str) -> String {
    format!(
        "{prefix}{}",
        &hex::encode(Sha256::digest(seed.as_bytes()))[..40]
    )
}

/// The id of the firing message of `file` for `fired`: `f` and SHA-256 of the signal's name, its `createdAt` (a signal
/// created again under a deleted one's name announces again what still fires) and the sorted `fingerprint|startsAt`
/// of each, one per line.
pub fn firing_id(file: &SignalFile, fired: &[&Alert]) -> String {
    let mut seed: Vec<String> = fired
        .iter()
        .map(|alert| format!("{}|{}", alert.fingerprint, alert.starts_at))
        .collect();
    seed.sort();
    derived_id(
        'f',
        &format!("{}\n{}\n{}", file.alert, file.created_at, seed.join("\n")),
    )
}

/// The id of the resolved message answering firing message `firing_key` for `fingerprints`: `r` and SHA-256 of the
/// key and the sorted fingerprints, one per line.
pub fn resolved_id(firing_key: &str, fingerprints: &[String]) -> String {
    let mut seed = fingerprints.to_vec();
    seed.sort();
    derived_id('r', &format!("{firing_key}\n{}", seed.join("\n")))
}

/// The lines of a message: the first `MAX_LINES`, then one that names how many more there are.
fn listed(mut lines: Vec<String>) -> Vec<String> {
    if lines.len() > MAX_LINES {
        let rest = lines.len() - MAX_LINES;
        lines.truncate(MAX_LINES);
        lines.push(format!("- và {rest} alert khác"));
    }
    lines
}

/// The firing message of `fired`: a header, then a line per alert with its name, summary (or description), a few
/// labels and its link to Grafana.
pub fn firing(file: &SignalFile, fired: &[&Alert]) -> Planned {
    let header = format!("**[FIRING]** {} alert", fired.len());
    let lines = listed(fired.iter().map(|alert| firing_line(alert)).collect());
    Planned {
        id: firing_id(file, fired),
        body: message_body(header, lines),
    }
}

/// The resolved message for `fingerprints` of `active`, answering firing message `firing_key`.
pub fn resolved(
    firing_key: &str,
    fingerprints: &[String],
    active: &BTreeMap<String, Active>,
) -> Planned {
    let header = format!("**[RESOLVED]** {} alert", fingerprints.len());
    let lines = listed(
        fingerprints
            .iter()
            .filter_map(|fingerprint| active.get(fingerprint))
            .map(|held| {
                format!(
                    "- {} · bắt đầu {}",
                    code(&held.alertname),
                    code(&held.starts_at)
                )
            })
            .collect(),
    );
    Planned {
        id: resolved_id(firing_key, fingerprints),
        body: message_body(header, lines),
    }
}

fn message_body(header: String, lines: Vec<String>) -> String {
    let mut all = vec![header];
    all.extend(lines);
    truncate(&all.join("\n"), MAX_MESSAGE_BODY)
}

/// Whether a label is worth a line: not the name, not the routing label, not one of Grafana's own (`__…__`).
fn shown_label(name: &str) -> bool {
    name != "alertname" && name != LABEL && !name.starts_with("__")
}

fn firing_line(alert: &Alert) -> String {
    let mut parts = vec![code(alert.name())];
    let summary = alert
        .annotations
        .get("summary")
        .or_else(|| alert.annotations.get("description"))
        .map(|text| flat(text))
        .filter(|text| !text.is_empty());
    if let Some(summary) = summary {
        parts.push(truncate(&summary, MAX_SUMMARY_LENGTH));
    }
    let labels: Vec<String> = alert
        .labels
        .iter()
        .filter(|(name, _)| shown_label(name))
        .take(MAX_LABELS)
        .map(|(name, value)| code(&format!("{name}={value}")))
        .collect();
    if !labels.is_empty() {
        parts.push(labels.join(" "));
    }
    if let Some(link) = alert.generator_url.as_deref().and_then(link) {
        parts.push(link);
    }
    format!("- {}", parts.join(" · "))
}

/// `text` on one line: control characters (line breaks included) become spaces, so it cannot start a line of its own.
fn flat(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned()
}

/// `text` cut to at most `max` JavaScript characters, with `…` where it was cut.
fn truncate(text: &str, max: usize) -> String {
    if js_length(text) <= max {
        return text.to_owned();
    }
    let mut cut = String::new();
    let mut length = 0;
    for c in text.chars() {
        if length + c.len_utf16() > max - 1 {
            break;
        }
        length += c.len_utf16();
        cut.push(c);
    }
    cut.push('…');
    cut
}

/// `text` as one inline code span: no backtick or line break inside, so nothing in it is Markdown or a mention.
fn code(text: &str) -> String {
    let flat: String = flat(&text.replace('`', "'"));
    let flat = truncate(&flat, MAX_CODE_LENGTH);
    if flat.is_empty() {
        "`-`".to_owned()
    } else {
        format!("`{flat}`")
    }
}

/// A Markdown link to `url` when it is an http(s) address; characters that would end the link are escaped.
fn link(url: &str) -> Option<String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let mut escaped = String::with_capacity(url.len());
    for c in url.chars() {
        match c {
            '(' => escaped.push_str("%28"),
            ')' => escaped.push_str("%29"),
            '<' => escaped.push_str("%3C"),
            '>' => escaped.push_str("%3E"),
            c if c.is_whitespace() || c.is_control() => escaped.push_str("%20"),
            c => escaped.push(c),
        }
    }
    Some(format!("[Grafana]({escaped})"))
}
