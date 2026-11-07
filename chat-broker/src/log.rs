//! Log lines: `<UTC stamp> <LEVEL> chat_broker <message>` on stderr. Messages never carry a credential or a body.

use std::io::Write;
use std::sync::Arc;

use crate::clock::{Clock, SystemClock};
use crate::isotime::log_stamp;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warning,
    Error,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warning => "WARNING",
            Level::Error => "ERROR",
        }
    }
}

pub trait Sink: Send + Sync {
    fn write(&self, level: Level, message: &str);
}

/// The broker's logger, handed to every part that logs; cloning shares the sink.
#[derive(Clone)]
pub struct Log(Arc<dyn Sink>);

impl Log {
    pub fn new(sink: Arc<dyn Sink>) -> Log {
        Log(sink)
    }

    pub fn stderr() -> Log {
        Log(Arc::new(Stderr))
    }

    /// Drops every line: tests that do not look at the log.
    pub fn silent() -> Log {
        Log(Arc::new(Silent))
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.0.write(Level::Info, message.as_ref());
    }

    pub fn warning(&self, message: impl AsRef<str>) {
        self.0.write(Level::Warning, message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        self.0.write(Level::Error, message.as_ref());
    }
}

struct Stderr;

impl Sink for Stderr {
    fn write(&self, level: Level, message: &str) {
        let line = format!(
            "{} {} chat_broker {message}\n",
            log_stamp(SystemClock.now_ms()),
            level.name()
        );
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }
}

struct Silent;

impl Sink for Silent {
    fn write(&self, _level: Level, _message: &str) {}
}
