//! HTTP surface: routes, identity, request parsing, JSON and SSE out. No chat rule lives here.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Body, Frame, Incoming};
use hyper::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderValue,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};

use crate::chat::{Chat, SendRequest};
use crate::error::ApiError;
use crate::events::Event;
use crate::identity::Identity;
use crate::log::Log;
use crate::model::{
    Conversation, MAX_QUERY_LENGTH, Priority, Status, Via, is_after, is_agent_id, is_message_key,
};
use crate::state::{AssistantState, PAGE_SIZE};
use crate::text::js_length;

/// The largest request body: a 10 MiB image with room to spare.
pub const MAX_BODY: usize = 15 * 1024 * 1024;
/// An image of up to 10 MiB from a machine on a slow link (about 0.7 Mbit/s) still arrives; other bodies are small
/// and get the request timeout.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

type ReplyBody = BoxBody<Bytes, Infallible>;

/// Every route the broker answers; anything else is `NotFound`.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    Healthz,
    Presence,
    Agents,
    Register,
    Inbox,
    People,
    Delegation,
    Conversations,
    Messages,
    Latest,
    Send,
    Reads,
    Joins,
    Focus,
    GetAssistant,
    PutAssistant,
    Deliveries,
    Delivered,
    EndWatch,
    Search,
    Upload,
    Image(String),
    Events,
    RegisterSignal,
    DeleteSignal,
    Signals,
    Subscribe,
    Unsubscribe,
    NotFound,
}

impl Route {
    fn of(method: &Method, path: &str) -> Route {
        match (method.as_str(), path) {
            ("GET", "/healthz") => Route::Healthz,
            ("POST", "/v1/presence") => Route::Presence,
            ("POST", "/v1/agents") => Route::Agents,
            ("POST", "/v1/register") => Route::Register,
            ("GET", "/v1/inbox") => Route::Inbox,
            ("GET", "/v1/people") => Route::People,
            ("GET", "/v1/delegation") => Route::Delegation,
            ("GET", "/v1/conversations") => Route::Conversations,
            ("GET", "/v1/messages") => Route::Messages,
            ("GET", "/v1/messages/latest") => Route::Latest,
            ("POST", "/v1/messages") => Route::Send,
            ("POST", "/v1/reads") => Route::Reads,
            ("POST", "/v1/joins") => Route::Joins,
            ("POST", "/v1/focus") => Route::Focus,
            ("GET", "/v1/assistant") => Route::GetAssistant,
            ("PUT", "/v1/assistant") => Route::PutAssistant,
            ("GET", "/v1/deliveries") => Route::Deliveries,
            ("POST", "/v1/deliveries") => Route::Delivered,
            ("POST", "/v1/watches/end") => Route::EndWatch,
            ("GET", "/v1/search") => Route::Search,
            ("POST", "/v1/images") => Route::Upload,
            ("GET", "/v1/events") => Route::Events,
            ("POST", "/v1/signals") => Route::RegisterSignal,
            ("POST", "/v1/signals/delete") => Route::DeleteSignal,
            ("GET", "/v1/signals") => Route::Signals,
            ("POST", "/v1/signals/subscribe") => Route::Subscribe,
            ("POST", "/v1/signals/unsubscribe") => Route::Unsubscribe,
            ("GET", _) => path
                .strip_prefix("/v1/images/")
                .map_or(Route::NotFound, |id| Route::Image(id.to_owned())),
            _ => Route::NotFound,
        }
    }

    fn takes_body(&self) -> bool {
        matches!(
            self,
            Route::Presence
                | Route::Agents
                | Route::Register
                | Route::Send
                | Route::Reads
                | Route::Joins
                | Route::Focus
                | Route::PutAssistant
                | Route::Delivered
                | Route::EndWatch
                | Route::Upload
                | Route::RegisterSignal
                | Route::DeleteSignal
                | Route::Subscribe
                | Route::Unsubscribe
        )
    }
}

/// A form-encoded query component: `+` is a space, `%XX` a byte; None when the bytes are not UTF-8.
fn form_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => decoded.push(b' '),
            b'%' => {
                let byte = text
                    .get(at + 1..at + 3)
                    .and_then(|pair| u8::from_str_radix(pair, 16).ok());
                match byte {
                    Some(byte) => {
                        decoded.push(byte);
                        at += 2;
                    }
                    None => decoded.push(b'%'),
                }
            }
            other => decoded.push(other),
        }
        at += 1;
    }
    String::from_utf8(decoded).ok()
}

