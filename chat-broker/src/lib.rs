//! Chat broker: the only process that reads and writes the chat directory. Chat plugins call it over HTTP and
//! listen to it over SSE (docs/chat-broker.md).

pub mod chat;
pub mod classify;
pub mod clock;
pub mod config;
pub mod delegation;
pub mod error;
pub mod events;
pub mod grafana;
pub mod identity;
pub mod image;
pub mod isotime;
pub mod limits;
pub mod log;
pub mod metrics;
pub mod model;
pub mod server;
pub mod signals;
pub mod state;
pub mod store;
pub mod text;
pub mod watches;

use std::io::Write;
use std::sync::Arc;

use crate::chat::Chat;
use crate::classify::OpenRouter;
use crate::clock::Clock;
use crate::config::Config;
use crate::grafana::Grafana;
use crate::identity::Identity;
use crate::log::Log;
use crate::server::Api;

/// Resolves on SIGTERM or SIGINT.
async fn stop_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM can be watched");
    let mut interrupt = signal(SignalKind::interrupt()).expect("SIGINT can be watched");
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
}

/// Run the broker until SIGTERM/SIGINT and return the process exit code. Once it accepts connections it prints
/// `metrics on <ip>:<port>` and then `listening on <ip>:<port>` on stdout, the ports a caller of `METRICS_PORT=0` and
/// `PORT=0` reads.
pub fn run(config: Config, clock: Arc<dyn Clock>, log: Log) -> i32 {
    let chat = match Chat::open(
        &config.data_dir,
        clock.clone(),
        log.clone(),
        config.max_image_store_bytes,
    ) {
        Ok(chat) => Arc::new(chat),
        Err(error) => {
            log.error(format!("cannot load {}: {error}", config.data_dir));
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log.error(format!("cannot start the runtime: {error}"));
            return 1;
        }
    };
    let api = Arc::new(Api::new(
        chat.clone(),
        Arc::new(Identity::new(&config.key)),
        config.request_timeout,
        config.ping_every,
        log.clone(),
    ));
    let served = runtime.block_on(async {
        let metrics =
            tokio::net::TcpListener::bind((config.bind.as_str(), config.metrics_port)).await?;
        let metrics_address = metrics.local_addr()?;
        tokio::spawn(server::serve_metrics(
            chat.clone(),
            metrics,
            std::future::pending(),
            log.clone(),
        ));
        let listener = tokio::net::TcpListener::bind((config.bind.as_str(), config.port)).await?;
        let address = listener.local_addr()?;
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "metrics on {metrics_address}")?;
        writeln!(stdout, "listening on {address}")?;
        stdout.flush()?;
        drop(stdout);
        log.info(format!("metrics on {metrics_address}"));
        log.info(format!("listening on {address}"));
        match &config.classifier {
            Some(settings) => {
                tokio::spawn(classify::run(
                    chat.clone(),
                    Arc::new(OpenRouter::new(settings)),
                    log.clone(),
                ));
            }
            None => log.info("OPENROUTER_KEY is not set: messages are not classified"),
        }
        match &config.grafana {
            Some(settings) => {
                tokio::spawn(grafana::run(
                    chat.clone(),
                    Arc::new(Grafana::new(settings, grafana::TIMEOUT)),
                    config.signal_poll_every,
                    log.clone(),
                ));
            }
            None => log.info("GRAFANA_TOKEN and GRAFANA_URL are not set: signals pull no alerts"),
        }
        let tick_every = config.tick_every;
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(tick_every);
            loop {
                ticks.tick().await;
                let chat = chat.clone();
                let _ = tokio::task::spawn_blocking(move || chat.tick()).await;
            }
        });
        api.serve(listener, stop_signal()).await;
        Ok::<(), std::io::Error>(())
    });
    if let Err(error) = served {
        log.error(format!(
            "cannot listen on {} (port {}, metrics port {}): {error}",
            config.bind, config.port, config.metrics_port
        ));
        return 1;
    }
    log.info("shutting down");
    // Event streams never end on their own; they end with the process. Every write finished before its reply.
    runtime.shutdown_background();
    0
}
