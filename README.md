# paseo-chat-standalone

Paseo chat and its AI Orchestrator (each person's AI Assistant: a router, workers, Talk to myself, persona and
Cần lưu ý) on one machine: one Paseo daemon, one chat broker, several people connecting their own clients. Each
client says who is at it; see [`docs/standalone.md`](docs/standalone.md) for why and what that does and does not
protect.

| Directory | What |
|---|---|
| `chat-broker/` | Rust server, the only process that reads and writes the chat files ([`docs/chat-broker.md`](docs/chat-broker.md)) |
| `chat-plugin/` | Paseo plugin: chat UI, agent tools, the AI Assistant ([`chat-plugin/README.md`](chat-plugin/README.md)) |

## Run it

```sh
# 1. A key the broker and the daemon share (at least 16 characters).
export CHAT_BROKER_KEY="$(openssl rand -hex 24)"

# 2. The broker, on 127.0.0.1:8080.
cd chat-broker
cargo build --release
CHAT_BROKER_DATA_DIR="$HOME/.paseo/chat-broker" ./target/release/chat-broker &

# 3. The Paseo daemon must have the same CHAT_BROKER_KEY in its environment, and CHAT_PEOPLE with
#    the handles of the people who use it (and CHAT_BROKER_URL if the broker is elsewhere).
#    export CHAT_PEOPLE=nam,an
#    Restart the daemon after setting or changing these, then install the plugin.
cd ../chat-plugin
npm ci
paseo plugin install "$PWD"
```

Each person opens **Chat** in their client and picks their name. On the mobile app, name the connection to the daemon
with your handle, so the app knows you after each launch. To let the agents of a workspace message as you, open
that workspace's Chat panel and choose **Nhận workspace này**.

Optional broker settings: `OPENROUTER_KEY` classifies messages; `GRAFANA_TOKEN` with `GRAFANA_URL` turns on signals.

## Checks

```sh
(cd chat-broker && cargo test --features harness)
(cd chat-plugin && npm run typecheck && npm test)
```
