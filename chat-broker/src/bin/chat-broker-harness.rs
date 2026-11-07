//! `chat-broker-harness`: the shipped broker (`chat_broker::run`, the same environment settings) with a clock an
//! end-to-end test moves. Built only with `--features harness`.
//!
//! The clock reads `$CHAT_INT_CLOCK_FILE` on every call: epoch milliseconds as text. A missing or empty file, or no
//! such variable, is real time.
//!
//! Without `METRICS_PORT` the metrics listener takes a free port rather than 9090, so brokers of parallel tests do not
//! fight over one port.

use std::path::PathBuf;
use std::sync::Arc;

use chat_broker::clock::{Clock, SystemClock};
use chat_broker::config::Config;
use chat_broker::log::Log;

struct FileClock {
    file: Option<PathBuf>,
}

impl Clock for FileClock {
    fn now_ms(&self) -> i64 {
        self.file
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| text.trim().parse::<i64>().ok())
            .unwrap_or_else(|| SystemClock.now_ms())
    }
}

fn main() {
    let mut config = Config::from_env(|name| std::env::var(name).ok()).unwrap_or_else(|problem| {
        eprintln!("{problem}");
        std::process::exit(1);
    });
    if std::env::var_os("METRICS_PORT").is_none() {
        config.metrics_port = 0;
    }
    let clock = FileClock {
        file: std::env::var_os("CHAT_INT_CLOCK_FILE").map(PathBuf::from),
    };
    std::process::exit(chat_broker::run(config, Arc::new(clock), Log::stderr()));
}
