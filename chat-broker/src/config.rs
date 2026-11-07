//! Broker settings from the environment (docs/chat-broker.md), each with its default here.

use std::time::Duration;

use crate::classify::{self, Key, Settings};
use crate::grafana;
use crate::identity::MIN_KEY_LENGTH;

pub const DEFAULT_MAX_IMAGE_STORE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const DEFAULT_SIGNAL_POLL_SECONDS: u64 = 30;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: String,
    /// The key the daemon presents on every request (`CHAT_BROKER_KEY`).
    pub key: String,
    pub max_image_store_bytes: u64,
    pub bind: String,
    /// 0 picks a free port; the broker prints the one it listens on.
    pub port: u16,
    /// Where `GET /metrics` is served, apart from the API; 0 picks a free port and the broker prints it.
    pub metrics_port: u16,
    /// How long a connection may take to send its request head, and then its body.
    pub request_timeout: Duration,
    /// How often an event stream gets a `: ping` comment, so proxies keep it open.
    pub ping_every: Duration,
    /// How often presence is checked for changes that come with time alone.
    pub tick_every: Duration,
    /// Where new messages are classified; None (no `OPENROUTER_KEY`) leaves them unclassified.
    pub classifier: Option<Settings>,
    /// Where signals pull their alerts; None (no `GRAFANA_TOKEN` and `GRAFANA_URL`) pulls nothing.
    pub grafana: Option<grafana::Settings>,
    /// How often signals pull.
    pub signal_poll_every: Duration,
}

impl Config {
    pub fn new(data_dir: &str, key: &str) -> Config {
        Config {
            data_dir: data_dir.to_owned(),
            key: key.to_owned(),
            max_image_store_bytes: DEFAULT_MAX_IMAGE_STORE_BYTES,
            // Only the daemon on this machine talks to the broker.
            bind: "127.0.0.1".to_owned(),
            port: 8080,
            metrics_port: 9090,
            request_timeout: Duration::from_secs(15),
            ping_every: Duration::from_secs(15),
            tick_every: Duration::from_secs(5),
            classifier: None,
            grafana: None,
            signal_poll_every: Duration::from_secs(DEFAULT_SIGNAL_POLL_SECONDS),
        }
    }

    /// The settings the environment gives; an error names what is wrong and the broker does not start.
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let key = env("CHAT_BROKER_KEY")
            .map(|key| key.trim().to_owned())
            .filter(|key| key.len() >= MIN_KEY_LENGTH)
            .ok_or(format!(
                "CHAT_BROKER_KEY must be set to a key of at least {MIN_KEY_LENGTH} characters, the one the daemon's chat plugin has"
            ))?;
        let data_dir = env("CHAT_BROKER_DATA_DIR").unwrap_or_else(|| "/data".to_owned());
        let mut config = Config::new(&data_dir, &key);
        if let Some(bind) = env("BIND") {
            config.bind = bind.trim().to_owned();
        }
        if let Some(port) = env("PORT") {
            config.port = port
                .trim()
                .parse()
                .map_err(|_| format!("PORT must be a port number, got {port:?}"))?;
        }
        if let Some(port) = env("METRICS_PORT") {
            config.metrics_port = port
                .trim()
                .parse()
                .map_err(|_| format!("METRICS_PORT must be a port number, got {port:?}"))?;
        }
        if let Some(bytes) = env("CHAT_BROKER_MAX_IMAGE_STORE_BYTES") {
            config.max_image_store_bytes = bytes.trim().parse().map_err(|_| {
                format!(
                    "CHAT_BROKER_MAX_IMAGE_STORE_BYTES must be a number of bytes, got {bytes:?}"
                )
            })?;
        }
        config.classifier = env("OPENROUTER_KEY")
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty())
            .map(|key| Settings {
                url: env("OPENROUTER_URL")
                    .map(|url| url.trim().to_owned())
                    .unwrap_or_else(|| classify::DEFAULT_URL.to_owned()),
                key: Key(key),
                model: env("CHAT_BROKER_CLASSIFY_MODEL")
                    .map(|model| model.trim().to_owned())
                    .filter(|model| !model.is_empty())
                    .unwrap_or_else(|| classify::DEFAULT_MODEL.to_owned()),
            });
        if let Some(settings) = &config.classifier
            && !(settings.url.starts_with("http://") || settings.url.starts_with("https://"))
        {
            return Err(format!(
                "OPENROUTER_URL must be an http(s) address, got {:?}",
                settings.url
            ));
        }
        let grafana_token = env("GRAFANA_TOKEN")
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty());
        let grafana_url = env("GRAFANA_URL")
            .map(|url| url.trim().trim_end_matches('/').to_owned())
            .filter(|url| !url.is_empty());
        config.grafana = match (grafana_token, grafana_url) {
            (Some(token), Some(url)) => Some(grafana::Settings {
                url,
                token: grafana::Token(token),
            }),
            (None, None) => None,
            _ => return Err("GRAFANA_TOKEN and GRAFANA_URL go together: set both or neither".to_owned()),
        };
        if let Some(settings) = &config.grafana
            && !(settings.url.starts_with("http://") || settings.url.starts_with("https://"))
        {
            return Err(format!(
                "GRAFANA_URL must be an http(s) address, got {:?}",
                settings.url
            ));
        }
        if let Some(seconds) = env("SIGNAL_POLL_SECONDS") {
            let seconds: u64 = seconds
                .trim()
                .parse()
                .ok()
                .filter(|seconds| *seconds > 0)
                .ok_or_else(|| {
                    format!("SIGNAL_POLL_SECONDS must be a whole number of seconds above 0, got {seconds:?}")
                })?;
            config.signal_poll_every = Duration::from_secs(seconds);
        }
        Ok(config)
    }
}
