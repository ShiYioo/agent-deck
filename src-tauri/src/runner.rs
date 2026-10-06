//! 任务运行器：解析可执行文件 → 派生无头 CLI 子进程 → 逐行解析 JSONL → 以事件推给前端。

use std::path::PathBuf;
use std::process::Stdio;

use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::executors::Harness;
use crate::{TaskRegistry, emit_task_event};

pub fn new_task_id(harness: Harness) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", harness.name())
}

/// 解析程序名到可执行路径。Windows 上 npm 安装的 CLI 是 .cmd 垫片，
/// 不能直接 CreateProcess，需要经 `cmd /C` 启动。
async fn resolve_program(program: &str) -> Result<(PathBuf, Vec<String>), String> {
    let path = which::which(program)
        .map_err(|_| format!("未找到可执行文件：{program}（是否已安装并加入 PATH？）"))?;
    match path.extension().and_then(|e| e.to_str()) {
        Some("cmd") | Some("bat") => Ok((
            PathBuf::from("cmd"),
            vec!["/C".into(), path.to_string_lossy().to_string()],
        )),
        _ => Ok((path, Vec::new())),
    }
}

pub async fn spawn(
    harness: Harness,
    mode: &Option<String>,
    cwd: &str,
    prompt: &str,
    resume_session_id: Option<&str>,
) -> Result<tokio::process::Child, String> {
    let (program, mut prefix) = resolve_program(harness.program()).await?;
    let args = harness.build_args(mode.as_deref(), prompt, resume_session_id);
    prefix.extend(args);

    let mut command = tokio::process::Command::new(program);
    command
        .args(&prefix)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // 0x08000000 = CREATE_NO_WINDOW，避免每次派任务弹出黑色控制台
        command.creation_flags(0x0800_0000);
    }

    command.spawn().map_err(|e| format!("启动失败：{e}"))
}

/// 读取一个输出流，逐行解析为事件并推送给前端。stderr 同样送入解析器
/// （zcode 的鉴权错误就写在 stderr 上）。
async fn read_stream<R: tokio::io::AsyncRead + Unpin>(
    app: &tauri::AppHandle,
    task_id: &str,
    harness: Harness,
    stream: Option<R>,
) {
    let Some(stream) = stream else { return };
    let mut reader = BufReader::new(stream);
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
                for event in harness.parse_line(trimmed) {
                    emit_task_event(app, task_id, &event);
                }
            }
        }
    }
}

/// 主循环：并行读 stdout/stderr，结束后回写退出码并通知前端。
pub async fn stream_loop(
    app: tauri::AppHandle,
    task_id: String,
    harness: Harness,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    registry: TaskRegistry,
) {
    let app2 = app.clone();
    let task_id2 = task_id.clone();
    let out_reader = async {
        read_stream(&app2, &task_id2, harness, stdout).await;
    };
    let err_reader = async {
        read_stream(&app, &task_id, harness, stderr).await;
    };
    tokio::join!(out_reader, err_reader);

    // 两个流都关闭后，把子进程从任务表取出并等待退出码
    // （注意：MutexGuard 不能跨 await，必须先 take 再 wait）
    let mut child = {
        let mut guard = match registry.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.get_mut(&task_id).and_then(|task| task.child.take())
    };
    let code = match child.as_mut() {
        Some(c) => c.wait().await.ok().and_then(|s| s.code()),
        None => None,
    };

    let _ = app.emit(
        "task-exit",
        serde_json::json!({ "taskId": task_id, "code": code }),
    );
}
