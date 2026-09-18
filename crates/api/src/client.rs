//! `alwith-runtime-v1` 的 Rust 客户端。宿主(Desktop)和模块子进程用它跟 Runtime 说话,帧与 TS 的
//! `FrameHubPort` 完全相同:请求 `{id, method, params}`,响应 `{id, result | error}`,事件带 `type`。
//!
//! 两种接法:[`RuntimeClient::spawn`] 起一个 `alwith-runtime --listen stdio://` 子进程并接管它的管道;
//! [`RuntimeClient::over`] 接任意一对读写流(测试、unix socket)。事件经 [`RuntimeClient::events`] 广播,
//! 慢消费者会收到 `Lagged`,与 stdio 入口的 `lagged` 事件同义:用 `session_events` 补齐。

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

/// 一条从 Runtime 来的事件帧。协议事件按 [`RuntimeEvent`] 解;宿主扩展事件走 `Other`。
///
/// 投递承诺:每条会话里进了日志的帧(带 `session_id` + `sequence` 的 outbound / acpNotification /
/// acpAgentRequest)按日志顺序、恰好一次地送到订阅者。Runtime 在 stdio 宿主跟不上时会丢事件并发
/// `lagged`,慢 ws 连接会被断开;这里按序号发现漏洞,先用 `sessionEvents` 补上,再投后面的。
/// 日志里也没有了的那段以 `Gap` 报出来,不装作连续。
#[derive(Clone, Debug)]
pub enum ClientEvent {
    Runtime(RuntimeEvent),
    /// 补不回来的那段:日志已经丢了 `from..=to`,这段什么都没投;应用该重载这条会话。
    Gap {
        session_id: String,
        from: u64,
        to: u64,
    },
    Other(Value),
    /// 读端结束:对端退出或 stdin EOF。之后 `request` 一律报错;模块收到它就该收工。
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

/// `cliStatus` 的回答。
/// 对方(Runtime)发来的请求怎么答:模块子进程用它接 `modules/<name>/<method>` 转来的调用。
pub type RequestHandler = Arc<
    dyn Fn(String, Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, ResponseError>> + Send>>
        + Send
        + Sync,
>;

/// 补齐时一页要多少帧;Runtime 一页最多 2000。
const REFILL_PAGE: usize = 2_000;
/// 补齐中又有帧插进来时最多再补几轮,之后报 Gap。
const REFILL_ROUNDS: u32 = 2;

/// 一条会话在日志里走到哪了。
struct SessionCursor {
    agent_id: String,
    /// 最后投出去的序号;第一条带序号的帧之前是 None。
    last: Option<u64>,
    refilling: bool,
    /// 补齐期间到的活帧,补完按序投出。
    parked: Vec<(u64, RuntimeEvent)>,
}

enum Verdict {
    Deliver,
    Duplicate,
    Gap,
}

/// 这一帧相对最后投出的那帧:下一号(或第一次见)就投;高位之后又来 0 是引擎重放了历史
/// (带 `replayFrom` 的 resume 清日志),也投;不高于 last 的是重复;更靠后的说明中间丢了。
fn verdict(last: Option<u64>, sequence: u64) -> Verdict {
    match last {
        None => Verdict::Deliver,
        Some(last) if sequence == last + 1 => Verdict::Deliver,
        Some(last) if sequence == 0 && last > 0 => Verdict::Deliver,
        Some(last) if sequence <= last => Verdict::Duplicate,
        Some(_) => Verdict::Gap,
    }
}

/// 活事件上的日志位置:进了日志的三种事件才有。
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

/// 日志里的一帧,按它当初作为活事件的样子还原。响应帧(我们自己请求的回答)没有可重放的。
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
    /// 每个订阅者一条无界队列:进程内不丢,慢消费者只是内存多占一点,不会再有第二个丢点。
    subscribers: Mutex<Vec<mpsc::UnboundedSender<ClientEvent>>>,
    cursors: Mutex<HashMap<String, SessionCursor>>,
    next_id: AtomicU64,
    closed: Mutex<Option<String>>,
    closed_notify: tokio::sync::Notify,
    handler: Option<RequestHandler>,
    /// 回答对方请求、发事件、补齐用的请求都走这条写端(与 `RuntimeClient::writer` 同一条流)。
    outbound: mpsc::UnboundedSender<String>,
}

impl Shared {
    fn emit(&self, event: ClientEvent) {
        self.subscribers.lock().unwrap().retain(|subscriber| subscriber.send(event.clone()).is_ok());
    }

