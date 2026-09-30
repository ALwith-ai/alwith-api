//! Rust client for `alwith-runtime-v1`. The host (Desktop) and module subprocesses use it to talk
//! to Runtime; the frames are identical to the TS
//! `FrameHubPort`: requests `{id, method, params}`, responses `{id, result | error}`, events carry
//! `type`.
//!
//! Two ways to connect: [`RuntimeClient::spawn`] starts an `alwith-runtime --listen stdio://` child
//! process and takes over its pipes;
//! [`RuntimeClient::over`] attaches to any pair of read/write streams (tests, unix socket). Events
//! are broadcast via [`RuntimeClient::events`],
//! and a slow consumer receives `Lagged`, equivalent to the stdio entry's `lagged` event: refill
//! with `session_events`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::{AttachInfo, ResponseError, RuntimeEvent, SessionEventFrame, SessionLifecycleFrame, SessionRunState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// An event frame coming from Runtime. Protocol events are decoded as [`RuntimeEvent`]; host
/// extension events go to `Other`.
///
/// Delivery promise: every journaled frame of a session (outbound / acpNotification /
/// acpAgentRequest carrying `session_id` + `sequence`)
/// is delivered to subscribers in journal order, exactly once. Runtime drops events and sends
/// `lagged` when the stdio host cannot keep up,
/// and a slow ws connection is disconnected; here gaps are detected by sequence number, refilled
/// first via `sessionEvents`, and only then are later frames delivered.
/// A span that is gone from the journal too is reported as `Gap`, never pretending to be
/// continuous.
#[derive(Clone, Debug)]
pub enum ClientEvent {
    Runtime(RuntimeEvent),
    /// A span that cannot be refilled: the journal has lost `from..=to` and nothing of it was
    /// delivered; the app should reload this session.
    Gap {
        session_id: String,
        from: u64,
        to: u64,
    },
    Other(Value),
    /// Read side ended: the peer exited or stdin hit EOF. Afterwards every `request` errors; a
    /// module receiving this should wrap up.
    Closed {
        reason: String,
    },
}

#[derive(Debug, Serialize)]
struct RequestEnvelope<'a> {
    id: u64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ResponseEnvelope {
    id: u64,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<ResponseError>,
}

/// The answer to `cliStatus`.
/// How to answer requests coming from the peer (Runtime): a module subprocess uses it to serve
/// calls forwarded from `modules/<name>/<method>`.
pub type RequestHandler = Arc<
    dyn Fn(String, Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, ResponseError>> + Send>>
        + Send
        + Sync,
>;

/// Frames per page when refilling; Runtime returns at most 2000 per page.
const REFILL_PAGE: usize = 2_000;
/// Maximum extra refill rounds when frames slip in during a refill, after which Gap is reported.
const REFILL_ROUNDS: u32 = 2;

/// Where a session has got to in the journal.
struct SessionCursor {
    agent_id: String,
    /// Last delivered sequence number; None before the first sequenced frame.
    last: Option<u64>,
    refilling: bool,
    /// Live frames that arrived during a refill, delivered in order once it finishes.
    parked: Vec<(u64, RuntimeEvent)>,
}

enum Verdict {
    Deliver,
    Duplicate,
    Gap,
}

/// This frame relative to the last delivered one: the next number (or first sighting) is delivered;
/// a 0 after a higher number means the engine replayed history
/// (a resume with `replayFrom` clears the journal) and is also delivered; a number not above last
/// is a duplicate; a later one means something in between was lost.
fn verdict(last: Option<u64>, sequence: u64) -> Verdict {
    match last {
        None => Verdict::Deliver,
        Some(last) if sequence == last + 1 => Verdict::Deliver,
        Some(last) if sequence == 0 && last > 0 => Verdict::Deliver,
        Some(last) if sequence <= last => Verdict::Duplicate,
        Some(_) => Verdict::Gap,
    }
}

/// Journal position on a live event: only the three journaled event kinds have one.
fn journal_position(event: &RuntimeEvent) -> Option<(String, u64, String)> {
    match event {
        RuntimeEvent::Outbound { agent_id, session_id: Some(session_id), sequence: Some(sequence), .. }
        | RuntimeEvent::AcpNotification { agent_id, session_id: Some(session_id), sequence: Some(sequence), .. }
        | RuntimeEvent::AcpAgentRequest { agent_id, session_id: Some(session_id), sequence: Some(sequence), .. } => {
            Some((session_id.clone(), *sequence, agent_id.clone()))
        }
        _ => None,
    }
}

/// A frame in the journal, restored as it looked when it was a live event. Response frames (answers
/// to our own requests) are not replayable.
fn journaled_event(agent_id: &str, session_id: &str, frame: &SessionEventFrame) -> Option<RuntimeEvent> {
    let position = (Some(session_id.to_string()), Some(frame.sequence));
    if frame.direction == crate::FrameDirection::Out {
        return Some(RuntimeEvent::Outbound {
            agent_id: agent_id.to_string(),
            line: frame.line.clone(),
            session_id: position.0,
            sequence: position.1,
        });
    }
    let value: Value = serde_json::from_str(&frame.line).ok()?;
    let method = value.get("method").and_then(Value::as_str)?.to_string();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    Some(match value.get("id") {
        Some(id) if !id.is_null() => RuntimeEvent::AcpAgentRequest {
            agent_id: agent_id.to_string(),
            id: id.clone(),
            method,
            params,
            session_id: position.0,
            sequence: position.1,
        },
        _ => RuntimeEvent::AcpNotification {
            agent_id: agent_id.to_string(),
            method,
            params,
            session_id: position.0,
            sequence: position.1,
        },
    })
}

struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, ResponseError>>>>,
    /// One unbounded queue per subscriber: nothing is lost in-process, a slow consumer just uses a
    /// bit more memory, so there is no second drop point.
    subscribers: Mutex<Vec<mpsc::UnboundedSender<ClientEvent>>>,
    cursors: Mutex<HashMap<String, SessionCursor>>,
    next_id: AtomicU64,
    closed: Mutex<Option<String>>,
    closed_notify: tokio::sync::Notify,
    handler: Option<RequestHandler>,
    /// Answering peer requests, sending events, and refill requests all go through this write end
    /// (the same stream as `RuntimeClient::writer`).
    outbound: mpsc::UnboundedSender<String>,
}

