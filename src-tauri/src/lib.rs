mod executors;
mod pi_session;
mod runner;
mod store;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::executors::Harness;
use crate::store::{Store, TaskRow};

/// deck-agent.mjs 的位置：优先资源目录（打包后），回退仓库源码（开发模式）。
fn sidecar_path(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = res_dir.join("agent").join("deck-agent.mjs");
        if p.exists() {
            return p;
        }
    }
    // 开发模式：cargo 工作目录是 src-tauri，仓库根在上一级
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/deck-agent.mjs")
}

/// 运行中/刚结束的任务：保留子进程句柄用于取消。
pub struct RunningTask {
    pub label: String,
    pub child: Option<tokio::process::Child>,
}

/// 全局任务表。runner 持有 Arc 克隆以便在流结束后回写退出码。
#[derive(Clone, Default)]
pub struct TaskRegistry(pub Arc<Mutex<HashMap<String, RunningTask>>>);

/// Rust → 前端：转发任务事件（日志流）。
pub fn emit_task_event(app: &AppHandle, task_id: &str, event: &executors::AgentEvent) {
    let _ = app.emit(
        "task-event",
        serde_json::json!({ "taskId": task_id, "event": event }),
    );
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskStartInfo {
    task_id: String,
}

/// 前端 → Rust：启动一个无头 agent 任务。
// tauri command 签名参数固定较多，属框架形态
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn start_task(
    app: AppHandle,
    registry: State<'_, TaskRegistry>,
    store: State<'_, Store>,
    pi_registry: State<'_, pi_session::PiRegistry>,
    harness: String,
    cwd: String,
    prompt: String,
    mode: Option<String>,
    model: Option<String>,
    permission: Option<String>,
    resume_session_id: Option<String>,
    api_key: Option<String>,
) -> Result<TaskStartInfo, String> {
    // deck = AgentDeck 自有运行时（pi sidecar），走独立通道
    if harness.eq_ignore_ascii_case("deck") {
        let task_id = pi_session_task_id();
        store.create_task(&task_id, "deck", &cwd, &prompt, mode.as_deref(), None)?;
        // API key 从设置读取（前端设置面板写入），入参与环境变量作为回退
        let api_key = store
            .get_setting("deck_api_key")?
            .or(api_key)
            .or_else(|| std::env::var("ZAI_API_KEY").ok())
            .or_else(|| std::env::var("OPENAI_API_KEY").ok());
        let params = pi_session::PiRunParams {
            prompt,
            model: if mode.as_deref() == Some("gpt") {
                "gpt"
            } else {
                "glm"
            }
            .into(),
            cwd,
            api_key,
            // approved = 工具执行前经 UI 审批（P2 权限门）
            mode: if permission.as_deref() == Some("approved") {
                "approved"
            } else {
                "auto"
            }
            .into(),
        };
        let sidecar = sidecar_path(&app);
        let reg = pi_registry.inner().clone();
        let store2 = store.clone_handle();
        let task_id2 = task_id.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let result =
                pi_session::run_pi_task(app2, task_id2, params, store2, reg, sidecar).await;
            if let Err(e) = result {
                eprintln!("pi task failed: {e}");
            }
        });
        return Ok(TaskStartInfo { task_id });
    }

    let harness = Harness::parse(&harness)?;
    let task_id = runner::new_task_id(harness);

    store.create_task(
        &task_id,
        harness.name(),
        &cwd,
        &prompt,
        mode.as_deref(),
        model.as_deref(),
    )?;

    let child = runner::spawn(
        harness,
        &mode,
        &model,
        &cwd,
        &prompt,
        resume_session_id.as_deref(),
    )
    .await
    .inspect_err(|_| store.finish_task(&task_id, "failed", None))
    .map_err(|e| e.to_string())?;

    let mut child = child;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    registry
        .0
        .lock()
        .map_err(|_| "task registry poisoned")?
        .insert(
            task_id.clone(),
            RunningTask {
                label: harness.name().to_string(),
                child: Some(child),
            },
        );

    let reg = registry.0.clone();
    let store2 = store.clone_handle();
    let task_id2 = task_id.clone();
    tauri::async_runtime::spawn(async move {
        runner::stream_loop(
            app,
            task_id2,
            harness,
            stdout,
            stderr,
            TaskRegistry(reg),
            store2,
        )
        .await;
    });

    Ok(TaskStartInfo { task_id })
}

/// 前端 → Rust：取消运行中的任务（杀掉子进程）。
#[tauri::command]
fn cancel_task(registry: State<'_, TaskRegistry>, task_id: String) -> Result<(), String> {
    let mut guard = registry.0.lock().map_err(|_| "task registry poisoned")?;
    if let Some(task) = guard.get_mut(&task_id) {
        if let Some(child) = task.child.as_mut() {
            let _ = child.start_kill();
        }
        Ok(())
    } else {
        Err(format!("unknown task: {task_id}"))
    }
}

