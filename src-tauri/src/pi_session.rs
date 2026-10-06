//! deck-agent sidecar 会话管理：spawn `agent/deck-agent.mjs`（pi 二次开发的
//! 统一 agent 运行时），stdin 发指令、stdout 收结构化事件流。
//!
//! 事件两路分发：转发给前端（task-event）+ 入库（task_events 表），
//! 与 CLI executors 的事件管道完全同构。

use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::store::Store;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PiRunParams {
    pub prompt: String,
    /// "glm" | "gpt"
    pub model: String,
    pub cwd: String,
    /// pi 模型 API key（来自前端设置；不落库）
    #[serde(default)]
    pub api_key: Option<String>,
    /// "auto"（全自动）| "approved"（工具执行前审批）
    pub mode: String,
}

/// 每个 task_id 一个发送端：往 sidecar stdin 写指令。
pub type PiSender = mpsc::UnboundedSender<String>;

/// 活跃 pi 会话：task_id → stdin 发送端。
#[derive(Clone, Default)]
pub struct PiRegistry(pub Arc<Mutex<std::collections::HashMap<String, PiSender>>>);

impl PiRegistry {
    pub fn insert(&self, task_id: String, sender: PiSender) {
        if let Ok(mut guard) = self.0.lock() {
            guard.insert(task_id, sender);
        }
    }
    pub fn remove(&self, task_id: &str) -> Option<PiSender> {
        self.0.lock().ok().and_then(|mut g| g.remove(task_id))
    }
}

/// 启动一次 pi 运行：spawn sidecar → 事件循环（转发+入库）→ 退出码回传。
/// 由 start_task（executor = "deck"）调用。
pub async fn run_pi_task(
    app: tauri::AppHandle,
    task_id: String,
    params: PiRunParams,
    store: Store,
    registry: PiRegistry,
    sidecar_js: std::path::PathBuf,
) -> Result<i32, String> {
    // Windows 上 node 是 node.exe，可直接 spawn；deck-agent.mjs 用绝对路径
    let node =
        which::which("node").map_err(|_| "未找到 node（deck-agent 需要 Node.js）".to_string())?;
    let mut command = tokio::process::Command::new(node);
    command
        .arg(&sidecar_js)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：sidecar 不弹窗（tokio Command 自带该方法）
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 deck-agent 失败：{e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // 指令通道：注册到 registry，供 cancel/approve/reject 命令使用
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    registry.insert(task_id.clone(), tx);

    // stdin 写入任务：先发 run 指令，再转发后续 channel 指令
    let run_cmd = serde_json::json!({
        "cmd": "run",
        "prompt": params.prompt,
        "model": params.model,
        "cwd": params.cwd,
        "apiKey": params.api_key,
        "mode": params.mode,
    });
    stdin
        .write_all(serde_json::to_string(&run_cmd).unwrap().as_bytes())
        .await
        .map_err(|e| format!("写入 run 指令失败：{e}"))?;
    stdin.write_all(b"\n").await.ok();
    let mut stdin = Some(stdin);
    let stdin_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let Some(s) = stdin.as_mut() else { break };
            if s.write_all(line.as_bytes()).await.is_err() || s.write_all(b"\n").await.is_err() {
                break;
            }
            if line.contains("\"cmd\":\"abort\"") {
                break; // abort 后关闭 stdin，sidecar 收尾
            }
        }
    });

    // stdout：逐行 JSON 事件 → 前端 + 入库
    let app2 = app.clone();
    let task_id2 = task_id.clone();
    let store2 = store.clone_handle();
    let out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // 事件原样入库（已是 JSON），转发时包上 taskId
                    let _ = store2.append_event(&task_id2, trimmed);
                    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if let Some(obj) = value.as_object_mut() {
                            obj.insert("taskId".into(), serde_json::json!(task_id2));
                        }
                        let _ = app2.emit("pi-event", value);
                    }
                }
            }
        }
    });

    // stderr：仅收集尾部用于报错
    let err_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut tail = String::new();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    tail = (String::from_utf8_lossy(&buf).to_string() + &tail)
                        .chars()
                        .take(1500)
                        .collect();
                }
            }
        }
        tail
    });

    let _ = stdin_task.await;
    let _ = out_task.await;
    let err_tail = err_task.await.unwrap_or_default();
    let status = child.wait().await.map_err(|e| e.to_string())?;
    registry.remove(&task_id);

    let code = status.code().unwrap_or(-1);
    if code != 0 && !err_tail.trim().is_empty() {
        let _ = store.append_event(
            &task_id,
            &serde_json::json!({
                "type": "deck_error",
                "message": format!("deck-agent 异常退出：{}", err_tail.trim())
            })
            .to_string(),
        );
    }
    Ok(code)
}

/// 向指定 pi 会话发送指令（approve/reject/abort）。
pub fn send_command(
    registry: &PiRegistry,
    task_id: &str,
    cmd: &str,
    id: Option<String>,
) -> Result<(), String> {
    let sender = registry
        .remove(task_id)
        .ok_or_else(|| format!("没有活跃的 pi 会话：{task_id}"))?;
    let mut msg = serde_json::json!({ "cmd": cmd });
    if let Some(id) = id {
        msg["id"] = serde_json::json!(id);
    }
    sender
        .send(serde_json::to_string(&msg).unwrap())
        .map_err(|e| format!("发送失败：{e}"))
}