impl Shared {
    fn emit(&self, event: ClientEvent) {
        self.subscribers.lock().unwrap().retain(|subscriber| subscriber.send(event.clone()).is_ok());
    }

    /// Requests issued inside the read loop (for refill): written out via `outbound`, with
    /// responses still paired by the read loop.
    async fn request(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, ResponseError> {
        if let Some(reason) = self.closed.lock().unwrap().clone() {
            return Err(ResponseError::connection_lost(format!("{method}: {reason}")));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let mut line =
            serde_json::to_string(&RequestEnvelope { id, method, params: Some(params) }).expect("serialize request");
        line.push('\n');
        if self.outbound.send(line).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(ResponseError::connection_lost(format!("{method}: connection closed")));
        }
        match receiver.await {
            Ok(result) => result,
            Err(_) => Err(ResponseError::connection_lost(format!("{method}: connection closed"))),
        }
    }

    /// A live event with a journal position: deliver, queue, drop a duplicate, or start a refill
    /// round for a hole before it.
    fn route(self: &Arc<Self>, event: RuntimeEvent) {
        let Some((session_id, sequence, agent_id)) = journal_position(&event) else {
            self.emit(ClientEvent::Runtime(event));
            return;
        };
        let mut cursors = self.cursors.lock().unwrap();
        let cursor = cursors.entry(session_id.clone()).or_insert_with(|| SessionCursor {
            agent_id: agent_id.clone(),
            last: None,
            refilling: false,
            parked: Vec::new(),
        });
        cursor.agent_id = agent_id;
        if cursor.refilling {
            cursor.parked.push((sequence, event));
            return;
        }
        match verdict(cursor.last, sequence) {
            Verdict::Deliver => {
                cursor.last = Some(sequence);
                drop(cursors);
                self.emit(ClientEvent::Runtime(event));
            }
            Verdict::Duplicate => {}
            Verdict::Gap => {
                cursor.refilling = true;
                cursor.parked.push((sequence, event));
                drop(cursors);
                tokio::spawn(Arc::clone(self).refill(session_id, 0));
            }
        }
    }

    /// After Runtime says it dropped events (`lagged`) or after a reconnect: every followed session
    /// refills from the last sequence seen.
    fn refill_all(self: &Arc<Self>) {
        let mut cursors = self.cursors.lock().unwrap();
        for (session_id, cursor) in cursors.iter_mut() {
            if cursor.last.is_some() && !cursor.refilling {
                cursor.refilling = true;
                tokio::spawn(Arc::clone(self).refill(session_id.clone(), 0));
            }
        }
    }

    /// Pull `sessionEvents` from the last delivered sequence onward, deliver in order, then deliver
    /// the live frames accumulated during the refill.
    /// A span missing from the journal too is reported once as a Gap.
    async fn refill(self: Arc<Self>, session_id: String, round: u32) {
        let (mut after, agent_id) = {
            let cursors = self.cursors.lock().unwrap();
            let cursor = &cursors[&session_id];
            (cursor.last.unwrap_or(0), cursor.agent_id.clone())
        };
        let mut first = true;
        loop {
            let params = serde_json::json!({ "sessionId": session_id, "afterSequence": after, "limit": REFILL_PAGE });
            let frames: Vec<SessionEventFrame> = match self.request("sessionEvents", params).await {
                Ok(value) => serde_json::from_value(value).unwrap_or_default(),
                // Connection gone: the reconnect path will refill again; deliver what has
                // accumulated first.
                Err(_) => break,
            };
            if frames.is_empty() {
                break;
            }
            if first && frames[0].sequence > after + 1 {
                self.emit(ClientEvent::Gap {
                    session_id: session_id.clone(),
                    from: after + 1,
                    to: frames[0].sequence - 1,
                });
            }
            first = false;
            let page = frames.len();
            for frame in frames {
                if frame.sequence <= after {
                    continue;
                }
                if let Some(event) = journaled_event(&agent_id, &session_id, &frame) {
                    self.emit(ClientEvent::Runtime(event));
                }
                after = frame.sequence;
                self.cursors.lock().unwrap().get_mut(&session_id).expect("cursor").last = Some(after);
            }
            if page < REFILL_PAGE {
                break;
            }
        }
        // Deliver the accumulated live frames in order; if holes remain after refilling, refill
        // another round, reporting Gap only once rounds run out. Deliver while holding the lock:
        // emit only puts into a queue and waits for no one.
        // The lock's scope must end before the awaits below (block expression), otherwise this
        // future is not Send.
        let another_round = {
            let mut cursors = self.cursors.lock().unwrap();
            let cursor = cursors.get_mut(&session_id).expect("cursor");
            let mut parked = std::mem::take(&mut cursor.parked);
            parked.sort_by_key(|(sequence, _)| *sequence);
            let mut still_missing = Vec::new();
            for (sequence, event) in parked {
                match verdict(cursor.last, sequence) {
                    Verdict::Duplicate => continue,
                    Verdict::Gap if round < REFILL_ROUNDS => {
                        still_missing.push((sequence, event));
                        continue;
                    }
                    Verdict::Gap => self.emit(ClientEvent::Gap {
                        session_id: session_id.clone(),
                        from: cursor.last.map_or(0, |last| last + 1),
                        to: sequence - 1,
                    }),
                    Verdict::Deliver => {}
                }
                cursor.last = Some(sequence);
                self.emit(ClientEvent::Runtime(event));
            }
            if still_missing.is_empty() {
                cursor.refilling = false;
                false
            } else {
                cursor.parked = still_missing;
                true
            }
        };
        if another_round {
            Box::pin(self.refill(session_id, round + 1)).await;
        }
    }
}

pub struct RuntimeClient {
    writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    shared: Arc<Shared>,
    reader_task: JoinHandle<()>,
    child: Mutex<Option<Child>>,
}

impl RuntimeClient {
    /// Spawn the Runtime child process (stdin / stdout taken over, stderr inherited to the host
    /// log) and wait for its `ready` line.
    pub async fn spawn(mut command: Command) -> std::io::Result<Self> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        loop {
            first.clear();
            if reader.read_line(&mut first).await? == 0 {
                return Err(std::io::Error::other("alwith-runtime closed stdout before ready"));
            }
            let value: Value = match serde_json::from_str(first.trim()) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if value.get("type").and_then(Value::as_str) == Some("ready") {
                break;
            }
        }
        let client = Self::over(reader, stdin);
        *client.child.lock().unwrap() = Some(child);
        Ok(client)
    }

