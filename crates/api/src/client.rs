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

use crate::{
    AttachInfo, ResponseError, RuntimeEvent, SessionEventFrame, SessionLifecycleFrame, SessionRunState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;

pub const EVENT_CAPACITY: usize = 4_096;

/// 一条从 Runtime 来的事件帧。协议事件按 [`RuntimeEvent`] 解;`lagged` 与宿主扩展事件走 `Other`。
#[derive(Clone, Debug)]
pub enum ClientEvent {
    Runtime(RuntimeEvent),
    /// 连接丢帧(stdio 入口队列溢出),`dropped` 条事件没送到;按 sequence 回放补齐。
    Lagged {
        dropped: u64,
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

struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, ResponseError>>>>,
    events: broadcast::Sender<ClientEvent>,
    closed: Mutex<Option<String>>,
    handler: Option<RequestHandler>,
    /// 回答对方请求与发事件都走这条写端(与 `RuntimeClient::writer` 同一条流)。
    outbound: mpsc::UnboundedSender<String>,
}

pub struct RuntimeClient {
    writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
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
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let (outbound, outbound_receiver) = mpsc::unbounded_channel::<String>();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            events,
            closed: Mutex::new(None),
            handler,
            outbound,
        });
        let writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>> =
            Arc::new(tokio::sync::Mutex::new(Box::new(writer)));
        tokio::spawn(write_loop(Arc::clone(&writer), outbound_receiver));
        let reader_task = tokio::spawn(read_loop(BufReader::new(reader), Arc::clone(&shared)));
        Self { writer, shared, next_id: AtomicU64::new(1), reader_task, child: Mutex::new(None) }
    }

    /// 发一条事件帧(`{"type": ...}`)。模块发的事件由 Runtime 包成 `{"type":"module"}` 广播给应用。
    pub fn emit(&self, event: Value) -> Result<(), ResponseError> {
        let mut line = event.to_string();
        line.push('\n');
        self.shared.outbound.send(line).map_err(|_| ResponseError::connection_lost("connection closed"))
    }

    /// 订阅事件。每个订阅者一条队列;跟不上就 `RecvError::Lagged`,与 `ClientEvent::Lagged` 同义。
    pub fn events(&self) -> broadcast::Receiver<ClientEvent> {
        self.shared.events.subscribe()
    }

    /// 任意方法,含宿主扩展。错误就是响应帧里的 `error`(code / message / data 原样);
    /// 连接断了是 `ResponseError::CONNECTION_LOST`。
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, ResponseError> {
        if let Some(reason) = self.shared.closed.lock().unwrap().clone() {
            return Err(ResponseError::connection_lost(format!("{method}: {reason}")));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
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
    let reason = loop {
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
            let event = match value.get("type").and_then(Value::as_str) {
                Some("lagged") => {
                    ClientEvent::Lagged { dropped: value.get("dropped").and_then(Value::as_u64).unwrap_or(0) }
                }
                _ => match serde_json::from_value::<RuntimeEvent>(value.clone()) {
                    Ok(event) => ClientEvent::Runtime(event),
                    Err(_) => ClientEvent::Other(value),
                },
            };
            let _ = shared.events.send(event);
            continue;
        }
        if value.get("method").is_some() {
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let method = value.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let response = match &shared.handler {
                Some(handler) => match handler(method.clone(), params).await {
                    Ok(result) => serde_json::json!({ "id": id, "result": result, "error": null }),
                    Err(error) => serde_json::json!({ "id": id, "result": null, "error": error }),
                },
                None => {
                    serde_json::json!({ "id": id, "result": null, "error": ResponseError::method_not_found(&method) })
                }
            };
            let mut line = response.to_string();
            line.push('\n');
            let _ = shared.outbound.send(line);
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
    *shared.closed.lock().unwrap() = Some(reason.clone());
    let pending: Vec<_> = shared.pending.lock().unwrap().drain().collect();
    for (_, sender) in pending {
        let _ = sender.send(Err(ResponseError::connection_lost(reason.clone())));
    }
    let _ = shared.events.send(ClientEvent::Closed { reason });
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
}
