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
    /// "auto"（全自动）| "approved"（工具执行前审批）
    pub mode: String,
    /// 启用的模型配置档案（按顺序构成自治降级链）
    #[serde(default)]
    pub profiles: Vec<ModelProfileParam>,
    /// 项目记忆（同 cwd 历史要点，注入运行规范）
    #[serde(default)]
    pub memories: Vec<String>,
    /// 续接句柄：上次 pi 会话文件路径（deck 任务续接语义）
    #[serde(default)]
    pub resume_session_file: Option<String>,
    /// 附件绝对路径：sidecar 读为内联图片（或作为可读路径注入提示）
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelProfileParam {
    /// 档案 id（Composer 选择器定位用；sidecar 忽略）
    pub id: String,
    /// 通道：glm = zai 系；其余（含 custom）= OpenAI 兼容
    pub provider: String,
    pub key: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// 默认模型 ID（OpenAI 兼容中转必需；空 = 通道默认）
    #[serde(default)]
    pub model: Option<String>,
    /// 上游协议：chat（默认，Chat Completions）| responses（Responses API）
    #[serde(default)]
    pub protocol: Option<String>,
    /// 该供应商的模型目录（配合切换/上报；空 = 只有默认模型）
    #[serde(default)]
    pub models: Vec<ProfileModelParam>,
}

