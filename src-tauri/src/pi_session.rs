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
    let tx2 = tx.clone(); // out_task 用于触发记忆抽取
    registry.insert(task_id.clone(), tx);

    // stdin 写入任务：先发 run 指令，再转发后续 channel 指令
    let run_cmd = serde_json::json!({
        "cmd": "run",
        "prompt": params.prompt,
        "model": params.model,
        "cwd": params.cwd,
        "profiles": params.profiles,
        "memories": params.memories,
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
            if line.contains("\"cmd\":\"abort\"") || line.contains("__CLOSE__") {
                break; // abort / 记忆抽取完成：关闭 stdin，sidecar 收尾
            }
        }
    });

    // stdout：逐行 JSON 事件 → 前端 + 入库；
    // 成功结束（deck_run_end）后触发记忆抽取，抽取完成发 close 收尾
    let app2 = app.clone();
    let task_id2 = task_id.clone();
    let store2 = store.clone_handle();
    let cwd2 = params.cwd.clone();
    let out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        let mut memorize_sent = false;
        // memorize 抽取阶段的超时deadline（LLM 卡住时兜底收尾）
        let mut memorize_deadline: Option<tokio::time::Instant> = None;
        loop {
            buf.clear();
            // 抽取等待期：180s 内没有下一行事件则强制收尾
            let read = if let Some(deadline) = memorize_deadline {
                match tokio::time::timeout_at(deadline, reader.read_until(b'\n', &mut buf)).await {
                    Ok(r) => r,
                    Err(_) => {
                        let _ = tx2.send("{\"cmd\":\"__CLOSE__\"}".to_string());
                        break;
                    }
                }
            } else {
                reader.read_until(b'\n', &mut buf).await
            };
            match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let parsed = serde_json::from_str::<serde_json::Value>(trimmed).ok();
                    let event_type = parsed
                        .as_ref()
                        .and_then(|v| v.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();

                    // 会话 ID 入库（支撑续接语义与归属展示）
                    if event_type == "deck_session_id" {
                        if let Some(id) = parsed
                            .as_ref()
                            .and_then(|v| v.get("id"))
                            .and_then(|i| i.as_str())
                        {
                            let _ = store2.set_session_id(&task_id2, id);
                        }
                    }

                    // 失败收尾：deck_error 后 sidecar 不再产出，关 stdin 让它退出
                    let mut failure = false;
                    if event_type == "deck_error" {
                        failure = true;
                        let _ = tx2.send("{\"cmd\":\"__CLOSE__\"}".to_string());
                    }

                    // 成功结束 → 触发记忆抽取（经 stdin 通道发 memorize）
                    if event_type == "deck_run_end" && !memorize_sent {
                        memorize_sent = true;
                        memorize_deadline =
                            Some(tokio::time::Instant::now() + std::time::Duration::from_secs(180));
                        let convo = crate::handoff::render_conversation(
                            &store2
                                .get_events(&task_id2, 0, i64::MAX)
                                .unwrap_or_default(),
                        );
                        if !convo.trim().is_empty() {
                            let existing = store2.list_memories(&cwd2, 50).unwrap_or_default();
                            let cmd = serde_json::json!({
                                "cmd": "memorize",
                                "text": convo,
                                "cwd": cwd2,
                                "existing": existing,
                            });
                            let _ = tx2.send(serde_json::to_string(&cmd).unwrap());
                            // 注意：不 continue——run_end 仍要入库+转发给前端
                        }
                    }

                    // 抽取结果 → 入库 + 发 close 收尾
                    if event_type == "deck_memorize_result" {
                        memorize_deadline = None;
                        if let Some(arr) = parsed
                            .as_ref()
                            .and_then(|v| v.get("memories"))
                            .and_then(|m| m.as_array())
                        {
                            for m in arr {
                                if let Some(text) = m.as_str() {
                                    let _ = store2.add_memory(&cwd2, text);
                                }
                            }
                        }
                        let _ = tx2.send("{\"cmd\":\"__CLOSE__\"}".to_string());
                    }

                    // 事件原样入库（已是 JSON），转发时包上 taskId
                    let _ = store2.append_event(&task_id2, trimmed);
                    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if let Some(obj) = value.as_object_mut() {
                            obj.insert("taskId".into(), serde_json::json!(task_id2));
                        }
                        let _ = app2.emit("pi-event", value);
                        if failure {
                            break; // 失败已通知且 close 已发，不等流自然结束
                        }
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

    // 与 CLI 执行器同款收尾：状态落库 + task-exit 事件给前端
    let status_str = match code {
        0 => "done",
        _ => "failed",
    };
    store.finish_task(&task_id, status_str, Some(code as i64));
    let _ = app.emit(
        "task-exit",
        serde_json::json!({ "taskId": task_id, "code": code }),
    );
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

    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                    continue;
                };
                match v.get("type").and_then(|x| x.as_str()) {
                    Some("summarize_result") => {
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
                    Some("summarize_error") | Some("deck_error") => {
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
    Err("sidecar 在返回结果前退出".into())
}
