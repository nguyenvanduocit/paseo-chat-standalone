//! Pulling alerts from Grafana for signals (`GRAFANA_URL`): every `SIGNAL_POLL_SECONDS` the broker asks
//! Grafana's Alertmanager API for the active, unsilenced, uninhibited alerts that carry a `signal` label, outside the
//! chat's lock, then hands the answer, or the failure, to `Chat::pulled`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::chat::Chat;
use crate::log::Log;
use crate::signals::{self, Alert};

/// How long one pull may take, connection included.
pub const TIMEOUT: Duration = Duration::from_secs(10);
/// The alert list, past Grafana's base URL: active only, silenced and inhibited ones left out, and only alerts that
/// carry a `signal` label (`filter=signal=~".+"`).
pub const ALERTS_PATH: &str = "/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false&filter=signal%3D~%22.%2B%22";

/// A Grafana service account token; never printed.
#[derive(Clone)]
pub struct Token(pub String);

impl std::fmt::Debug for Token {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

/// Where alerts are pulled from.
#[derive(Clone, Debug)]
pub struct Settings {
    /// Grafana's base URL, without a trailing slash.
    pub url: String,
    pub token: Token,
}

pub struct Grafana {
    alerts_url: String,
    token: Token,
    agent: ureq::Agent,
    /// The last pull failed: the next failure is not logged again, the next success is.
    failing: AtomicBool,
}

impl Grafana {
    pub fn new(settings: &Settings, timeout: Duration) -> Grafana {
        Grafana {
            alerts_url: format!("{}{ALERTS_PATH}", settings.url.trim_end_matches('/')),
            token: settings.token.clone(),
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(timeout))
                .http_status_as_error(false)
                .build()
                .into(),
            failing: AtomicBool::new(false),
        }
    }

    /// The alerts Grafana answers; an error says what went wrong, never with the token.
    pub fn fetch(&self) -> Result<Vec<Alert>, String> {
        let mut response = self
            .agent
            .get(&self.alerts_url)
            .header("Authorization", format!("Bearer {}", self.token.0))
            .header("Accept", "application/json")
            .call()
            .map_err(|error| format!("{}: {error}", self.alerts_url))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(format!("Grafana answered {status}"));
        }
        let raw = response
            .body_mut()
            .with_config()
            .limit(signals::MAX_ALERTS_BODY)
            .read_to_vec()
            .map_err(|error| format!("cannot read Grafana's answer: {error}"))?;
        signals::parse_alerts(&raw)
            .ok_or_else(|| "Grafana answered something that is not a list of alerts".to_owned())
    }
}

/// One pull: fetch, then hand the alerts, or the failure, to the chat. A failure is logged when pulls start failing,
/// and a success when they recover, so an outage writes two lines rather than one per pull.
pub fn pull(chat: &Chat, grafana: &Grafana, log: &Log) {
    let fetched = grafana.fetch();
    match &fetched {
        Err(why) => {
            if !grafana.failing.swap(true, Ordering::SeqCst) {
                log.warning(format!("cannot pull alerts for signals: {why}"));
            }
        }
        Ok(_) => {
            if grafana.failing.swap(false, Ordering::SeqCst) {
                log.info("pulling alerts for signals again");
            }
        }
    }
    if let Err(error) = chat.pulled(fetched.ok().as_deref()) {
        log.warning(format!(
            "pulled alerts are not all stored ({}); the next pull tries again",
            error.code()
        ));
    }
}

/// Pull every `every`, the first time at once. Spawn it on the broker's runtime.
pub async fn run(chat: Arc<Chat>, grafana: Arc<Grafana>, every: Duration, log: Log) {
    log.info(format!(
        "pulling alerts for signals from {} every {} s",
        grafana.alerts_url,
        every.as_secs()
    ));
    let mut ticks = tokio::time::interval(every);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        let (chat, grafana, log) = (chat.clone(), grafana.clone(), log.clone());
        let _ = tokio::task::spawn_blocking(move || pull(&chat, &grafana, &log)).await;
    }
}