/// 模型目录条目：ID + 声明的上下文窗口（pi 以此判断自动压缩时机）
#[derive(Debug, Clone, Serialize)]
pub struct ProfileModelParam {
    pub id: String,
    #[serde(default)]
    pub context_window: Option<i64>,
    /// 最大输出 token（空 = 通道默认）
    #[serde(default)]
    pub max_tokens: Option<i64>,
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
    pub fn get(&self, task_id: &str) -> Option<PiSender> {
        self.0.lock().ok().and_then(|g| g.get(task_id).cloned())
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
) -> Result<(String, Option<i64>), String> {
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

    use command_group::AsyncCommandGroup;
    let mut child = command
        .group()
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 deck-agent 失败：{e}"))?;
    crate::recovery::track(&store, &task_id, child.inner().id());

    let mut stdin = child.inner().stdin.take().ok_or("no stdin")?;
    let stdout = child.inner().stdout.take().ok_or("no stdout")?;
    let stderr = child.inner().stderr.take().ok_or("no stderr")?;

    // 指令通道：注册到 registry，供 cancel/approve/reject 命令使用
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (abort_tx, mut abort_rx) = tokio::sync::watch::channel(false);
    let tx2 = tx.clone();
    registry.insert(task_id.clone(), tx);

    // stdin 写入任务：先发 run 指令，再转发后续 channel 指令
    let run_cmd = serde_json::json!({
        "cmd": "run",
        "prompt": params.prompt,
        "model": params.model,
        "cwd": params.cwd,
        "profiles": params.profiles,
        "resumeSessionFile": params.resume_session_file,
        "attachments": params.attachments,
        "memories": params.memories,
        "mode": params.mode,
    });
    stdin
        .write_all(serde_json::to_string(&run_cmd).unwrap().as_bytes())
        .await
        .map_err(|e| format!("写入 run 指令失败：{e}"))?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    let mut stdin = Some(stdin);
    let stdin_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if line.contains("\"cmd\":\"abort\"") {
                let _ = abort_tx.send(true);
            }
            let Some(s) = stdin.as_mut() else { break };
            if s.write_all(line.as_bytes()).await.is_err() || s.write_all(b"\n").await.is_err() {
                break;
            }
            if line.contains("\"cmd\":\"close\"") {
                break;
            }
        }
    });

    // Stream to the UI; persist final snapshots only.
    let app2 = app.clone();
    let task_id2 = task_id.clone();
    let store2 = store.clone_handle();
    let mut out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        let mut outcome = None;
        loop {
            buf.clear();
            let read = reader.read_until(b'\n', &mut buf).await;
            match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let parsed = serde_json::from_str::<serde_json::Value>(trimmed).ok();
                    if let Some(value) = parsed.as_ref().filter(|v| {
                        v["type"] == "message_end" && v["message"]["role"] == "assistant"
                    }) {
                        if let Some(model) =
                            value["message"]["model"].as_str().filter(|s| !s.is_empty())
                        {
                            let _ = store2.append_event(
                                &task_id2,
                                &serde_json::json!({
                                    "type":"model_observed","model":model
                                })
                                .to_string(),
                            );
                        }
                    }
                    let event_type = parsed
                        .as_ref()
                        .and_then(|v| v.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();

                    // 会话文件路径入库（deck 续接句柄；deck_session_id 仅展示用）
                    if event_type == "deck_session_file" {
                        if let Some(path) = parsed
                            .as_ref()
                            .and_then(|v| v.get("path"))
                            .and_then(|i| i.as_str())
                        {
                            let _ = store2.set_session_id(&task_id2, path);
                        }
                    }
                    // Only the session file is a resume handle; the UUID is display-only.
                    if event_type == "deck_error" {
                        outcome = Some("failed");
                    }
                    if event_type == "deck_run_end" {
                        let value = parsed.as_ref().unwrap();
                        outcome = Some(if value["status"] == "cancelled" {
                            "cancelled"
                        } else if outcome == Some("failed") || value["ok"] == false {
                            "failed"
                        } else {
                            "done"
                        });
                    }

                    // 事件原样入库（已是 JSON），转发时包上 taskId
                    if event_type != "message_update" {
                        let _ = store2.append_event(&task_id2, trimmed);
                    }
                    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if let Some(obj) = value.as_object_mut() {
                            obj.insert("taskId".into(), serde_json::json!(task_id2));
                        }
                        let _ = app2.emit("pi-event", value);
                        if outcome.is_some() {
                            let _ = tx2.send("{\"cmd\":\"close\"}".to_string());
                            break;
                        }
                    }
                }
            }
        }
        outcome
    });

    eprintln!(
        "[deck-debug] spawn sidecar: {} (exists={})",
        sidecar_js.display(),
        sidecar_js.exists()
    );
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
                    let line = String::from_utf8_lossy(&buf).to_string();
                    eprintln!("[deck-debug][stderr] {}", line.trim_end());
                    tail = (line + &tail).chars().take(1500).collect();
                }
            }
        }
        tail
    });

    // EOF/crash must not leave the stdin writer waiting on the registry forever.
    let outcome = tokio::select! {
        result = &mut out_task => result.map_err(|e| e.to_string())?,
        _ = async {
            while !*abort_rx.borrow() {
                if abort_rx.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        } => {
            match tokio::time::timeout(std::time::Duration::from_secs(5), &mut out_task).await {
                Ok(result) => result.map_err(|e| e.to_string())?.or(Some("cancelled")),
                Err(_) => {
                    out_task.abort();
                    let event = serde_json::json!({
                        "type": "deck_run_end", "taskId": task_id,
                        "ok": false, "status": "cancelled"
                    });
                    let _ = store.append_event(&task_id, &event.to_string());
                    let _ = app.emit("pi-event", event);
                    let _ = child.kill().await;
                    Some("cancelled")
                }
            }
        }
    };
    registry.remove(&task_id);
    if outcome.is_none() {
        stdin_task.abort();
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(result) => {
            result.map_err(|e| e.to_string())?;
        }
        Err(_) => {
            let _ = child.kill().await;
        }
    }
    stdin_task.abort();
    let _ = stdin_task.await;
    let err_tail = err_task.await.unwrap_or_default();
    let status_str = outcome.unwrap_or("failed");
    let code = match status_str {
        "done" => Some(0),
        "cancelled" => None,
        _ => Some(1),
    };
    if outcome.is_none() {
        let event = serde_json::json!({
            "type": "deck_error",
            "taskId": task_id,
            "message": format!("deck-agent 在任务完成前退出：{}", err_tail.trim())
        });
        let _ = store.append_event(&task_id, &event.to_string());
        let _ = app.emit("pi-event", event);
    }
    // 崩溃场景（outcome=none 且进程早退）延迟终态上报：调用方可能重连。
    // 返回 (status, code)；status: done | cancelled | crashed
    let final_status = if outcome.is_none() {
        "crashed"
    } else {
        status_str
    };
    if final_status == "crashed" {
        // 崩溃但可能重连：DB 回到 running，终态交给重连循环裁决
        store.finish_task(&task_id, "running", None);
    } else {
        store.finish_task(&task_id, status_str, code);
    }
    if final_status != "crashed" {
        let _ = app.emit(
            "task-exit",
            serde_json::json!({ "taskId": task_id, "code": code, "status": status_str }),
        );
    }
    Ok((final_status.to_string(), code))
}