/// The first value of `name` in a query string, decoded.
fn query_value(query: Option<&str>, name: &str) -> Result<Option<String>, ApiError> {
    let Some(query) = query else {
        return Ok(None);
    };
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if form_decode(key).as_deref() == Some(name) {
            return form_decode(value)
                .map(Some)
                .ok_or_else(|| ApiError::bad_request("Tham số không phải UTF-8."));
        }
    }
    Ok(None)
}

fn bad_conversation() -> ApiError {
    ApiError::new(400, "bad_conversation", "Cuộc trò chuyện không hợp lệ.")
}

fn conversation_of(text: Option<&str>) -> Result<Conversation, ApiError> {
    let text = text.ok_or_else(bad_conversation)?;
    Conversation::parse(text).ok_or_else(|| {
        let members = text.strip_prefix("dm:").map(|members| {
            let mut members: Vec<&str> = members.split(',').collect();
            members.sort_unstable();
            members.dedup();
            members.len()
        });
        if members.is_some_and(|count| count < 2) {
            ApiError::new(
                400,
                "bad_conversation",
                "Tin nhắn riêng cần ít nhất hai người.",
            )
        } else {
            bad_conversation()
        }
    })
}

fn body_conversation(body: &Map<String, Value>) -> Result<Conversation, ApiError> {
    conversation_of(body.get("conversation").and_then(Value::as_str))
}

fn limit_of(text: Option<String>) -> Result<usize, ApiError> {
    match text {
        None => Ok(PAGE_SIZE),
        Some(text) => text
            .parse::<usize>()
            .ok()
            .filter(|limit| (1..=PAGE_SIZE).contains(limit))
            .ok_or_else(|| ApiError::bad_request(format!("limit phải từ 1 tới {PAGE_SIZE}."))),
    }
}

fn strings(value: Option<&Value>, field: &str) -> Result<Vec<String>, ApiError> {
    let invalid = || ApiError::bad_request(format!("{field} phải là danh sách chuỗi."));
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or_else(invalid))
            .collect(),
        Some(_) => Err(invalid()),
    }
}

/// A whole number of at least 0, or None when absent; an error when present and anything else.
fn count(value: Option<&Value>, field: &str) -> Result<Option<i64>, ApiError> {
    match value {
        None => Ok(None),
        Some(value) => {
            value.as_i64().filter(|n| *n >= 0).map(Some).ok_or_else(|| {
                ApiError::bad_request(format!("{field} phải là số nguyên không âm."))
            })
        }
    }
}

fn send_request(body: &Map<String, Value>) -> Result<SendRequest, ApiError> {
    let conversation = body_conversation(body)?;
    let id = match body.get("id") {
        Some(Value::String(id)) => id.clone(),
        _ => return Err(ApiError::new(400, "bad_id", "id không hợp lệ.")),
    };
    let text = match body.get("body") {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(_) => return Err(ApiError::bad_request("body phải là chuỗi.")),
    };
    let attachments = strings(body.get("attachments"), "attachments")?;
    let reply_to = match body.get("replyTo") {
        None | Some(Value::Null) => None,
        Some(Value::String(key)) => Some(key.clone()),
        Some(_) => return Err(ApiError::bad_request("replyTo phải là key của một tin.")),
    };
    let via = match body.get("via") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            serde_json::from_value::<Via>(value.clone())
                .ok()
                .filter(Via::is_valid)
                .ok_or_else(|| ApiError::bad_request("via không hợp lệ."))?,
        ),
    };
    let priority = match body.get("priority") {
        None | Some(Value::Null) => Priority::Normal,
        Some(value) => serde_json::from_value::<Priority>(value.clone())
            .map_err(|_| ApiError::bad_request("priority phải là normal hoặc urgent."))?,
    };
    let wait = match body.get("wait") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(wait)) => *wait,
        Some(_) => return Err(ApiError::bad_request("wait phải là true hoặc false.")),
    };
    let status = match body.get("status") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            serde_json::from_value::<Status>(value.clone()).map_err(|_| {
                ApiError::bad_request(
                    "status phải là working, input-required, completed, failed hoặc canceled.",
                )
            })?,
        ),
    };
    Ok(SendRequest {
        conversation,
        id,
        body: text,
        attachments,
        reply_to,
        via,
        priority,
        wait,
        status,
    })
}

/// `agent` of a watch request: a Paseo agent id.
fn watch_agent(body: &Map<String, Value>) -> Result<String, ApiError> {
    body.get("agent")
        .and_then(Value::as_str)
        .filter(|agent| is_agent_id(agent))
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad_request("agent phải là id của một agent."))
}

/// `alert` of a signal request.
fn body_alert(body: &Map<String, Value>) -> Result<String, ApiError> {
    body.get("alert")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad_request("Thiếu alert."))
}

