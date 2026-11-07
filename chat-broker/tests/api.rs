//! The broker's HTTP API as the chat plugin uses it (docs/chat-broker.md).

mod support;

use serde_json::{Value, json};
use support::{As, Broker};

const ROOM: &str = "room:paseo/chung";

fn send(broker: &Broker, who: As, body: Value) -> support::Reply {
    broker.post(who, "/v1/messages", body)
}

// --- identity ---

#[test]
fn the_daemon_key_names_the_handle_the_client_picked() {
    let broker = Broker::start();
    let named = broker.get(As::Person("bob"), "/v1/inbox");
    assert_eq!((named.status, &named.body["me"]), (200, &json!("bob")));
    let key = format!("Bearer {}", support::KEY);
    let unnamed = broker.get(As::Raw(Some(&key), None), "/v1/inbox");
    assert_eq!((unnamed.status, unnamed.error()), (400, "bad_handle"));
    let malformed = broker.get(As::Raw(Some(&key), Some("bad handle")), "/v1/inbox");
    assert_eq!((malformed.status, malformed.error()), (400, "bad_handle"));
    let wrong = broker.get(As::Raw(Some("Bearer not-the-key-000000"), Some("carol")), "/v1/inbox");
    assert_eq!((wrong.status, wrong.error()), (401, "unauthorized"));
    // Only images are served without the key.
    let anonymous = broker.get(As::Raw(None, None), "/v1/inbox");
    assert_eq!((anonymous.status, anonymous.error()), (401, "unauthorized"));
    // The author is the named handle, whatever the body says.
    let message = send(
        &broker,
        As::Person("carol"),
        json!({"conversation": ROOM, "id": "msg-00000001", "body": "hi", "author": "bob"}),
    );
    assert_eq!(message.body["message"]["author"], "carol");
}