/// 向指定 pi 会话发送指令（approve/reject/abort）。
pub fn send_command(
    registry: &PiRegistry,
    task_id: &str,
    cmd: &str,
    id: Option<String>,
    answer: Option<String>,
) -> Result<(), String> {
    if !matches!(cmd, "approve" | "reject" | "abort" | "compact") {
        return Err(format!("不支持的运行指令：{cmd}"));
    }
    if matches!(cmd, "approve" | "reject") && id.as_deref().is_none_or(str::is_empty) {
        return Err("审批缺少工具调用 ID".into());
    }
    let sender = registry
        .get(task_id)
        .ok_or_else(|| format!("没有活跃的 pi 会话：{task_id}"))?;
    let mut msg = serde_json::json!({ "cmd": cmd });
    if let Some(id) = id {
        msg["id"] = serde_json::json!(id);
    }
    // 选项式提问的答案（ask_user_question 选中项；普通审批为空）
    if let Some(answer) = answer {
        msg["answer"] = serde_json::json!(answer);
    }
    sender
        .send(serde_json::to_string(&msg).unwrap())
        .map_err(|e| format!("发送失败：{e}"))
}

/// 用 deck 运行时压缩一段文本（会话记录 → 交接简报）。
/// spawn 独立 sidecar 进程，等待 summarize_result 事件；失败返回 Err 由调用方回退。
pub async fn pi_summarize_text(
    sidecar_js: &std::path::Path,
    profiles: &[ModelProfileParam],
    cwd: &str,
    text: &str,
) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    let node = which::which("node").map_err(|_| "未找到 node".to_string())?;
    let mut command = Command::new(node);
    command
        .arg(sidecar_js)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 deck-agent 失败：{e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let cmd = serde_json::json!({
        "cmd": "summarize",
        "text": text,
        "profiles": profiles,
        "cwd": cwd,
    });
    stdin
        .write_all(serde_json::to_string(&cmd).unwrap().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    drop(stdin); // 关 stdin 促使 sidecar 处理完后可退出

    // stderr 并发收集（崩溃原因），逐行镜像到 dev 控制台便于诊断
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut tail = String::new();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).to_string();
                    eprintln!("[deck-debug][summarize] {}", line.trim_end());
                    tail.push_str(&line);
                    if tail.chars().count() > 2000 {
                        tail = tail.chars().skip(tail.chars().count() - 2000).collect();
                    }
                }
            }
        }
        tail
    });

    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    let mut seen_lines = 0usize;
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Err(e) => {
                eprintln!("[deck-debug][summarize] read error: {e}");
                break;
            }
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                seen_lines += 1;
                eprintln!("[deck-debug][summarize-out] {}", line.trim_end());
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                    continue;
                };
                match v.get("type").and_then(|x| x.as_str()) {
                    // sidecar 的 deckEvent 会加 deck_ 前缀（deck_summarize_result）
                    Some("deck_summarize_result") | Some("summarize_result") => {
                        let text = v
                            .get("text")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string();
                        if text.trim().is_empty() {
                            return Err("压缩结果为空".into());
                        }
                        return Ok(text);
                    }
                    Some("deck_summarize_error") | Some("summarize_error") | Some("deck_error") => {
                        let msg = v
                            .get("message")
                            .and_then(|x| x.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        return Err(msg);
                    }
                    _ => {}
                }
            }
        }
    }
    // 走到这 = stdout EOF 仍未见结果：带上退出码与 stderr 尾部，让崩溃可见
    let exit_note = match child.wait().await {
        Ok(status) => format!("exit_code={}", status.code().unwrap_or(-1)),
        Err(e) => format!("wait failed: {e}"),
    };
    let err_tail = stderr_task
        .await
        .unwrap_or_default()
        .lines()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    eprintln!("[deck-debug][summarize] EOF without result: lines={seen_lines}");
    Err(format!(
        "sidecar 在返回结果前退出（{exit_note}，sidecar 输出 {seen_lines} 行）{}",
        if err_tail.is_empty() {
            String::new()
        } else {
            format!("：{}", err_tail.chars().take(400).collect::<String>())
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_commands_do_not_unregister_the_session() {
        let registry = PiRegistry::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        registry.insert("task".into(), tx);
        for id in ["first", "second"] {
            send_command(&registry, "task", "approve", Some(id.into()), None).unwrap();
            let cmd: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
            assert_eq!(cmd["id"], id);
        }
        send_command(&registry, "task", "abort", None, None).unwrap();
        assert!(registry.get("task").is_some());
        registry.remove("task");
        assert!(send_command(&registry, "task", "abort", None, None).is_err());
    }

    #[test]
    fn invalid_commands_and_missing_approval_ids_are_rejected() {
        let registry = PiRegistry::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        registry.insert("task".into(), tx);
        assert!(send_command(&registry, "task", "close", None, None).is_err());
        assert!(send_command(&registry, "task", "approve", None, None).is_err());
        assert!(rx.try_recv().is_err());
        assert!(registry.get("task").is_some());
    }
}