    /// A connection over any pair of streams. One frame per line on `reader`; one line per frame on
    /// `writer`.
    pub fn over<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::over_with_handler(reader, writer, None)
    }

    /// Same as above, and also serves requests sent by the peer: a module subprocess is exactly
    /// such a "client that also gets called".
    pub fn over_with_handler<R, W>(reader: R, writer: W, handler: Option<RequestHandler>) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let (outbound, outbound_receiver) = mpsc::unbounded_channel::<String>();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            cursors: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: Mutex::new(None),
            closed_notify: tokio::sync::Notify::new(),
            handler,
            outbound,
        });
        let writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>> =
            Arc::new(tokio::sync::Mutex::new(Box::new(writer)));
        tokio::spawn(write_loop(Arc::clone(&writer), outbound_receiver));
        let reader_task = tokio::spawn(read_loop(BufReader::new(reader), Arc::clone(&shared)));
        Self { writer, shared, reader_task, child: Mutex::new(None) }
    }

    /// Send an event frame (`{"type": ...}`). Events sent by a module are wrapped by Runtime as
    /// `{"type":"module"}` and broadcast to apps.
    pub fn emit(&self, event: Value) -> Result<(), ResponseError> {
        let mut line = event.to_string();
        line.push('\n');
        self.shared.outbound.send(line).map_err(|_| ResponseError::connection_lost("connection closed"))
    }

    /// Subscribe to events. One unbounded queue per subscriber: nothing is lost in-process, `None`
    /// means the client has been dropped.
    /// Session events arrive in order, exactly once (see [`ClientEvent`]); a hole that cannot be
    /// refilled is `ClientEvent::Gap`.
    pub fn events(&self) -> mpsc::UnboundedReceiver<ClientEvent> {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.shared.subscribers.lock().unwrap().push(sender);
        receiver
    }

    /// Any method, including host extensions. An error is the `error` in the response frame (code /
    /// message / data unchanged);
    /// a lost connection is `ResponseError::CONNECTION_LOST`.
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, ResponseError> {
        if let Some(reason) = self.shared.closed.lock().unwrap().clone() {
            return Err(ResponseError::connection_lost(format!("{method}: {reason}")));
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.shared.pending.lock().unwrap().insert(id, sender);
        let mut line = serde_json::to_string(&RequestEnvelope { id, method, params }).expect("serialize request");
        line.push('\n');
        {
            let mut writer = self.writer.lock().await;
            if let Err(error) = writer.write_all(line.as_bytes()).await.and(writer.flush().await) {
                self.shared.pending.lock().unwrap().remove(&id);
                return Err(ResponseError::connection_lost(format!("{method}: write failed: {error}")));
            }
        }
        match receiver.await {
            Ok(result) => result,
            Err(_) => Err(ResponseError::connection_lost(format!("{method}: connection closed"))),
        }
    }

    async fn typed<T: serde::de::DeserializeOwned>(
        &self, method: &str, params: Option<Value>,
    ) -> Result<T, ResponseError> {
        let value = self.request(method, params).await?;
        serde_json::from_value(value).map_err(|error| ResponseError::runtime(format!("{method}: bad result: {error}")))
    }

    fn with_owner(mut params: Value, owner: Option<&str>) -> Value {
        if let Some(owner) = owner {
            params["owner"] = Value::String(owner.to_string());
        }
        params
    }

    /// `owner`: sub-owner under the connection (desktop window label); None means the connection
    /// itself, which has write access to the agents of all sub-owners.
    /// `launch` is the launch parameters on top of Runtime's engine table `{engine, cwd, args, env,
    /// provider, model, connection}`.
    /// Start an agent process. Errors if a process of the same name is still alive: switching
    /// engine is "stop first, wait for the Exit event, then start".
    pub async fn start(&self, agent_id: &str, launch: Value, owner: Option<&str>) -> Result<(), ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "agentId": agent_id, "launch": launch }), owner);
        self.request("start", Some(params)).await.map(|_| ())
    }

    pub async fn send(&self, agent_id: &str, line: &str, owner: Option<&str>) -> Result<(), ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "agentId": agent_id, "line": line }), owner);
        self.request("send", Some(params)).await.map(|_| ())
    }

    pub async fn stop(&self, agent_id: &str, owner: Option<&str>) -> Result<(), ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "agentId": agent_id }), owner);
        self.request("stop", Some(params)).await.map(|_| ())
    }

    pub async fn attach_session(
        &self, session_id: &str, owner: Option<&str>,
    ) -> Result<Option<AttachInfo>, ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "sessionId": session_id }), owner);
        self.typed("attachSession", Some(params)).await
    }

    pub async fn release_session(&self, session_id: &str, owner: Option<&str>) -> Result<(), ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "sessionId": session_id }), owner);
        self.request("releaseSession", Some(params)).await.map(|_| ())
    }

    pub async fn stop_session(&self, session_id: &str, owner: Option<&str>) -> Result<(), ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "sessionId": session_id }), owner);
        self.request("stopSession", Some(params)).await.map(|_| ())
    }

    pub async fn detach_owner(&self, owner: &str) -> Result<(), ResponseError> {
        self.request("detachOwner", Some(serde_json::json!({ "owner": owner }))).await.map(|_| ())
    }

    pub async fn release_execution(&self, execution_id: &str) -> Result<bool, ResponseError> {
        self.typed("releaseExecution", Some(serde_json::json!({ "executionId": execution_id }))).await
    }

    pub async fn agent_for_session(&self, session_id: &str) -> Result<Option<String>, ResponseError> {
        self.typed("agentForSession", Some(serde_json::json!({ "sessionId": session_id }))).await
    }

    pub async fn session_replay(&self, session_id: &str) -> Result<Vec<String>, ResponseError> {
        self.typed("sessionReplay", Some(serde_json::json!({ "sessionId": session_id }))).await
    }

    pub async fn set_slow_mode(&self, delay_ms: u64) -> Result<(), ResponseError> {
        self.request("setSlowMode", Some(serde_json::json!({ "delayMs": delay_ms }))).await.map(|_| ())
    }

    pub async fn mark_read(&self, session_id: &str) -> Result<(), ResponseError> {
        self.request("markRead", Some(serde_json::json!({ "sessionId": session_id }))).await.map(|_| ())
    }

    pub async fn set_session_title(&self, session_id: &str, title: &str) -> Result<(), ResponseError> {
        self.request("setSessionTitle", Some(serde_json::json!({ "sessionId": session_id, "title": title })))
            .await
            .map(|_| ())
    }

    pub async fn session_lifecycle(&self, session_id: &str) -> Result<Vec<SessionLifecycleFrame>, ResponseError> {
        self.typed("sessionLifecycle", Some(serde_json::json!({ "sessionId": session_id }))).await
    }

    pub async fn session_events(
        &self, session_id: &str, after_sequence: Option<u64>, limit: Option<usize>,
    ) -> Result<Vec<SessionEventFrame>, ResponseError> {
        self.typed(
            "sessionEvents",
            Some(serde_json::json!({ "sessionId": session_id, "afterSequence": after_sequence, "limit": limit })),
        )
        .await
    }

    pub async fn run_states(&self) -> Result<Vec<SessionRunState>, ResponseError> {
        self.typed("runStates", None).await
    }

    /// Runtime's own version (the same number as `alwith-runtime --version`).
    pub async fn version(&self) -> Result<String, ResponseError> {
        self.typed("version", None).await
    }

    pub async fn agents(&self) -> Result<Vec<Value>, ResponseError> {
        self.typed("agents", None).await
    }

    pub async fn ping(&self) -> Result<(), ResponseError> {
        self.request("ping", None).await.map(|_| ())
    }

    // ---- ACP: Runtime speaks ACP v2 on your behalf. The raw send / inbound remain available. ----

    /// Any ACP request; Runtime assigns the id and awaits the response. `request_id`: pick your own
    /// id (needed only to retract with `$/cancel_request`).
    pub async fn acp_request(
        &self, agent_id: &str, method: &str, params: Value, request_id: Option<Value>, owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let mut params = serde_json::json!({ "agentId": agent_id, "method": method, "params": params });
        if let Some(id) = request_id {
            params["id"] = id;
        }
        self.request("acpRequest", Some(Self::with_owner(params, owner))).await
    }

    pub async fn acp_notify(
        &self, agent_id: &str, method: &str, params: Value, owner: Option<&str>,
    ) -> Result<(), ResponseError> {
        let params =
            Self::with_owner(serde_json::json!({ "agentId": agent_id, "method": method, "params": params }), owner);
        self.request("acpNotify", Some(params)).await.map(|_| ())
    }

    /// Answer an agent request (the `id` in `RuntimeEvent::AcpAgentRequest`).
    pub async fn acp_respond(
        &self, agent_id: &str, id: Value, result: Option<Value>, error: Option<Value>, owner: Option<&str>,
    ) -> Result<(), ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "id": id, "result": result, "error": error }),
            owner,
        );
        self.request("acpRespond", Some(params)).await.map(|_| ())
    }

    /// ACP handshake, optionally with your own client info and capabilities; returns the cached
    /// result if already done. Session methods handshake automatically with a default identity;
    /// call this only to declare capabilities.
    pub async fn initialize(
        &self, agent_id: &str, info: Option<Value>, capabilities: Option<Value>, owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "info": info, "capabilities": capabilities }),
            owner,
        );
        self.request("initialize", Some(params)).await
    }

    /// Create a session (handshaking first if needed). Returns the ACP `session/new` result,
    /// containing `sessionId`.
    pub async fn session_new(
        &self, agent_id: &str, cwd: &str, mcp_servers: Vec<Value>, meta: Option<Value>, owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "cwd": cwd, "mcpServers": mcp_servers, "meta": meta }),
            owner,
        );
        self.request("sessionNew", Some(params)).await
    }

    pub async fn session_load(
        &self, agent_id: &str, session_id: &str, cwd: &str, mcp_servers: Vec<Value>, meta: Option<Value>,
        owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers, "meta": meta }),
            owner,
        );
        self.request("sessionLoad", Some(params)).await
    }

    pub async fn session_resume(
        &self, agent_id: &str, session_id: &str, cwd: &str, replay_from: Option<Value>, meta: Option<Value>,
        owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "sessionId": session_id, "cwd": cwd, "replayFrom": replay_from, "meta": meta }),
            owner,
        );
        self.request("sessionResume", Some(params)).await
    }

    pub async fn session_fork(
        &self, agent_id: &str, session_id: &str, cwd: &str, mcp_servers: Vec<Value>, meta: Option<Value>,
        owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers, "meta": meta }),
            owner,
        );
        self.request("sessionFork", Some(params)).await
    }

    /// One turn, returns only when the turn ends (`{stopReason, _meta}`); progress arrives as
    /// `AcpNotification` events.
    pub async fn prompt(
        &self, agent_id: &str, session_id: &str, prompt: Value, meta: Option<Value>, owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "sessionId": session_id, "prompt": prompt, "meta": meta }),
            owner,
        );
        self.request("prompt", Some(params)).await
    }

    pub async fn cancel(&self, agent_id: &str, session_id: &str, owner: Option<&str>) -> Result<(), ResponseError> {
        let params = Self::with_owner(serde_json::json!({ "agentId": agent_id, "sessionId": session_id }), owner);
        self.request("cancel", Some(params)).await.map(|_| ())
    }

    /// Kill the child process immediately (exit fallback; the normal path uses `shutdown`). No-op
    /// if there is no child process.
    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }

    /// Whether the connection is already down (read side ended or child process exited).
    pub fn closed(&self) -> Option<String> {
        self.shared.closed.lock().unwrap().clone()
    }

    /// Exit chain: first ask Runtime to leave (the `shutdown` method; it gives modules and agents a
    /// 2-second wind-down window and then kill_all), and wait for the connection to end;
    /// if it has not ended within `grace`, force-kill the child process. Killing directly would
    /// leave the agent's spawned process groups alive, so courtesy first, force second.
    /// Difference from [`Self::shutdown`]: it does not consume self, so a host holding an
    /// `Arc<RuntimeClient>` can call it too.
    pub async fn close(&self, grace: std::time::Duration) {
        let deadline = tokio::time::Instant::now() + grace;
        // Register the wait first, then check whether it is already closed: `notify_waiters` only
        // wakes registered waiters, otherwise a receipt arriving together with EOF would be missed.
        let closed = self.shared.closed_notify.notified();
        tokio::pin!(closed);
        closed.as_mut().enable();
        if self.closed().is_none() {
            let _ = tokio::time::timeout_at(deadline, self.request("shutdown", None)).await;
            if self.closed().is_none() {
                let _ = tokio::time::timeout_at(deadline, closed).await;
            }
        }
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }

    /// Close the write end (Runtime kill_all's and exits on EOF), wait for the read side to end;
    /// reap the child process if there is one.
    pub async fn shutdown(mut self) {
        {
            let mut writer = self.writer.lock().await;
            let _ = writer.shutdown().await;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), &mut self.reader_task).await;
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

