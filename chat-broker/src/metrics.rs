//! What `GET /metrics` answers, in Prometheus' text format. Counters and the histogram are kept by the shell
//! (`chat.rs`) as requests happen; gauges are computed from the state at scrape time. Pure: `now` is an argument.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::model::{Conversation, key_ms};
use crate::signals::{self, SignalFile};
use crate::state::State;
use crate::watches;

/// Upper bounds (seconds) of `chat_broker_signal_delivery_seconds`: a watch is handed at once, the AI Assistant within
/// a minute or so; past an hour a signal is lost in practice.
pub const DELIVERY_BUCKETS: [f64; 11] = [
    1.0, 5.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0, 21600.0,
];

/// Who a signal message reached: an agent through its watch, or the person's AI Assistant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    Agent,
    Assistant,
}

impl Target {
    pub fn name(self) -> &'static str {
        match self {
            Target::Agent => "agent",
            Target::Assistant => "assistant",
        }
    }
}

/// How a pull of Grafana's alerts ended: an answer that is a list of alerts, or anything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PollResult {
    Ok,
    Error,
}

impl PollResult {
    pub fn name(self) -> &'static str {
        match self {
            PollResult::Ok => "ok",
            PollResult::Error => "error",
        }
    }
}

/// A cumulative histogram over `DELIVERY_BUCKETS`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Histogram {
    /// Observations at or under each bucket's bound, not counting the smaller buckets.
    buckets: [u64; DELIVERY_BUCKETS.len()],
    count: u64,
    sum: f64,
}

impl Histogram {
    pub fn observe(&mut self, seconds: f64) {
        let seconds = seconds.max(0.0);
        if let Some(at) = DELIVERY_BUCKETS.iter().position(|bound| seconds <= *bound) {
            self.buckets[at] += 1;
        }
        self.count += 1;
        self.sum += seconds;
    }
}

/// What the shell counts since the broker started, and what the last successful pull found.
#[derive(Clone, Debug, Default)]
pub struct Counters {
    pub messages_sent: u64,
    pub polls: BTreeMap<PollResult, u64>,
    /// When a pull last succeeded (ms).
    pub last_poll_success_ms: Option<i64>,
    /// Alerts of the last successful pull whose `signal` label names no signal.
    pub unrouted_alerts: usize,
    pub signal_messages: BTreeMap<(String, &'static str), u64>,
    pub handovers: BTreeMap<String, u64>,
    /// Pulls whose step of a signal could not be stored, by signal.
    pub store_errors: BTreeMap<String, u64>,
    pub delivery: BTreeMap<Target, Histogram>,
    /// AI decisions of a kind only people make, without the person's own message, by the AI's owner.
    pub delegation_breaches: BTreeMap<String, u64>,
}

impl Counters {
    pub fn poll(&mut self, result: PollResult) {
        *self.polls.entry(result).or_default() += 1;
    }

    pub fn signal_message(&mut self, alert: &str, status: &'static str) {
        *self
            .signal_messages
            .entry((alert.to_owned(), status))
            .or_default() += 1;
    }

    pub fn delegation_breach(&mut self, handle: &str) {
        *self
            .delegation_breaches
            .entry(handle.to_owned())
            .or_default() += 1;
    }

    pub fn store_error(&mut self, alert: &str) {
        *self.store_errors.entry(alert.to_owned()).or_default() += 1;
    }

    pub fn handover(&mut self, alert: &str) {
        *self.handovers.entry(alert.to_owned()).or_default() += 1;
    }

