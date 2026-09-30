//! Client contract tests against a separately built Runtime executable.
#![cfg(all(feature = "runtime-contract-tests", unix))]

use std::sync::Arc;

use alwith_api::{ClientEvent, RequestHandler, ResponseError, RuntimeClient, RuntimeEvent};
use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::Command;
mod tests {
    use super::*;
    async fn spawn_for(program: &std::path::Path, engine: &str) -> RuntimeClient {
        let binary = std::env::var_os("ALWITH_RUNTIME_TEST_BINARY")
            .expect("set ALWITH_RUNTIME_TEST_BINARY to an independently built Runtime executable");
        let root = tempfile::tempdir().unwrap().keep();
        let mut command = Command::new(binary);
        command
            .args(["--listen", "stdio://"])
            .env("ALWITH_RUNTIME_ENGINES", serde_json::json!({engine:{"command":program}}).to_string())
            .env("ALWITH_RUNTIME_JOURNAL", root)
            .env_remove("ALWITH_MODULES_DIR")
            .env_remove("ALWITH_RUNTIME_LAUNCH_RESOLVER");
        RuntimeClient::spawn(command).await.unwrap()
    }

    async fn connect() -> RuntimeClient {
        // These process tests run on Unix, where /bin/cat is the deterministic echo fixture.
        spawn_for(std::path::Path::new("/bin/cat"), "cat").await
    }

    #[tokio::test]
    async fn requests_round_trip_and_errors_carry_the_method() {
        let client = connect().await;
        client.ping().await.unwrap();
        let binary = std::env::var_os("ALWITH_RUNTIME_TEST_BINARY").unwrap();
        let version = Command::new(binary).arg("--version").output().await.unwrap();
        assert!(version.status.success());
        let version = String::from_utf8(version.stdout).unwrap();
        assert_eq!(version.trim(), format!("alwith-runtime {}", client.version().await.unwrap()));
        assert!(client.run_states().await.unwrap().is_empty());
        let error = client.request("nothing", None).await.unwrap_err();
        assert_eq!(error.code, ResponseError::METHOD_NOT_FOUND, "{error}");
        assert!(error.message.starts_with("unknown runtime method nothing"), "{error}");
        let denied = client.send("ghost", "{}", None).await.unwrap_err();
        assert_eq!(denied.code, ResponseError::RUNTIME, "{denied}");
        assert!(denied.message.contains("not owned"), "{denied}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_lines_arrive_as_runtime_events() {
        let client = connect().await;
        let mut events = client.events();
        client.start("cat", serde_json::json!({ "engine": "cat" }), Some("w1")).await.unwrap();
        let prompt = r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s1","prompt":[]}}"#;
        client.send("cat", prompt, Some("w1")).await.unwrap();
        assert!(client.send("cat", prompt, Some("w2")).await.unwrap_err().message.contains("not owned"));
        assert_eq!(client.agent_for_session("s1").await.unwrap().as_deref(), Some("cat"));
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let event = tokio::time::timeout_at(deadline, events.recv()).await.expect("event in time").unwrap();
            if let ClientEvent::Runtime(RuntimeEvent::Inbound { agent_id, lines }) = event {
                assert_eq!(agent_id, "cat");
                assert!(lines[0].contains("session/prompt"));
                break;
            }
        }
        let frames = client.session_events("s1", None, None).await.unwrap();
        assert!(frames.len() >= 2);
        assert!(!client.session_replay("s1").await.unwrap().is_empty());
        client.stop("cat", None).await.unwrap();
    }

    /// Shape of a module subprocess: the peer (Runtime) sends requests in, the handler answers; it
    /// can also send events out.
    #[tokio::test]
    async fn handles_incoming_requests_and_emits_events() {
        use tokio::io::AsyncBufReadExt as _;
        let (peer_reader, client_writer) = tokio::io::duplex(64 * 1024);
        let (client_reader, mut peer_writer) = tokio::io::duplex(64 * 1024);
        let handler: RequestHandler = Arc::new(|method, params| {
            Box::pin(async move {
                if method == "echo" { Ok(params) } else { Err(ResponseError::method_not_found(&method)) }
            })
        });
        let client = RuntimeClient::over_with_handler(client_reader, client_writer, Some(handler));
        client.emit(serde_json::json!({ "type": "hello" })).unwrap();
        peer_writer.write_all(b"{\"id\":5,\"method\":\"echo\",\"params\":{\"x\":1}}\n").await.unwrap();
        peer_writer.write_all(b"{\"id\":6,\"method\":\"nope\"}\n").await.unwrap();
        let mut lines = BufReader::new(peer_reader).lines();
        let mut seen = Vec::new();
        while seen.len() < 3 {
            let line = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            seen.push(serde_json::from_str::<Value>(&line).unwrap());
        }
        assert!(seen.iter().any(|v| v["type"] == "hello"));
        assert!(seen.iter().any(|v| v["id"] == 5 && v["result"]["x"] == 1));
        assert!(seen.iter().any(|v| v["id"] == 6
            && v["error"]["code"] == ResponseError::METHOD_NOT_FOUND
            && v["error"]["message"].as_str().unwrap().contains("unknown runtime method nope")));
    }

    #[tokio::test]
    async fn closing_the_stream_fails_pending_requests() {
        let client = connect().await;
        client.ping().await.unwrap();
        client.kill();
        let error = client.ping().await.unwrap_err();
        assert_eq!(error.code, ResponseError::CONNECTION_LOST, "{error}");
        assert!(error.message.contains("connection closed") || error.message.contains("write failed"), "{error}");
        assert!(client.closed().is_some());
    }

