//! 任务运行器：解析可执行文件 → 派生无头 CLI 子进程 → 逐行解析 JSONL →
//! 事件入库（SQLite）并推送给前端。

use std::path::PathBuf;
use std::process::Stdio;

use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::executors::{AgentEvent, Harness};
use crate::store::Store;
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
    model: &Option<String>,
    cwd: &str,
    prompt: &str,
    resume_session_id: Option<&str>,
    attachments: &[String],
    native_adapter: Option<&std::path::Path>,
    native_transport: Option<&str>,
    context_archive: Option<&str>,
    effort: Option<&str>,
) -> Result<command_group::AsyncGroupChild, String> {
    let (program, prefix) = if let Some(adapter) = native_adapter {
        let path = which::which(harness.program()).map_err(|e| e.to_string())?;
        let node = which::which("node").map_err(|_| "原生服务适配需要 Node.js".to_string())?;
        let params = serde_json::json!({
            "harness":harness.name(), "program":path, "mode":mode,
            "model":model, "cwd":cwd, "prompt":prompt, "resume":resume_session_id,
            "attachments":attachments.iter().filter(|p| harness != Harness::Codex || Harness::is_image_path(p)).collect::<Vec<_>>(),
            "transport":native_transport,
            "contextArchive":context_archive,
            "effort":effort,
        });
        (node, vec![adapter.to_string_lossy().into_owned(), params.to_string()])
    } else {
        let (program, mut prefix) = resolve_program(harness.program()).await?;
        prefix.extend(harness.build_execution_args(
        mode.as_deref(),
        model.as_deref(),
        prompt,
        resume_session_id,
        attachments,
        effort,
        ));
        (program, prefix)
    };

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

    // 进程组启动：终止时整树杀（cmd → node → CLI 不留孤儿）
    use command_group::AsyncCommandGroup;
    command
        .group()
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动失败：{e}"))
}

/// 读取一个输出流，逐行解析为事件：入库 + 推送前端。
/// stderr 同样送入解析器（zcode 的鉴权错误就写在 stderr 上）。
async fn read_stream<R: tokio::io::AsyncRead + Unpin>(
    app: &tauri::AppHandle,
    task_id: &str,
    harness: Harness,
    store: &Store,
    stream: Option<R>,
) -> bool {
    let Some(stream) = stream else { return false };
    let mut failed = false;
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
                    if matches!(
                        &event,
                        AgentEvent::Error { .. } | AgentEvent::Complete { ok: false, .. }
                    ) {
                        failed = true;
                    }
                    if let AgentEvent::SessionId { id } = &event {
                        let _ = store.set_session_id(task_id, id);
                    }
                    if let Ok(json) = serde_json::to_string(&event) {
                        let _ = store.append_event(task_id, &json);
                    }
                    emit_task_event(app, task_id, &event);
                }
            }
        }
    }
    failed
}

/// 主循环：并行读 stdout/stderr，结束后回写退出码并通知前端。
pub async fn stream_loop(
    app: tauri::AppHandle,
    task_id: String,
    harness: Harness,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    registry: TaskRegistry,
    store: Store,
) {
    let app2 = app.clone();
    let task_id2 = task_id.clone();
    let out_reader = async { read_stream(&app2, &task_id2, harness, &store, stdout).await };
    let err_reader = async { read_stream(&app, &task_id, harness, &store, stderr).await };
    let (out_failed, err_failed) = tokio::join!(out_reader, err_reader);

    // 两个流都关闭后，把子进程从任务表取出并等待退出码
    // （注意：MutexGuard 不能跨 await，必须先 take 再 wait）
    let (mut child, mut cancelled) = {
        let mut guard = match registry.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.get_mut(&task_id) {
            Some(task) => (task.child.take(), task.cancelled),
            None => (None, false),
        }
    };
    let code = match child.as_mut() {
        Some(c) => wait_for_exit(c, &registry, &task_id).await,
        None => None,
    };
    cancelled |= registry
        .0
        .lock()
        .ok()
        .and_then(|g| g.get(&task_id).map(|t| t.cancelled))
        .unwrap_or(false);

    let status = terminal_status(code, cancelled, out_failed || err_failed);
    let code = if cancelled {
        None
    } else if status == "failed" {
        Some(code.filter(|c| *c != 0).unwrap_or(1))
    } else {
        code
    };
    if status == "failed" && !out_failed && !err_failed {
        let event = AgentEvent::Error {
            kind: "other".into(),
            message: format!(
                "{} 异常退出（退出码 {}），请检查运行输出",
                harness.name(),
                code.unwrap_or(-1)
            ),
        };
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = store.append_event(&task_id, &json);
        }
        emit_task_event(&app, &task_id, &event);
    }
    store.finish_task(&task_id, status, code.map(|c| c as i64));

    // 任务表清账：条目残留会让注册表随任务数无限增长
    if let Ok(mut guard) = registry.0.lock() {
        guard.remove(&task_id);
    }

    let _ = app.emit(
        "task-exit",
        serde_json::json!({ "taskId": task_id, "code": code, "status": status }),
    );
}