    /// Signal messages sent at `sent_ms` reached `target` at `now`.
    pub fn delivered(&mut self, target: Target, sent_ms: &[i64], now: i64) {
        let histogram = self.delivery.entry(target).or_default();
        for sent in sent_ms {
            histogram.observe((now - sent) as f64 / 1000.0);
        }
    }
}

/// Seconds between `ms` and `now`, never below zero; zero when there is nothing.
fn age_seconds(ms: Option<i64>, now: i64) -> f64 {
    ms.map_or(0.0, |ms| (now - ms).max(0) as f64 / 1000.0)
}

/// The send time of the oldest message due to any agent of any host (`watches::due_of`).
fn oldest_due_ms(state: &State, now: i64) -> Option<i64> {
    state
        .watches
        .iter()
        .flat_map(|(handle, list)| {
            list.iter()
                .filter_map(move |watch| watches::due_of(watch, handle, now, state)?.oldest_ms())
        })
        .min()
}

/// The send time of the oldest message in a signal's room that has not reached one of its subscribers. An agent
/// subscription waits on its watch: what is due to it. An AI Assistant subscription waits on the assistant's cursor
/// for the room (the later of `delivered[room]` and `from`): every message of someone else after it. Neither counts
/// what came before the subscription.
fn oldest_signal_pending_ms(file: &SignalFile, state: &State, now: i64) -> Option<i64> {
    use std::ops::Bound::{Excluded, Unbounded};
    let conversation = signals::conversation(&file.alert);
    let id = conversation.id();
    let thread = state.thread(&conversation)?;
    file.subscriptions
        .iter()
        .filter_map(|subscription| {
            let since = format!("{:013}", subscription.at.max(0));
            match &subscription.agent {
                Some(agent) => state
                    .watches
                    .get(&subscription.handle)
                    .and_then(|list| {
                        list.iter()
                            .find(|watch| &watch.agent == agent && watch.conversation == id)
                    })
                    .and_then(|watch| watches::due_of(watch, &subscription.handle, now, state))
                    .and_then(|due| due.oldest_ms()),
                None => {
                    let assistant = state.assistant.get(&subscription.handle);
                    let cursor = assistant
                        .map(|assistant| {
                            let delivered = assistant.delivered.get(&id).map_or("", String::as_str);
                            delivered.max(assistant.from.as_str())
                        })
                        .unwrap_or_default()
                        .max(since.as_str());
                    thread
                        .messages
                        .range::<str, _>((Excluded(cursor), Unbounded))
                        .map(|(_, message)| message)
                        .find(|message| message.author != subscription.handle)
                        .map(|message| key_ms(&message.key))
                }
            }
        })
        .min()
}

/// The signal messages `me`'s AI Assistant cursors passed when its state went from `old` to `new`, in the signals
/// whose subscription of `me` goes to the AI Assistant: after the old cursor (and after `new.from`, before which
/// nothing is sent, and the subscription's `at`), up to the new one. Every assistant moves its cursors past signal
/// rooms; only a subscriber's counts as a delivery.
pub fn assistant_passed(
    me: &str,
    old: Option<&crate::state::AssistantState>,
    new: &crate::state::AssistantState,
    state: &State,
) -> Vec<i64> {
    new.delivered
        .iter()
        .filter_map(|(id, through)| {
            let conversation = Conversation::parse(id)?;
            let subscription = state
                .signals
                .get(signals::alert_of(&conversation)?)?
                .subscriptions
                .iter()
                .find(|subscription| subscription.handle == me && subscription.agent.is_none())?;
            Some((
                conversation,
                id,
                through,
                format!("{:013}", subscription.at.max(0)),
            ))
        })
        .flat_map(|(conversation, id, through, since)| {
            let old_cursor = old.map_or("", |old| {
                old.delivered
                    .get(id)
                    .map_or("", String::as_str)
                    .max(old.from.as_str())
            });
            let after = old_cursor.max(new.from.as_str()).max(since.as_str());
            signals::messages_between(state, &conversation, after, through)
        })
        .collect()
}

/// One sample line: `name{labels} value`.
fn sample(out: &mut String, name: &str, labels: &[(&str, &str)], value: impl std::fmt::Display) {
    out.push_str(name);
    if !labels.is_empty() {
        out.push('{');
        for (at, (label, text)) in labels.iter().enumerate() {
            if at > 0 {
                out.push(',');
            }
            let escaped = text
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n");
            let _ = write!(out, "{label}=\"{escaped}\"");
        }
        out.push('}');
    }
    let _ = writeln!(out, " {value}");
}

fn family(out: &mut String, name: &str, kind: &str, help: &str) {
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} {kind}");
}