/// `agent` of a subscription: a Paseo agent id, or None (absent or null) for the AI Assistant.
fn subscription_agent(body: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match body.get("agent") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => watch_agent(body).map(Some),
    }
}

fn json_object(raw: &[u8]) -> Result<Map<String, Value>, ApiError> {
    if raw.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice(raw) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(ApiError::bad_request(
            "Thân yêu cầu phải là một object JSON.",
        )),
    }
}

/// Run chat work off the async threads: it blocks on the lock and the disk.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err(ApiError::Internal("the handler panicked".to_owned())))
}

fn header(headers: &HeaderMap, name: impl hyper::header::AsHeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn full(bytes: impl Into<Bytes>) -> ReplyBody {
    Full::new(bytes.into()).boxed()
}

fn json_response(status: u16, body: &Value) -> Response<ReplyBody> {
    let mut response = Response::new(full(body.to_string()));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

/// An SSE body fed by the subscriber task; it ends when the task drops its sender.
struct EventStream(mpsc::Receiver<Bytes>);

impl Body for EventStream {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.0
            .poll_recv(cx)
            .map(|chunk| chunk.map(|bytes| Ok(Frame::data(bytes))))
    }
}

pub struct Api {
    chat: Arc<Chat>,
    identity: Arc<Identity>,
    request_timeout: Duration,
    ping_every: Duration,
    log: Log,
}

enum Reply {
    Json(Value),
    Image(String, Vec<u8>),
    Events(String),
}

impl Api {
    pub fn new(
        chat: Arc<Chat>,
        identity: Arc<Identity>,
        request_timeout: Duration,
        ping_every: Duration,
        log: Log,
    ) -> Api {
        Api {
            chat,
            identity,
            request_timeout,
            ping_every,
            log,
        }
    }

    /// The request body, at most `limit` bytes, arriving within `timeout`.
    async fn read_body(
        &self,
        headers: &HeaderMap,
        body: Incoming,
        timeout: Duration,
        limit: usize,
    ) -> Result<Bytes, ApiError> {
        let too_large = || ApiError::new(413, "too_large", "Yêu cầu quá lớn.");
        if let Some(declared) = header(headers, CONTENT_LENGTH) {
            let length = declared
                .trim()
                .parse::<u64>()
                .map_err(|_| ApiError::bad_request("Content-Length không hợp lệ."))?;
            if length > limit as u64 {
                return Err(too_large());
            }
        }
        match tokio::time::timeout(timeout, Limited::new(body, limit).collect()).await {
            Ok(Ok(collected)) => Ok(collected.to_bytes()),
            Ok(Err(error)) if error.is::<http_body_util::LengthLimitError>() => Err(too_large()),
            _ => Err(ApiError::new(408, "timeout", "Thân yêu cầu không tới kịp.")),
        }
    }

    async fn route(&self, request: Request<Incoming>) -> Result<Reply, ApiError> {
        let route = Route::of(request.method(), request.uri().path());
        if route == Route::Healthz {
            return Ok(Reply::Json(json!({"ok": true})));
        }
        // An image is served without a credential, so Paseo's Markdown can draw it from this URL with a plain <img>.
        // Its id is the SHA-256 of its bytes: only someone shown the message, or holding the image, knows it.
        if let Route::Image(id) = &route {
            let (chat, id) = (self.chat.clone(), id.clone());
            return blocking(move || match chat.image(&id)? {
                Some((mime, bytes)) => Ok(Reply::Image(mime, bytes)),
                None => Err(ApiError::new(404, "not_found", "Không tìm thấy ảnh.")),
            })
            .await;
        }
        let (parts, body) = request.into_parts();
        let headers = &parts.headers;
        let authorization = header(headers, AUTHORIZATION).map(str::to_owned);
        let chat_handle = header(headers, "X-Chat-Handle").map(str::to_owned);
        let me = self
            .identity
            .resolve(authorization.as_deref(), chat_handle.as_deref())?;
        let raw = if route.takes_body() {
            let timeout = if route == Route::Upload {
                UPLOAD_TIMEOUT
            } else {
                self.request_timeout
            };
            self.read_body(headers, body, timeout, MAX_BODY).await?
        } else {
            Bytes::new()
        };
        if route == Route::Events {
            return Ok(Reply::Events(me));
        }
        let query = parts.uri.query().map(str::to_owned);
        let chat = self.chat.clone();
        blocking(move || {
            let query = query.as_deref();
            let value = |name: &str| query_value(query, name);
            let me = me.as_str();
            let reply = match route {
                Route::Presence => {
                    let body = json_object(&raw)?;
                    let projects = match body.get("projects") {
                        Some(projects) => Some(strings(Some(projects), "projects")?),
                        None => None,
                    };
                    chat.presence(me, projects, count(body.get("idleMs"), "idleMs")?)?
                }
                Route::Agents => {
                    let body = json_object(&raw)?;
                    let running = count(body.get("running"), "running")?
                        .ok_or_else(|| ApiError::bad_request("Thiếu running."))?;
                    chat.agents(me, running)?
                }
                Route::Register => chat.register(me)?,
                Route::Inbox => chat.inbox(me),
                Route::People => chat.people(),
                Route::Delegation => json!(&*crate::delegation::CATALOG),
                Route::Conversations => chat.conversations(me),
                Route::Messages => {
                    let conversation = conversation_of(value("c")?.as_deref())?;
                    let after = value("after")?.unwrap_or_default();
                    if !is_after(&after) {
                        return Err(ApiError::bad_request(
                            "after phải là key của một tin hoặc 13 chữ số thời gian.",
                        ));
                    }
                    chat.messages(me, &conversation, &after, limit_of(value("limit")?)?)?
                }
                Route::Latest => {
                    let conversation = conversation_of(value("c")?.as_deref())?;
                    chat.latest(me, &conversation, limit_of(value("limit")?)?)?
                }
                Route::Send => chat.send(me, send_request(&json_object(&raw)?)?)?,
                Route::Reads => {
                    let body = json_object(&raw)?;
                    let conversation = body_conversation(&body)?;
                    let key = match body.get("key") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(key)) if is_message_key(key) => Some(key.as_str()),
                        Some(_) => {
                            return Err(ApiError::bad_request("key phải là key của một tin."));
                        }
                    };
                    chat.read(me, &conversation, key)?
                }
                Route::Joins => chat.join(me, &body_conversation(&json_object(&raw)?)?)?,
                Route::Focus => chat.focus(me, &body_conversation(&json_object(&raw)?)?)?,
                Route::GetAssistant => chat.assistant(me),
                Route::PutAssistant => {
                    let state = AssistantState::parse(Value::Object(json_object(&raw)?))
                        .ok_or_else(|| {
                            ApiError::bad_request("Trạng thái assistant không hợp lệ.")
                        })?;
                    chat.save_assistant(me, state)?
                }
                Route::Deliveries => chat.deliveries(me),
                Route::Delivered => {
                    let body = json_object(&raw)?;
                    let through = body
                        .get("through")
                        .and_then(Value::as_str)
                        .filter(|key| is_message_key(key))
                        .ok_or_else(|| ApiError::bad_request("through phải là key của một tin."))?;
                    chat.delivered(
                        me,
                        &watch_agent(&body)?,
                        &body_conversation(&body)?,
                        through,
                    )?
                }
                Route::EndWatch => {
                    let body = json_object(&raw)?;
                    chat.end_watch(me, &watch_agent(&body)?, &body_conversation(&body)?)?
                }
                Route::Search => {
                    let q = value("q")?.unwrap_or_default();
                    if !(1..=MAX_QUERY_LENGTH).contains(&js_length(&q)) {
                        return Err(ApiError::bad_request(format!(
                            "Từ khóa tìm kiếm phải từ 1 tới {MAX_QUERY_LENGTH} ký tự."
                        )));
                    }
                    let only = value("c")?
                        .filter(|c| !c.is_empty())
                        .map(|c| conversation_of(Some(&c)))
                        .transpose()?;
                    chat.search(me, &q, only.as_ref())?
                }
                Route::Upload => chat.upload(me, &raw)?,
                Route::RegisterSignal => {
                    chat.register_signal(me, &body_alert(&json_object(&raw)?)?)?
                }
                Route::DeleteSignal => chat.delete_signal(me, &body_alert(&json_object(&raw)?)?)?,
                Route::Signals => chat.signals(),
                Route::Subscribe => {
                    let body = json_object(&raw)?;
                    chat.subscribe_signal(me, &body_alert(&body)?, subscription_agent(&body)?)?
                }
                Route::Unsubscribe => {
                    chat.unsubscribe_signal(me, &body_alert(&json_object(&raw)?)?)?
                }
                Route::NotFound => {
                    return Err(ApiError::new(404, "not_found", "Không có route này."));
                }
                Route::Healthz | Route::Image(_) | Route::Events => {
                    unreachable!("answered above")
                }
            };
            Ok(Reply::Json(reply))
        })
        .await
    }

    /// The SSE stream of one subscriber: `ready`, then every event it may see, and a ping comment so proxies keep
    /// the connection open. A subscriber that falls behind is cut off; it reconnects and reads the state again.
    fn events(&self, me: String) -> Response<ReplyBody> {
        let (sender, receiver) = mpsc::channel::<Bytes>(64);
        let mut events = self.chat.subscribe();
        let ping_every = self.ping_every;
        let _ = sender.try_send(Bytes::from(Event::ready(&me).frame()));
        let open = self.chat.stream_opened();
        tokio::spawn(async move {
            let _open = open;
            let mut ping =
                tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
            loop {
                let frame = tokio::select! {
                    _ = ping.tick() => Bytes::from_static(b": ping\n\n"),
                    received = events.recv() => match received {
                        Ok(event) if event.visible_to(&me) => Bytes::from(event.frame()),
                        Ok(_) => continue,
                        Err(broadcast::error::RecvError::Lagged(_) | broadcast::error::RecvError::Closed) => break,
                    },
                    () = sender.closed() => break,
                };
                if sender.send(frame).await.is_err() {
                    break;
                }
            }
        });
        let mut response = Response::new(EventStream(receiver).boxed());
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        headers.insert("X-Accel-Buffering", HeaderValue::from_static("no"));
        response
    }

    async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Response<ReplyBody> {
        let method = request.method().clone();
        let path = request.uri().path().to_owned();
        let response = match self.route(request).await {
            Ok(Reply::Json(body)) => json_response(200, &body),
            Ok(Reply::Image(mime, bytes)) => {
                let mut response = Response::new(full(bytes));
                let headers = response.headers_mut();
                if let Ok(mime) = HeaderValue::from_str(&mime) {
                    headers.insert(CONTENT_TYPE, mime);
                }
                headers.insert(
                    CACHE_CONTROL,
                    HeaderValue::from_static("private, max-age=31536000, immutable"),
                );
                headers.insert(
                    "X-Content-Type-Options",
                    HeaderValue::from_static("nosniff"),
                );
                response
            }
            Ok(Reply::Events(me)) => self.events(me),
            Err(ApiError::Refused {
                status,
                code,
                message,
            }) => json_response(status, &json!({"error": code, "message": message})),
            Err(ApiError::Internal(reason)) => {
                self.log
                    .error(format!("unhandled error on {method} {path}: {reason}"));
                json_response(
                    500,
                    &json!({"error": "internal", "message": "Lỗi máy chủ chat."}),
                )
            }
        };
        if path != "/healthz" {
            self.log
                .info(format!("{method} {path} {}", response.status().as_u16()));
        }
        response
    }

    /// Accept connections until `shutdown` resolves, then stop accepting. A client that stalls in its request head
    /// is cut off after the request timeout.
    pub async fn serve(self: Arc<Self>, listener: TcpListener, shutdown: impl Future<Output = ()>) {
        tokio::pin!(shutdown);
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                () = &mut shutdown => return,
            };
            let stream = match accepted {
                Ok((stream, _)) => stream,
                Err(error) => {
                    self.log
                        .warning(format!("accept failed ({:?})", error.kind()));
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let api = self.clone();
            tokio::spawn(async move {
                let timeout = api.request_timeout;
                let service = service_fn(move |request| {
                    let api = api.clone();
                    async move { Ok::<_, Infallible>(api.handle(request).await) }
                });
                let _ = http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(timeout)
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    }
}

/// Serve `GET /metrics` (Prometheus text format) on `listener` until `shutdown` resolves; every other request is 404.
/// No credential: keep this port where only the scraper can reach it.
pub async fn serve_metrics(
    chat: Arc<Chat>,
    listener: TcpListener,
    shutdown: impl Future<Output = ()>,
    log: Log,
) {
    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut shutdown => return,
        };
        let stream = match accepted {
            Ok((stream, _)) => stream,
            Err(error) => {
                log.warning(format!("metrics accept failed ({:?})", error.kind()));
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let chat = chat.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request: Request<Incoming>| {
                let chat = chat.clone();
                async move {
                    let response = if request.method() == Method::GET
                        && request.uri().path() == "/metrics"
                    {
                        let text = tokio::task::spawn_blocking(move || chat.metrics())
                            .await
                            .unwrap_or_default();
                        let mut response = Response::new(full(text));
                        response.headers_mut().insert(
                            CONTENT_TYPE,
                            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
                        );
                        response
                    } else {
                        json_response(
                            404,
                            &json!({"error": "not_found", "message": "Không có route này."}),
                        )
                    };
                    Ok::<_, Infallible>(response)
                }
            });
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(15))
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}
