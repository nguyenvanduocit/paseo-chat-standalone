//! The broker as its callers meet it: a real HTTP server on a free port, the daemon's key, and a fresh chat directory.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chat_broker::chat::Chat;
use chat_broker::clock::ManualClock;
use chat_broker::identity::Identity;
use chat_broker::log::Log;
use chat_broker::server::Api;
use serde_json::Value;

/// The key the daemon presents (`CHAT_BROKER_KEY`).
pub const KEY: &str = "daemon-key-0123456789";
pub const START_MS: i64 = 1_800_000_000_000;

/// A directory removed when the test ends.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        let mut name = [0u8; 8];
        getrandom::fill(&mut name).expect("random");
        let path = std::env::temp_dir().join(format!("chat-broker-test-{}", hex::encode(name)));
        std::fs::create_dir_all(&path).expect("temp dir");
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Broker {
    pub url: String,
    pub dir: Arc<TempDir>,
    agent: ureq::Agent,
}

pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    pub fn error(&self) -> &str {
        self.body["error"].as_str().unwrap_or_default()
    }
}

/// Who a request is sent as.
#[derive(Clone, Copy)]
pub enum As<'a> {
    /// The daemon's key speaking for a handle, as the plugin does for the person a client picked.
    Person(&'a str),
    /// A raw Authorization value and X-Chat-Handle.
    Raw(Option<&'a str>, Option<&'a str>),
}

impl As<'_> {
    fn headers(self) -> (Option<String>, Option<String>) {
        match self {
            As::Person(handle) => (Some(format!("Bearer {KEY}")), Some(handle.to_owned())),
            As::Raw(authorization, handle) => {
                (authorization.map(str::to_owned), handle.map(str::to_owned))
            }
        }
    }
}

impl Broker {
    pub fn start() -> Broker {
        let dir = Arc::new(TempDir::new());
        let clock = Arc::new(ManualClock::new(START_MS));
        let log = Log::stderr();
        let chat = Arc::new(Chat::open(dir.path(), clock, log.clone(), u64::MAX).expect("the chat loads"));
        let api = Arc::new(Api::new(
            chat,
            Arc::new(Identity::new(KEY)),
            Duration::from_secs(5),
            Duration::from_millis(300),
            log,
        ));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        std::thread::spawn(move || runtime.block_on(api.serve(listener, std::future::pending())));
        Broker {
            url,
            dir,
            agent: ureq::Agent::config_builder()
                .http_status_as_error(false)
                .build()
                .into(),
        }
    }

    fn finish(sent: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Reply {
        let mut response = sent.expect("the broker answers");
        let status = response.status().as_u16();
        let bytes = response.body_mut().read_to_vec().expect("a body");
        Reply {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    pub fn get(&self, who: As, path_and_query: &str) -> Reply {
        let (authorization, handle) = who.headers();
        let mut request = self.agent.get(format!("{}{path_and_query}", self.url));
        if let Some(authorization) = authorization {
            request = request.header("Authorization", authorization);
        }
        if let Some(handle) = handle {
            request = request.header("X-Chat-Handle", handle);
        }
        Broker::finish(request.call())
    }

    pub fn post(&self, who: As, path: &str, body: Value) -> Reply {
        let (authorization, handle) = who.headers();
        let mut request = self.agent.post(format!("{}{path}", self.url));
        if let Some(authorization) = authorization {
            request = request.header("Authorization", authorization);
        }
        if let Some(handle) = handle {
            request = request.header("X-Chat-Handle", handle);
        }
        Broker::finish(request.send(body.to_string()))
    }
}