    /// 读循环里发起的请求(补齐用):经 `outbound` 写出,响应仍由读循环配对。
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

    /// 带日志位置的活事件:投、排队、丢重复,或为前面的洞开一轮补齐。
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

    /// Runtime 说丢了(`lagged`)或重连之后:跟着的每条会话都从最后见到的序号补。
    fn refill_all(self: &Arc<Self>) {
        let mut cursors = self.cursors.lock().unwrap();
        for (session_id, cursor) in cursors.iter_mut() {
            if cursor.last.is_some() && !cursor.refilling {
                cursor.refilling = true;
                tokio::spawn(Arc::clone(self).refill(session_id.clone(), 0));
            }
        }
    }

    /// 从最后投出的序号往后拉 `sessionEvents`,按序投出,再投补齐期间攒下的活帧。
    /// 日志里也没有的那段报一次 Gap。
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
                // 连接没了:重连那条路会再补;先把攒下的投出去。
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
        // 攒下的活帧按序投;补完还有洞就再补一轮,轮数用完才报 Gap。持锁投递:emit 只是往队列里放,不等谁。
        // 锁的作用域必须在下面的 await 之前结束(块表达式),否则这个 future 不是 Send。
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
    /// 起 Runtime 子进程(stdin / stdout 接管,stderr 继承给宿主日志),等它的 `ready` 行。
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

    /// 任意一对流上的连接。`reader` 上每行一帧;`writer` 上每帧一行。
    pub fn over<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::over_with_handler(reader, writer, None)
    }

    /// 同上,并接对方发来的请求:模块子进程就是这样一个"也会被调用的客户端"。
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

    /// 发一条事件帧(`{"type": ...}`)。模块发的事件由 Runtime 包成 `{"type":"module"}` 广播给应用。
    pub fn emit(&self, event: Value) -> Result<(), ResponseError> {
        let mut line = event.to_string();
        line.push('\n');
        self.shared.outbound.send(line).map_err(|_| ResponseError::connection_lost("connection closed"))
    }

    /// 订阅事件。每个订阅者一条无界队列:进程内不丢,`None` 即客户端已 drop。
    /// 会话事件按序、恰好一次(见 [`ClientEvent`]);补不回来的洞是 `ClientEvent::Gap`。
    pub fn events(&self) -> mpsc::UnboundedReceiver<ClientEvent> {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.shared.subscribers.lock().unwrap().push(sender);
        receiver
    }

    /// 任意方法,含宿主扩展。错误就是响应帧里的 `error`(code / message / data 原样);
    /// 连接断了是 `ResponseError::CONNECTION_LOST`。
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

    /// `owner`:连接下的子属主(桌面窗口 label);None 即连接本身,对所有子属主的 agent 有写权。
    /// `launch` 是 Runtime 引擎表之上的启动参数 `{engine, cwd, args, env, provider, model, connection}`。
    /// 起一个 agent 进程。同名进程还活着就报错:换芯是「先 stop、等 Exit 事件、再 start」。
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

    /// Runtime 自己的版本(与 `alwith-runtime --version` 同一个数)。
    pub async fn version(&self) -> Result<String, ResponseError> {
        self.typed("version", None).await
    }

