//! Diff 实时推流（抄 VK filesystem_watcher 思路）：
//! notify-debouncer-full 监听工作目录（跳过 .git 噪音），400ms 防抖后
//! 重算 `git diff HEAD`，以 `diff-update` 事件推给前端。
//! 生命周期：弹层打开时前端 start，关闭/任务结束 stop（drop 即停止监听）。

use std::{collections::HashMap, path::Path, sync::Mutex, time::Duration};

use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct DiffWatchHandle {
    /// 保活：drop 即停止监听
    pub _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

#[derive(Default)]
pub struct DiffWatchRegistry(pub Mutex<HashMap<String, DiffWatchHandle>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct DiffUpdate {
    pub task_id: String,
    pub text: String,
}

/// .git 目录内的变化（index 更新、hook 写入等）对工作区 diff 无意义
fn is_git_noise(path: &std::path::Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy() == ".git")
}

fn compute_diff(cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["--no-pager", "diff", "HEAD", "--no-color", "--unified=3"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn stop_at(registry: &DiffWatchRegistry, task_id: &str) {
    if let Ok(mut guard) = registry.0.lock() {
        guard.remove(task_id); // drop watcher → 停止监听 → 防抖线程随 rx 关闭退出
    }
}

/// 前端 → Rust：开始监听某任务工作目录的改动并推流。
#[tauri::command]
pub fn diff_watch_start(
    app: AppHandle,
    registry: State<'_, DiffWatchRegistry>,
    task_id: String,
    cwd: String,
) -> Result<(), String> {
    stop_at(&registry, &task_id);

    // 闭包 handler：过滤 .git 噪音后只发一个「有变化」信号
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut debouncer: Debouncer<RecommendedWatcher, RecommendedCache> = new_debouncer(
        Duration::from_millis(400),
        None,
        move |res: notify_debouncer_full::DebounceEventResult| {
            if let Ok(events) = res
                && events
                    .iter()
                    .any(|e| e.paths.iter().any(|p| !is_git_noise(p)))
            {
                let _ = tx.send(());
            }
        },
    )
    .map_err(|e| e.to_string())?;
    // 0.5 起 Debouncer 自身实现 Watcher，直接 watch
    debouncer
        .watch(Path::new(&cwd), notify::RecursiveMode::Recursive)
        .map_err(|e| format!("监听工作目录失败：{e}"))?;

    registry.0.lock().map_err(|_| "registry poisoned")?.insert(
        task_id.clone(),
        DiffWatchHandle {
            _debouncer: debouncer,
        },
    );

    let app2 = app.clone();
    let tid = task_id.clone();
    let cwd2 = cwd.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            // 排干积压信号（防抖后清一轮，避免连发）
            while rx.try_recv().is_ok() {}

            if let Some(text) = compute_diff(&cwd2) {
                let _ = app2.emit(
                    "diff-update",
                    DiffUpdate {
                        task_id: tid.clone(),
                        text,
                    },
                );
            }
        }
    });

    Ok(())
}

/// 前端 → Rust：停止监听。
#[tauri::command]
pub fn diff_watch_stop(
    registry: State<'_, DiffWatchRegistry>,
    task_id: String,
) -> Result<(), String> {
    stop_at(&registry, &task_id);
    Ok(())
}