/// The whole exposition. `event_streams`: the event streams open now.
pub fn render(counters: &Counters, state: &State, event_streams: i64, now: i64) -> String {
    let mut out = String::new();
    family(
        &mut out,
        "chat_broker_messages_sent_total",
        "counter",
        "Messages written, by people, agents and signals.",
    );
    sample(
        &mut out,
        "chat_broker_messages_sent_total",
        &[],
        counters.messages_sent,
    );
    family(
        &mut out,
        "chat_broker_delegation_breaches_total",
        "counter",
        "AI decisions of a kind only people make, sent without the person's own message, by owner.",
    );
    for (handle, count) in &counters.delegation_breaches {
        sample(
            &mut out,
            "chat_broker_delegation_breaches_total",
            &[("handle", handle)],
            count,
        );
    }
    family(
        &mut out,
        "chat_broker_event_streams",
        "gauge",
        "Event streams open now.",
    );
    sample(&mut out, "chat_broker_event_streams", &[], event_streams);
    family(
        &mut out,
        "chat_broker_deliveries_oldest_pending_seconds",
        "gauge",
        "Age of the oldest message due to an agent and not yet delivered, over every watch.",
    );
    sample(
        &mut out,
        "chat_broker_deliveries_oldest_pending_seconds",
        &[],
        age_seconds(oldest_due_ms(state, now), now),
    );
    family(
        &mut out,
        "chat_broker_signal_polls_total",
        "counter",
        "Pulls of Grafana's alerts, by result.",
    );
    for result in [PollResult::Ok, PollResult::Error] {
        sample(
            &mut out,
            "chat_broker_signal_polls_total",
            &[("result", result.name())],
            counters.polls.get(&result).copied().unwrap_or(0),
        );
    }
    family(
        &mut out,
        "chat_broker_signal_last_poll_success_timestamp_seconds",
        "gauge",
        "When a pull of Grafana's alerts last succeeded; 0 when never.",
    );
    sample(
        &mut out,
        "chat_broker_signal_last_poll_success_timestamp_seconds",
        &[],
        counters.last_poll_success_ms.unwrap_or(0) as f64 / 1000.0,
    );
    family(
        &mut out,
        "chat_broker_signal_unrouted_alerts",
        "gauge",
        "Alerts of the last successful pull whose signal label names no signal.",
    );
    sample(
        &mut out,
        "chat_broker_signal_unrouted_alerts",
        &[],
        counters.unrouted_alerts,
    );
    family(
        &mut out,
        "chat_broker_signal_firing",
        "gauge",
        "Alerts of a signal firing now.",
    );
    for file in state.signals.values() {
        sample(
            &mut out,
            "chat_broker_signal_firing",
            &[("alert", &file.alert)],
            file.active.len(),
        );
    }
    family(
        &mut out,
        "chat_broker_signal_messages_total",
        "counter",
        "Firing and resolved messages a signal wrote, by status.",
    );
    for ((alert, status), count) in &counters.signal_messages {
        sample(
            &mut out,
            "chat_broker_signal_messages_total",
            &[("alert", alert), ("status", status)],
            count,
        );
    }
    family(
        &mut out,
        "chat_broker_signal_subscriptions",
        "gauge",
        "Subscriptions of a signal, by who gets it: an agent or an AI Assistant.",
    );
    for file in state.signals.values() {
        for target in [Target::Agent, Target::Assistant] {
            let count = file
                .subscriptions
                .iter()
                .filter(|subscription| subscription.agent.is_some() == (target == Target::Agent))
                .count();
            sample(
                &mut out,
                "chat_broker_signal_subscriptions",
                &[("alert", &file.alert), ("target", target.name())],
                count,
            );
        }
    }
    family(
        &mut out,
        "chat_broker_signal_oldest_pending_seconds",
        "gauge",
        "Age of the oldest message of a signal's room that has not reached one of its subscribers.",
    );
    for file in state.signals.values() {
        sample(
            &mut out,
            "chat_broker_signal_oldest_pending_seconds",
            &[("alert", &file.alert)],
            age_seconds(oldest_signal_pending_ms(file, state, now), now),
        );
    }
    family(
        &mut out,
        "chat_broker_signal_delivery_seconds",
        "histogram",
        "Time from a signal message to the agent or AI Assistant that got it.",
    );
    for target in [Target::Agent, Target::Assistant] {
        let histogram = counters.delivery.get(&target).cloned().unwrap_or_default();
        let mut cumulative = 0;
        for (bound, count) in DELIVERY_BUCKETS.iter().zip(histogram.buckets) {
            cumulative += count;
            sample(
                &mut out,
                "chat_broker_signal_delivery_seconds_bucket",
                &[("target", target.name()), ("le", &bound.to_string())],
                cumulative,
            );
        }
        sample(
            &mut out,
            "chat_broker_signal_delivery_seconds_bucket",
            &[("target", target.name()), ("le", "+Inf")],
            histogram.count,
        );
        sample(
            &mut out,
            "chat_broker_signal_delivery_seconds_sum",
            &[("target", target.name())],
            histogram.sum,
        );
        sample(
            &mut out,
            "chat_broker_signal_delivery_seconds_count",
            &[("target", target.name())],
            histogram.count,
        );
    }
    family(
        &mut out,
        "chat_broker_signal_handovers_total",
        "counter",
        "Times a signal's target agent was gone and its AI Assistant took over.",
    );
    for (alert, count) in &counters.handovers {
        sample(
            &mut out,
            "chat_broker_signal_handovers_total",
            &[("alert", alert)],
            count,
        );
    }
    family(
        &mut out,
        "chat_broker_signal_store_errors_total",
        "counter",
        "Successful pulls whose messages or file of a signal could not be stored; the next pull tries again.",
    );
    for (alert, count) in &counters.store_errors {
        sample(
            &mut out,
            "chat_broker_signal_store_errors_total",
            &[("alert", alert)],
            count,
        );
    }
    out
}