    pub async fn agents(&self) -> Result<Vec<Value>, ResponseError> {
        self.typed("agents", None).await
    }

    pub async fn ping(&self) -> Result<(), ResponseError> {
        self.request("ping", None).await.map(|_| ())
    }

    // ---- ACP:Runtime 代你说 ACP v2。原始的 send / inbound 仍可用。 ----

    /// 任意 ACP 请求,Runtime 编 id、等响应。`request_id`:自己选 id(要发 `$/cancel_request` 撤回时才需要)。
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

    /// 回答 agent 的请求(`RuntimeEvent::AcpAgentRequest` 里的 `id`)。
    pub async fn acp_respond(
        &self, agent_id: &str, id: Value, result: Option<Value>, error: Option<Value>, owner: Option<&str>,
    ) -> Result<(), ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "id": id, "result": result, "error": error }),
            owner,
        );
        self.request("acpRespond", Some(params)).await.map(|_| ())
    }

    /// ACP 握手,可带自己的客户端信息与能力;已握过就回缓存。会话方法会自动以默认身份握手,只有要声明能力时才需要调。
    pub async fn initialize(
        &self, agent_id: &str, info: Option<Value>, capabilities: Option<Value>, owner: Option<&str>,
    ) -> Result<Value, ResponseError> {
        let params = Self::with_owner(
            serde_json::json!({ "agentId": agent_id, "info": info, "capabilities": capabilities }),
            owner,
        );
        self.request("initialize", Some(params)).await
    }

    /// 建会话(第一次先握手)。返回 ACP `session/new` 的结果,`sessionId` 在里面。
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

    /// 一轮对话,回合结束才返回(`{stopReason, _meta}`);过程走 `AcpNotification` 事件。
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

    /// 立刻杀掉子进程(退出兜底;正常路径用 `shutdown`)。没有子进程时无事。
    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }

    /// 连接是否已断(读端结束或子进程退出)。
    pub fn closed(&self) -> Option<String> {
        self.shared.closed.lock().unwrap().clone()
    }

    /// 退出链:先请 Runtime 走(`shutdown` 方法,它给模块与 agent 2 秒收尾窗后 kill_all),等连接结束;
    /// `grace` 内没结束就强杀子进程。直接 kill 会让 agent 派生的进程组留活,所以先礼后兵。
    /// 与 [`Self::shutdown`] 的差别:不消费 self,宿主用 `Arc<RuntimeClient>` 也能调。
    pub async fn close(&self, grace: std::time::Duration) {
        let deadline = tokio::time::Instant::now() + grace;
        // 先登记等待,再看是否已经关了:`notify_waiters` 只叫醒已登记的,不然回执与 EOF 一起到时会错过。
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

    /// 关闭写端(Runtime 收到 EOF 即 kill_all 退出),等读端结束;有子进程则回收它。
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
        // 先认事件:事件帧也可能带 `method`(如 acpNotification),不能当成对端的请求。
        if value.get("type").is_some() {
            match value.get("type").and_then(Value::as_str) {
                // Runtime 这条连接丢了事件:跟着的每条会话都补一遍。
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
    //! 对着一个假对端(按协议答帧的小循环),不需要真 Runtime;对着真 Runtime 的往返测试在 Runtime 仓。
    use super::*;
    use tokio::io::{AsyncWriteExt, DuplexStream};

    /// 假对端:`ping` 答 `"pong"`,`nope` 答错误,`lines` 请求让它广播一条 lines 事件;收到事件帧原样回写。
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

    /// 有日志的假对端:`sessionEvents` 按 afterSequence 从给定帧里答;`shutdown` 回执后关掉自己的写端。
    /// 测试用 `push` 往客户端塞事件帧。
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

    /// 收够 `count` 条会话事件(或 Gap),返回序号序列;Gap 记成 `None`。
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
        // 0 活的;lagged 后补 1、2;活的 2 是重复,丢;3 接上。
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
