mod executors;
mod runner;
mod store;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::executors::Harness;
use crate::store::{Store, TaskRow};

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
    harness: String,
    cwd: String,
    prompt: String,
    mode: Option<String>,
    resume_session_id: Option<String>,
) -> Result<TaskStartInfo, String> {
    let harness = Harness::parse(&harness)?;
    let task_id = runner::new_task_id(harness);

    store.create_task(&task_id, harness.name(), &cwd, &prompt, mode.as_deref())?;

    let child = runner::spawn(harness, &mode, &cwd, &prompt, resume_session_id.as_deref())
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 数据库放在系统应用数据目录（%APPDATA%/com.shiyoo.agentdeck/）
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("failed to create data dir");
            let store = Store::open(&dir.join("agent-deck.db")).expect("failed to open store");
            app.manage(store);
            Ok(())
        })
        .manage(TaskRegistry::default())
        .invoke_handler(tauri::generate_handler![
            start_task,
            cancel_task,
            list_tasks,
            get_task_events,
            get_task_diff,
            run_login
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