async fn wait_for_exit(
    child: &mut command_group::AsyncGroupChild,
    registry: &TaskRegistry,
    task_id: &str,
) -> Option<i32> {
    loop {
        let cancelled = registry
            .0
            .lock()
            .ok()
            .and_then(|g| g.get(task_id).map(|task| task.cancelled))
            .unwrap_or(false);
        if cancelled {
            let _ = child.start_kill();
        }
        match child.inner().try_wait() {
            Ok(Some(status)) => {
                // An executor's background descendants cannot outlive its workspace lease.
                let _ = child.start_kill();
                return child
                    .wait()
                    .await
                    .ok()
                    .map(|_| status)
                    .and_then(|status| status.code());
            }
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
            Err(_) => return None,
        }
    }
}

fn terminal_status(code: Option<i32>, cancelled: bool, failed: bool) -> &'static str {
    if cancelled {
        "cancelled"
    } else if code == Some(0) && !failed {
        "done"
    } else {
        "failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_remains_effective_without_output_readers() {
        use command_group::AsyncCommandGroup;
        let node = which::which("node").unwrap();
        let mut command = tokio::process::Command::new(node);
        command
            .args(["-e", "setInterval(()=>{},1000)"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.group().kill_on_drop(true).spawn().unwrap();
        assert!(child.inner().stdout.is_none() && child.inner().stderr.is_none());
        assert!(child.inner().try_wait().unwrap().is_none());
        let registry = TaskRegistry::default();
        registry.0.lock().unwrap().insert(
            "closed-stream".into(),
            crate::RunningTask {
                label: "test".into(),
                child: None,
                cancelled: true,
            },
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            wait_for_exit(&mut child, &registry, "closed-stream"),
        )
        .await
        .expect("cancelled process did not exit");
    }

    #[test]
    fn cancellation_and_protocol_errors_override_process_exit_codes() {
        assert_eq!(terminal_status(Some(0), false, false), "done");
        assert_eq!(terminal_status(Some(0), false, true), "failed");
        assert_eq!(terminal_status(Some(1), true, true), "cancelled");
        assert_eq!(terminal_status(None, false, false), "failed");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn owned_process_groups_terminate_descendants_when_dropped() {
        use command_group::AsyncCommandGroup;
        let node = which::which("node").unwrap();
        let mut command = tokio::process::Command::new(node);
        command.args(["-e","const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)"])
            .stdout(Stdio::piped()).creation_flags(0x0800_0000);
        let mut child = command.group().kill_on_drop(true).spawn().unwrap();
        let stdout = child.inner().stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let pid = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop(child);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let output = tokio::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .creation_flags(0x0800_0000)
                .output()
                .await
                .unwrap();
            if !String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "test descendant survived its owning group"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn successful_executor_exit_closes_background_descendants_before_releasing_ownership() {
        use command_group::AsyncCommandGroup;
        let mut command = tokio::process::Command::new(which::which("node").unwrap());
        command.args(["-e","const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);process.exit(0)"])
            .stdout(Stdio::piped()).creation_flags(0x0800_0000);
        let mut child = command.group().kill_on_drop(true).spawn().unwrap();
        let stdout = child.inner().stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let pid = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let code = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            wait_for_exit(&mut child, &TaskRegistry::default(), "completed"),
        )
        .await
        .expect("background child prevented executor completion");
        assert_eq!(code, Some(0));
        let output = tokio::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")));
    }
}
