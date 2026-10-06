mod executors;
mod runner;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::executors::Harness;

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
#[tauri::command]
async fn start_task(
    app: tauri::AppHandle,
    registry: State<'_, TaskRegistry>,
    harness: String,
    cwd: String,
    prompt: String,
    mode: Option<String>,
    resume_session_id: Option<String>,
) -> Result<TaskStartInfo, String> {
    let harness = Harness::parse(&harness)?;
    let task_id = runner::new_task_id(harness);

    let child = runner::spawn(harness, &mode, &cwd, &prompt, resume_session_id.as_deref())
        .await
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
    let task_id2 = task_id.clone();
    tauri::async_runtime::spawn(async move {
        runner::stream_loop(app, task_id2, harness, stdout, stderr, TaskRegistry(reg)).await;
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

pub fn run() {
    tauri::Builder::default()
        .manage(TaskRegistry::default())
        .invoke_handler(tauri::generate_handler![start_task, cancel_task])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