/// 前端 → Rust：最近的任务历史。
#[tauri::command]
fn list_tasks(store: State<'_, Store>, limit: Option<i64>) -> Result<Vec<TaskRow>, String> {
    store.list_tasks(limit.unwrap_or(50))
}

/// 前端 → Rust：读取某个任务的全部事件（历史回放）。
#[tauri::command]
fn get_task_events(
    store: State<'_, Store>,
    task_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let raw = store.get_events(&task_id, 0, i64::MAX)?;
    Ok(raw
        .iter()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect())
}

/// 前端 → Rust：任务工作目录的 git diff（M3 diff 面板数据源）。
#[tauri::command]
fn get_task_diff(store: State<'_, Store>, task_id: String) -> Result<String, String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;

    let output = std::process::Command::new("git")
        .args(["--no-pager", "diff", "--no-color", "--unified=3", "HEAD"])
        .current_dir(&row.cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法执行 git：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git diff 失败（目录可能不是 git 仓库）：{}",
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 前端 → Rust：唤起 harness 的登录流程（弹独立控制台跑 `* login`，
/// 浏览器 OAuth 完成后控制台自动结束，凭据写入各家的共享配置）。
#[tauri::command]
fn run_login(harness: String) -> Result<(), String> {
    let program = Harness::parse(&harness)?.program().to_string();
    let mut command = std::process::Command::new("cmd");
    command
        .args(["/C", "start", "", &program, "login"])
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        // 0x10 = CREATE_NEW_CONSOLE：给用户一个可见的登录终端
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0010);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("唤起登录失败：{e}"))
}

fn pi_session_task_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("deck-{nanos}")
}

/// 前端 → Rust：向 pi 会话发审批/中止指令。
#[tauri::command]
fn pi_command(
    pi_registry: State<'_, pi_session::PiRegistry>,
    task_id: String,
    cmd: String,
    id: Option<String>,
) -> Result<(), String> {
    pi_session::send_command(&pi_registry, &task_id, &cmd, id)
}

/// 前端 → Rust：读写设置（如 deck API key）。
#[tauri::command]
fn get_setting(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    store.get_setting(&key)
}

#[tauri::command]
fn set_setting(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    store.set_setting(&key, &value)
}

/// 前端 → Rust：动态发现 harness 的真实模型列表。
/// codex 读 desktop 状态文件（账号实际下发过的模型）；
/// opencode 调 `opencode models`；其余返回空（前端用内置目录）。
#[tauri::command]
fn discover_models(harness: String) -> Vec<String> {
    match harness.as_str() {
        "codex" => discover_codex_models(),
        "opencode" => discover_opencode_models(),
        _ => Vec::new(),
    }
}

const CODEX_MODEL_FALLBACK: &[&str] = &["gpt-5.1-codex", "gpt-5.1", "o4-mini"];

fn discover_codex_models() -> Vec<String> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let path = home.join(".codex").join(".codex-global-state.json");
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
        {
            // desktop 的最近使用 + 升级提示列表 = 账号实际可用的模型
            if let Some(arr) = v
                .pointer("/electron-persisted-atom-state/composer-recent-model-configurations-v1")
                .and_then(|x| x.as_array())
            {
                for item in arr {
                    if let Some(m) = item.get("model").and_then(|x| x.as_str()) {
                        out.push(m.to_string());
                    }
                }
            }
            if let Some(arr) = v
                .pointer("/electron-persisted-atom-state/seen-model-upgrade-list")
                .and_then(|x| x.as_array())
            {
                for item in arr {
                    if let Some(m) = item.as_str() {
                        out.push(m.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    if out.is_empty() {
        out = CODEX_MODEL_FALLBACK.iter().map(|s| s.to_string()).collect();
    }
    out
}

fn discover_opencode_models() -> Vec<String> {
    // opencode 是 .cmd 垫片，Windows 下须经 cmd /C
    let output = std::process::Command::new("cmd")
        .args(["/C", "opencode", "models"])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let mut out: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| l.contains('/'))
        .take(300)
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 前端 → Rust：默认工作目录。优先设置里的 default_cwd，否则用户家目录。
#[tauri::command]
fn get_default_cwd(store: State<'_, Store>) -> String {
    store
        .get_setting("default_cwd")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".into())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据库放在系统应用数据目录（%APPDATA%/com.shiyoo.agentdeck/）
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("failed to create data dir");
            let store = Store::open(&dir.join("agent-deck.db")).expect("failed to open store");
            app.manage(store);
            Ok(())
        })
        .manage(TaskRegistry::default())
        .manage(pi_session::PiRegistry::default())
        .invoke_handler(tauri::generate_handler![
            start_task,
            cancel_task,
            list_tasks,
            get_task_events,
            get_task_diff,
            run_login,
            pi_command,
            get_setting,
            set_setting,
            get_default_cwd,
            discover_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