    /// A fake ACP agent written in python: handshake, create session, on prompt first push a
    /// session/update, then ask for permission once,
    /// and end the turn after getting the answer.
    const FAKE_AGENT: &str = r#"#!/usr/bin/env python3
import json, sys
def emit(o):
    print(json.dumps(o), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    method = m.get("method")
    if method == "initialize":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 2, "agentInfo": {"name": "fake", "version": "0"}}})
    elif method == "session/new":
        emit({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": "s-1"}})
    elif method == "session/prompt":
        sid = m["params"]["sessionId"]
        emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}}})
        emit({"jsonrpc": "2.0", "id": 77, "method": "session/request_permission", "params": {"sessionId": sid, "options": [{"optionId": "ok", "kind": "allow_once"}]}})
        pending = m["id"]
        for answer in sys.stdin:
            a = json.loads(answer)
            if a.get("id") == 77:
                emit({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": " there"}}}})
                emit({"jsonrpc": "2.0", "id": pending, "result": {"stopReason": "end_turn", "_meta": {"answered": a["result"]["outcome"]["optionId"]}}})
                break
    elif method == "slow":
        pending = m["id"]
        for other in sys.stdin:
            o = json.loads(other)
            if o.get("method") == "$/cancel_request" and o["params"]["requestId"] == pending:
                emit({"jsonrpc": "2.0", "id": pending, "error": {"code": -32800, "message": "Request cancelled"}})
                break
"#;

    #[cfg(unix)]
    #[tokio::test]
    async fn the_runtime_speaks_acp_for_the_app() {
        if !std::path::Path::new("/usr/bin/env").exists() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.py");
        std::fs::write(&script, FAKE_AGENT).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let client = Arc::new(spawn_for(&script, "fake").await);
        let mut events = client.events();
        client.start("a", serde_json::json!({"engine":"fake"}), None).await.unwrap();

        // Create a session: Runtime handshakes itself, the app only sees the sessionId.
        let session = client.session_new("a", "/tmp", vec![], None, None).await.unwrap();
        assert_eq!(session["sessionId"], "s-1");

        // One turn: content arrives via acpNotification, the permission request via
        // acpAgentRequest; the turn ends once the app answers.
        let prompter = Arc::clone(&client);
        let turn = tokio::spawn(async move {
            prompter.prompt("a", "s-1", serde_json::json!([{ "type": "text", "text": "hello" }]), None, None).await
        });
        let mut chunks = Vec::new();
        let mut answered = false;
        let mut inbound_saw_runtime_response = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while !answered || chunks.len() < 2 {
            let event = tokio::time::timeout_at(deadline, events.recv()).await.expect("events in time").unwrap();
            match event {
                ClientEvent::Runtime(RuntimeEvent::AcpNotification { method, params, .. })
                    if method == "session/update" =>
                {
                    if let Some(text) = params.pointer("/update/content/text").and_then(Value::as_str) {
                        chunks.push(text.to_string());
                    }
                }
                ClientEvent::Runtime(RuntimeEvent::AcpAgentRequest { agent_id, id, method, .. }) => {
                    assert_eq!(method, "session/request_permission");
                    client
                        .acp_respond(
                            &agent_id,
                            id,
                            Some(serde_json::json!({ "outcome": { "outcome": "selected", "optionId": "ok" } })),
                            None,
                            None,
                        )
                        .await
                        .unwrap();
                    answered = true;
                }
                // Responses to requests Runtime sent itself do not enter inbound (the app never
                // sent them).
                ClientEvent::Runtime(RuntimeEvent::Inbound { lines, .. })
                    if lines.iter().any(|line| line.contains("\"id\":\"rt-")) =>
                {
                    inbound_saw_runtime_response = true;
                }
                _ => {}
            }
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), turn).await.unwrap().unwrap().unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        assert_eq!(result["_meta"]["answered"], "ok");
        assert_eq!(chunks, vec!["hi".to_string(), " there".to_string()]);
        assert!(!inbound_saw_runtime_response);
        // A second session creation does not handshake again: initialize is served from cache (the
        // fake agent would answer a second initialize, but Runtime must not send it).
        let again = client.session_new("a", "/tmp", vec![], None, None).await.unwrap();
        assert_eq!(again["sessionId"], "s-1");
        // Run state as usual: the prompt Runtime sent on the app's behalf is also accounted for.
        let states = client.run_states().await.unwrap();
        assert_eq!(states.len(), 1);

        // App-chosen id: retracting (`$/cancel_request`) depends on it; an id that is still
        // unanswered cannot be reused; the agent's -32800 reaches the app unchanged.
        let waiter = Arc::clone(&client);
        let slow = tokio::spawn(async move {
            waiter.acp_request("a", "slow", serde_json::json!({}), Some(serde_json::json!("app-1")), None).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let duplicate = client
            .acp_request("a", "slow", serde_json::json!({}), Some(serde_json::json!("app-1")), None)
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, ResponseError::INVALID_PARAMS, "{duplicate}");
        client.acp_notify("a", "$/cancel_request", serde_json::json!({ "requestId": "app-1" }), None).await.unwrap();
        let cancelled =
            tokio::time::timeout(std::time::Duration::from_secs(10), slow).await.unwrap().unwrap().unwrap_err();
        assert_eq!(cancelled.code, -32800);
        assert_eq!(cancelled.message, "Request cancelled");
        assert_eq!(states[0].session_id, "s-1");
    }
}