impl Drop for RuntimeClient {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}

async fn write_loop(
    writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>>, mut receiver: mpsc::UnboundedReceiver<String>,
) {
    while let Some(line) = receiver.recv().await {
        let mut writer = writer.lock().await;
        if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
            break;
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(mut reader: BufReader<R>, shared: Arc<Shared>) {
    let mut line = String::new();
    let mut handlers = tokio::task::JoinSet::<String>::new();
    let mut active = std::collections::HashMap::<String, tokio::task::AbortHandle>::new();
    let reason = loop {
        while let Some(result) = handlers.try_join_next() {
            if let Ok(id) = result {
                active.remove(&id);
            }
        }
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break "connection closed".to_string(),
            Ok(_) => {}
            Err(error) => break format!("read failed: {error}"),
        }
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("[alwith-api] unparseable frame: {error}");
                continue;
            }
        };
        // Recognize events first: an event frame may also carry `method` (e.g. acpNotification) and
        // must not be taken for a request from the peer.
        if value.get("type").is_some() {
            match value.get("type").and_then(Value::as_str) {
                // Runtime dropped events on this connection: refill every followed session.
                Some("lagged") => shared.refill_all(),
                _ => match serde_json::from_value::<RuntimeEvent>(value.clone()) {
                    Ok(event) => shared.route(event),
                    Err(_) => shared.emit(ClientEvent::Other(value)),
                },
            }
            continue;
        }
        if value.get("method").is_some() {
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let method = value.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if method == "_runtime/cancel" {
                if let Some(handle) = params.get("id").and_then(|id| active.remove(&id.to_string())) {
                    handle.abort();
                }
                continue;
            }
            let key = id.to_string();
            if !id.is_null() && active.get(&key).is_some_and(|handle| !handle.is_finished()) {
                continue; // A duplicate active request must never execute twice.
            }
            let shared = Arc::clone(&shared);
            let task_key = key.clone();
            let task = handlers.spawn(async move {
                let response = match &shared.handler {
                    Some(handler) => match handler(method.clone(), params).await {
                        Ok(result) => serde_json::json!({ "id": id, "result": result, "error": null }),
                        Err(error) => serde_json::json!({ "id": id, "result": null, "error": error }),
                    },
                    None => serde_json::json!({ "id": id, "result": null, "error": ResponseError::method_not_found(&method) }),
                };
                if !id.is_null() {
                    let mut line = response.to_string();
                    line.push('\n');
                    let _ = shared.outbound.send(line);
                }
                task_key
            });
            active.insert(key, task);
            continue;
        }
        match serde_json::from_value::<ResponseEnvelope>(value) {
            Ok(response) => {
                if let Some(sender) = shared.pending.lock().unwrap().remove(&response.id) {
                    let _ = sender.send(match response.error {
                        Some(error) => Err(error),
                        None => Ok(response.result),
                    });
                }
            }
            Err(error) => log::warn!("[alwith-api] frame is neither event nor response: {error}"),
        }
    };
    handlers.abort_all();
    while handlers.join_next().await.is_some() {}
    *shared.closed.lock().unwrap() = Some(reason.clone());
    let pending: Vec<_> = shared.pending.lock().unwrap().drain().collect();
    for (_, sender) in pending {
        let _ = sender.send(Err(ResponseError::connection_lost(reason.clone())));
    }
    shared.emit(ClientEvent::Closed { reason });
    shared.closed_notify.notify_waiters();
}

