//! `chat-broker`: settings from the environment (docs/chat-broker.md), real time, logs on stderr.

use std::sync::Arc;

use chat_broker::clock::SystemClock;
use chat_broker::config::Config;
use chat_broker::log::Log;

fn main() {
    let config = match Config::from_env(|name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(problem) => {
            eprintln!("{problem}");
            std::process::exit(1);
        }
    };
    std::process::exit(chat_broker::run(
        config,
        Arc::new(SystemClock),
        Log::stderr(),
    ));
}