#[cfg(test)]
mod tests {
    //! Runs against a fake peer (a small loop answering frames per the protocol), no real Runtime
    //! needed; round-trip tests against a real Runtime live in the Runtime repo.
    use super::*;
    use tokio::io::{AsyncWriteExt, DuplexStream};

    /// Fake peer: `ping` answers `"pong"`, `nope` answers an error, a `lines` request makes it
    /// broadcast one lines event; event frames received are written back as is.
    fn fake_peer() -> (RuntimeClient, JoinHandle<Vec<Value>>) {
        let (client_reader, peer_writer) = tokio::io::duplex(64 * 1024);
        let (peer_reader, client_writer) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(run_fake_peer(peer_reader, peer_writer));
        (RuntimeClient::over(client_reader, client_writer), task)
    }

    async fn run_fake_peer(reader: DuplexStream, mut writer: DuplexStream) -> Vec<Value> {
        let mut lines = BufReader::new(reader).lines();
        let mut seen_events = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let value: Value = serde_json::from_str(&line).unwrap();
            let reply = match value.get("method").and_then(Value::as_str) {
                Some("ping") => serde_json::json!({ "id": value["id"], "result": "pong", "error": null }),
                Some("nope") => {
                    serde_json::json!({ "id": value["id"], "result": null, "error": { "code": -32601, "message": "unknown method nope" } })
                }
                Some("lines") => {
                    let event = serde_json::json!({ "type": "inbound", "agentId": "a", "lines": ["x", "y"] });
                    writer.write_all(format!("{event}\n").as_bytes()).await.unwrap();
                    serde_json::json!({ "id": value["id"], "result": null, "error": null })
                }
                Some("hang") => continue,
                Some(_) => unreachable!("unexpected request {line}"),
                None => {
                    seen_events.push(value);
                    continue;
                }
            };
            writer.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
        }
        seen_events
    }

    /// Fake peer with a journal: `sessionEvents` answers from the given frames by afterSequence;
    /// after the `shutdown` receipt it closes its own write end.
    /// The test uses `push` to inject event frames into the client.
    fn fake_peer_with_journal(journal: Vec<Value>) -> (RuntimeClient, mpsc::UnboundedSender<Value>) {
        let (client_reader, mut peer_writer) = tokio::io::duplex(64 * 1024);
        let (peer_reader, client_writer) = tokio::io::duplex(64 * 1024);
        let (push, mut pushed) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(peer_reader).lines();
            loop {
                let reply = tokio::select! {
                    Some(event) = pushed.recv() => event,
                    line = lines.next_line() => {
                        let Ok(Some(line)) = line else { break };
                        let value: Value = serde_json::from_str(&line).unwrap();
                        match value.get("method").and_then(Value::as_str) {
                            Some("sessionEvents") => {
                                let after = value["params"]["afterSequence"].as_u64();
                                let frames: Vec<&Value> = journal
                                    .iter()
                                    .filter(|frame| after.is_none_or(|after| frame["sequence"].as_u64().unwrap() > after))
                                    .collect();
                                serde_json::json!({ "id": value["id"], "result": frames, "error": null })
                            }
                            Some("shutdown") => {
                                let receipt = serde_json::json!({ "id": value["id"], "result": null, "error": null });
                                peer_writer.write_all(format!("{receipt}\n").as_bytes()).await.unwrap();
                                break;
                            }
                            _ => serde_json::json!({ "id": value["id"], "result": null, "error": null }),
                        }
                    }
                };
                peer_writer.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
            }
        });
        (RuntimeClient::over(client_reader, client_writer), push)
    }

    fn update(sequence: u64) -> Value {
        serde_json::json!({
            "type": "acpNotification", "agentId": "a", "method": "session/update",
            "params": { "sessionId": "s-1", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": format!("t{sequence}") } } },
            "sessionId": "s-1", "sequence": sequence
        })
    }

    fn journaled(sequence: u64) -> Value {
        let line = serde_json::json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": { "sessionId": "s-1", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": format!("t{sequence}") } } }
        });
        serde_json::json!({ "sequence": sequence, "recordedAt": 1, "direction": "in", "line": line.to_string() })
    }

    /// Collect `count` session events (or a Gap), returning the sequence of numbers; a Gap is
    /// recorded as `None`.
    async fn collect(events: &mut mpsc::UnboundedReceiver<ClientEvent>, count: usize) -> Vec<Option<u64>> {
        let mut seen = Vec::new();
        while seen.len() < count {
            let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                .await
                .expect("event before deadline")
                .expect("client alive");
            match event {
                ClientEvent::Runtime(RuntimeEvent::AcpNotification { sequence, .. }) => seen.push(sequence),
                ClientEvent::Gap { from, to, .. } => {
                    assert_eq!((from, to), (1, 3));
                    seen.push(None);
                }
                _ => {}
            }
        }
        seen
    }

    #[tokio::test]
    async fn a_skipped_sequence_is_refilled_from_the_journal_before_later_frames() {
        let (client, push) = fake_peer_with_journal(vec![journaled(0), journaled(1), journaled(2), journaled(3)]);
        let mut events = client.events();
        push.send(update(0)).unwrap();
        push.send(update(1)).unwrap();
        push.send(update(3)).unwrap();
        push.send(update(4)).unwrap();
        assert_eq!(collect(&mut events, 5).await, vec![Some(0), Some(1), Some(2), Some(3), Some(4)]);
    }

    #[tokio::test]
    async fn what_the_journal_lost_is_reported_as_a_gap_not_hidden() {
        let (client, push) = fake_peer_with_journal(vec![journaled(4), journaled(5)]);
        let mut events = client.events();
        push.send(update(0)).unwrap();
        push.send(update(5)).unwrap();
        assert_eq!(collect(&mut events, 4).await, vec![Some(0), None, Some(4), Some(5)]);
    }

    #[tokio::test]
    async fn lagged_refills_every_followed_session_and_duplicates_are_dropped() {
        let (client, push) = fake_peer_with_journal(vec![journaled(0), journaled(1), journaled(2)]);
        let mut events = client.events();
        push.send(update(0)).unwrap();
        push.send(serde_json::json!({ "type": "lagged", "dropped": 2 })).unwrap();
        push.send(update(2)).unwrap();
        push.send(update(3)).unwrap();
        // 0 live; after lagged refill 1, 2; live 2 is a duplicate, dropped; 3 joins on.
        assert_eq!(collect(&mut events, 4).await, vec![Some(0), Some(1), Some(2), Some(3)]);
    }

    #[tokio::test]
    async fn close_asks_the_runtime_to_shut_down_and_waits_for_the_connection_to_end() {
        let (client, _push) = fake_peer_with_journal(Vec::new());
        let mut events = client.events();
        tokio::time::timeout(std::time::Duration::from_secs(2), client.close(std::time::Duration::from_secs(5)))
            .await
            .expect("close returns once the peer hangs up, not after the grace");
        assert!(client.closed().is_some());
        assert!(matches!(events.recv().await.unwrap(), ClientEvent::Closed { .. }));
    }

    #[tokio::test]
    async fn requests_round_trip_and_errors_arrive_as_sent() {
        let (client, _peer) = fake_peer();
        assert_eq!(client.request("ping", None).await.unwrap(), Value::String("pong".into()));
        let error = client.request("nope", None).await.unwrap_err();
        assert_eq!(error, ResponseError::new(ResponseError::METHOD_NOT_FOUND, "unknown method nope"));
    }

    #[tokio::test]
    async fn protocol_events_are_typed_and_others_pass_through() {
        let (client, _peer) = fake_peer();
        let mut events = client.events();
        client.request("lines", None).await.unwrap();
        match events.recv().await.unwrap() {
            ClientEvent::Runtime(RuntimeEvent::Inbound { agent_id, lines }) => {
                assert_eq!(agent_id, "a");
                assert_eq!(lines, vec!["x".to_string(), "y".to_string()]);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn peer_requests_reach_the_handler_and_emitted_events_reach_the_peer() {
        let (client_reader, mut peer_writer) = tokio::io::duplex(64 * 1024);
        let (peer_reader, client_writer) = tokio::io::duplex(64 * 1024);
        let handler: RequestHandler = Arc::new(|method, params| {
            Box::pin(async move {
                if method == "echo" { Ok(params) } else { Err(ResponseError::runtime(format!("unknown {method}"))) }
            })
        });
        let client = RuntimeClient::over_with_handler(client_reader, client_writer, Some(handler));
        let mut peer_lines = BufReader::new(peer_reader).lines();

        peer_writer.write_all(b"{\"id\":5,\"method\":\"echo\",\"params\":{\"x\":1}}\n").await.unwrap();
        let reply: Value = serde_json::from_str(&peer_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(reply, serde_json::json!({ "id": 5, "result": { "x": 1 }, "error": null }));

        peer_writer.write_all(b"{\"id\":6,\"method\":\"nope\"}\n").await.unwrap();
        let reply: Value = serde_json::from_str(&peer_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(
            reply["error"],
            serde_json::json!({ "code": ResponseError::RUNTIME, "message": "unknown nope", "data": null })
        );

        client.emit(serde_json::json!({ "type": "statusChanged", "statuses": [] })).unwrap();
        let event: Value = serde_json::from_str(&peer_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(event["type"], "statusChanged");
    }

    #[tokio::test]
    async fn closing_the_stream_fails_pending_requests_and_broadcasts_closed() {
        let (client_reader, peer_writer) = tokio::io::duplex(64 * 1024);
        let (_peer_reader, client_writer) = tokio::io::duplex(64 * 1024);
        let client = RuntimeClient::over(client_reader, client_writer);
        let mut events = client.events();
        let pending = tokio::spawn({
            let client = Arc::new(client);
            let client_for_task = Arc::clone(&client);
            async move { (client, client_for_task.request("hang", None).await) }
        });
        drop(peer_writer);
        let (client, result) = pending.await.unwrap();
        assert_eq!(result.unwrap_err(), ResponseError::connection_lost("hang: connection closed"));
        assert_eq!(client.closed().as_deref(), Some("connection closed"));
        assert!(matches!(events.recv().await.unwrap(), ClientEvent::Closed { .. }));
        assert_eq!(client.request("ping", None).await.unwrap_err().code, ResponseError::CONNECTION_LOST);
    }
    #[tokio::test]
    async fn peer_handler_can_request_on_same_connection_and_eof_cancels_it() {
        let (client_stream, peer_stream) = tokio::io::duplex(8192);
        let (reader, writer) = tokio::io::split(client_stream);
        let (peer_reader, mut peer_writer) = tokio::io::split(peer_stream);
        let slot = Arc::new(std::sync::OnceLock::<std::sync::Weak<RuntimeClient>>::new());
        let handler_slot = Arc::clone(&slot);
        let entered = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(tokio::sync::Notify::new());
        struct Signal(Arc<tokio::sync::Notify>);
        impl Drop for Signal {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }
        let handler_entered = Arc::clone(&entered);
        let handler_dropped = Arc::clone(&dropped);
        let handler: RequestHandler = Arc::new(move |method, _| {
            let client = handler_slot.get().unwrap().upgrade().unwrap();
            let entered = Arc::clone(&handler_entered);
            let dropped = Arc::clone(&handler_dropped);
            Box::pin(async move {
                if method == "nested" {
                    return client.request("ping", None).await;
                }
                let _signal = Signal(dropped);
                entered.notify_one();
                std::future::pending().await
            })
        });
        let client = Arc::new(RuntimeClient::over_with_handler(reader, writer, Some(handler)));
        assert!(slot.set(Arc::downgrade(&client)).is_ok());
        let mut lines = BufReader::new(peer_reader).lines();
        peer_writer.write_all(b"{\"id\":101,\"method\":\"nested\"}\n").await.unwrap();
        let nested: Value = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(nested["method"], "ping");
        peer_writer
            .write_all(format!("{}\n", serde_json::json!({"id":nested["id"],"result":"pong"})).as_bytes())
            .await
            .unwrap();
        let response: Value = serde_json::from_str(
            &tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["id"], 101);
        assert_eq!(response["result"], "pong");
        peer_writer.write_all(b"{\"id\":102,\"method\":\"wait\"}\n").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified()).await.unwrap();
        peer_writer.write_all(b"{\"method\":\"_runtime/cancel\",\"params\":{\"id\":102}}\n").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), dropped.notified()).await.unwrap();
        peer_writer.write_all(b"{\"id\":103,\"method\":\"wait\"}\n").await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified()).await.unwrap();
        peer_writer.shutdown().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), dropped.notified()).await.unwrap();
    }
}
