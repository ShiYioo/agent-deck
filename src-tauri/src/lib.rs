mod collaboration;
mod diff_watch;
mod executors;
mod handoff;
mod pi_session;
mod runner;
mod store;
mod worktree;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};
use worktree::WorktreePaths;

use crate::executors::Harness;
use crate::store::{ModelProfile, ProfileModelRow, ProjectRow, Store, TaskRow};

/// 档案 → sidecar 模型目录参数（读子表；失败视为空目录，不阻塞派发）
fn profile_models_param(store: &Store, profile_id: &str) -> Vec<pi_session::ProfileModelParam> {
    store
        .list_profile_models(profile_id)
        .unwrap_or_default()
        .into_iter()
        .map(|m| pi_session::ProfileModelParam {
            id: m.model,
            context_window: m.context_window,
            max_tokens: m.max_tokens,
        })
        .collect()
}

/// 去掉 Windows verbatim 前缀（`\\?\C:\...`）：node 的模块加载器解析这种路径
/// 会在盘根段 lstat 出 EISDIR，sidecar 启动即崩。
fn normalize_windows_path(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.as_os_str().to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest)
    } else {
        p
    }
}

/// deck-agent.mjs 的位置：优先资源目录（打包后），回退仓库源码（开发模式）。
fn sidecar_path(app: &AppHandle) -> std::path::PathBuf {
    // 开发模式永远优先源码：资源目录里的副本可能是任意历史构建的旧产物
    #[cfg(debug_assertions)]
    {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("agent")
            .join("deck-agent.mjs");
        if dev.exists() {
            return normalize_windows_path(dev);
        }
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let p = normalize_windows_path(res_dir.join("agent").join("deck-agent.mjs"));
        if p.exists() {
            return p;
        }
    }
    normalize_windows_path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("agent")
            .join("deck-agent.mjs"),
    )
}

/// 运行中/刚结束的任务：保留子进程句柄用于取消。
/// command-group 的进程组子进程：start_kill 会终止整棵进程树
/// （cmd /C → node → CLI），杜绝 Windows 上的孤儿进程烧额度。
pub struct RunningTask {
    pub label: String,
    pub child: Option<command_group::AsyncGroupChild>,
    pub cancelled: bool,
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

#[derive(Serialize)]
struct HarnessHealth {
    ready: bool,
    issues: Vec<String>,
}

#[tauri::command]
async fn check_harness(
    app: AppHandle,
    store: State<'_, Store>,
    harness: String,
) -> Result<HarnessHealth, String> {
    let mut issues = Vec::new();
    if harness == "deck" {
        if which::which("node").is_err() {
            issues.push("未找到 Node.js".into());
        }
        if !sidecar_path(&app).is_file() {
            issues.push("运行时文件缺失".into());
        }
        let profiles = store.list_model_profiles(true)?;
        if profiles.is_empty() {
            issues.push("请在设置中添加并启用模型配置".into());
        } else if profiles
            .iter()
            .all(|profile| profile.api_key.trim().is_empty())
        {
            issues.push("启用的模型配置缺少 API Key".into());
        }
    } else {
        let runner = Harness::parse(&harness)?;
        if which::which(runner.program()).is_err() {
            issues.push(format!("未找到 {}，请安装并加入 PATH", runner.program()));
        }
    }
    Ok(HarnessHealth {
        ready: issues.is_empty(),
        issues,
    })
}

/// 前端 → Rust：启动一个无头 agent 任务。
// tauri command 签名参数固定较多，属框架形态
/// 会话归属：接力/续接轮次继承指定会话根；无指定或根不存在 = 自成新会话。
fn mark_conversation(
    store: &Store,
    task_id: &str,
    conversation_id: Option<&str>,
) -> Result<(), String> {
    match conversation_id {
        Some(cid) if store.get_task(cid)?.is_some() => {
            // 旧会话根没有 conversation_id：回填自身，历史会话也能跨 harness 归组
            if store
                .get_task(cid)?
                .and_then(|t| t.conversation_id)
                .is_none()
            {
                store.set_task_conversation(cid, cid)?;
            }
            store.set_task_conversation(task_id, cid)
        }
        _ => store.set_task_conversation(task_id, task_id),
    }
}

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
    project_id: Option<String>,
    conversation_id: Option<String>,
    relay: Option<bool>,
) -> Result<TaskStartInfo, String> {
    start_task_impl(
        app,
        registry,
        store,
        pi_registry,
        harness,
        cwd,
        prompt,
        mode,
        model,
        permission,
        resume_session_id,
        project_id,
        conversation_id,
        relay,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_task_impl(
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
    project_id: Option<String>,
    conversation_id: Option<String>,
    relay: Option<bool>,
) -> Result<TaskStartInfo, String> {
    if prompt.trim().is_empty() {
        return Err("请输入任务描述".into());
    }
    if !Path::new(&cwd).is_dir() {
        return Err(format!("工作目录不存在：{cwd}"));
    }
    // deck = AgentDeck 自有运行时（pi sidecar），走独立通道
    if harness.eq_ignore_ascii_case("deck") {
        let task_id = pi_session_task_id();
        let deck_project =
            project_id.or_else(|| store.find_project_by_dir(&cwd).ok().flatten().map(|p| p.id));
        // 模型池：启用的配置档案按创建顺序构成自治链（sidecar 内自动降级）
        let profiles: Vec<pi_session::ModelProfileParam> = store
            .list_model_profiles(true)?
            .into_iter()
            .map(|p| pi_session::ModelProfileParam {
                id: p.id.clone(),
                provider: p.provider,
                key: p.api_key,
                base_url: p.base_url,
                model: p.model,
                protocol: p.protocol,
                models: profile_models_param(&store, &p.id),
            })
            .collect();
        // Composer 选择器：model = "<profileId>:<modelId>" → 该档案置顶并锁定模型，
        // 其余启用档案随后兜底（保留自动降级链）
        let mut chain = profiles;
        if let Some(sel) = model.as_deref().filter(|s| !s.is_empty() && *s != "auto") {
            if let Some((pid, mid)) = sel.split_once(':') {
                if let Some(pos) = chain.iter().position(|p| p.id == pid) {
                    let mut chosen = chain.remove(pos);
                    chosen.model = Some(mid.to_string());
                    chain.insert(0, chosen);
                }
            }
        }
        let profiles = chain;
        if profiles.is_empty() {
            return Err("模型池为空，请到设置添加并启用至少一个模型配置".into());
        }
        store.create_task(
            &task_id,
            "deck",
            &cwd,
            &prompt,
            permission.as_deref(),
            model.as_deref(),
            deck_project.as_deref(),
        )?;
        let user_event = serde_json::json!({
            "type": "user_message", "text": prompt,
            "hidden": relay.unwrap_or(false),
        });
        store.append_event(&task_id, &user_event.to_string())?;
        if let Some(id) = &resume_session_id {
            store.set_session_id(&task_id, id)?;
        }
        mark_conversation(&store, &task_id, conversation_id.as_deref())?;
        let use_cwd_deck = cwd.clone();
        let task_memories = store.list_memories(&cwd, 20).unwrap_or_default();
        let params = pi_session::PiRunParams {
            prompt,
            model: "auto".into(),
            cwd: use_cwd_deck,
            profiles,
            memories: task_memories,
            // 选中既有 deck 任务再发消息 = 续接（上次 pi 会话文件由 sidecar 打开）
            resume_session_file: resume_session_id.clone(),
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
            let result = pi_session::run_pi_task(
                app2.clone(),
                task_id2.clone(),
                params,
                store2.clone_handle(),
                reg.clone(),
                sidecar,
            )
            .await;
            if let Err(e) = result {
                reg.remove(&task_id2);
                let event = serde_json::json!({
                    "type": "deck_error", "taskId": task_id2, "message": e
                });
                let _ = store2.append_event(&task_id2, &event.to_string());
                store2.finish_task(&task_id2, "failed", Some(1));
                let _ = app2.emit("pi-event", event);
                let _ = app2.emit(
                    "task-exit",
                    serde_json::json!({
                        "taskId": task_id2, "code": 1, "status": "failed"
                    }),
                );
            }
        });
        return Ok(TaskStartInfo { task_id });
    }

    let harness = Harness::parse(&harness)?;
    let task_id = runner::new_task_id(harness);

    // git 仓库内派发的任务：自动 worktree 隔离（改动圈在任务分支里）
    let mut worktree: Option<WorktreePaths> = None;
    if resume_session_id.is_none()
        && project_id.is_none()
        && worktree::is_git_repo(Path::new(&cwd))
        && store
            .get_setting("worktree_isolation")
            .ok()
            .flatten()
            .as_deref()
            != Some("off")
    {
        match worktree::create(Path::new(&cwd), &task_id) {
            Ok(paths) => worktree = Some(paths),
            Err(e) => {
                return Err(format!("worktree 创建失败：{e}（可在设置关闭隔离）"));
            }
        }
    }

    let task_cwd = worktree
        .as_ref()
        .map(|w| w.dir.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.clone());
    let cli_project =
        project_id.or_else(|| store.find_project_by_dir(&cwd).ok().flatten().map(|p| p.id));
    store.create_task(
        &task_id,
        harness.name(),
        &task_cwd,
        &prompt,
        mode.as_deref(),
        model.as_deref(),
        cli_project.as_deref(),
    )?;
    if let Some(w) = &worktree {
        store.set_task_worktree(
            &task_id,
            &w.branch,
            &w.base_commit,
            &w.dir.to_string_lossy(),
        )?;
    }
    store.append_event(
        &task_id,
        &serde_json::json!({
            "type": "user_message", "text": prompt,
            "hidden": relay.unwrap_or(false),
        })
        .to_string(),
    )?;
    if let Some(id) = &resume_session_id {
        store.set_session_id(&task_id, id)?;
    }
    mark_conversation(&store, &task_id, conversation_id.as_deref())?;

    // ZCode 模型选择：CLI 无 --model 旗标，官方机制是持久化 defaultModelSelection
    // （/model 的落盘字段）。选了模型 = 切换 ZCode 默认模型，对该 CLI 后续会话生效。
    if harness == Harness::Zcode
        && let Some(m) = model.as_deref().filter(|s| !s.is_empty())
    {
        if let Err(e) = write_zcode_default_model(m) {
            return Err(format!("应用 ZCode 模型失败：{e}"));
        }
    }

    let child = runner::spawn(
        harness,
        &mode,
        &model,
        &task_cwd,
        &prompt,
        resume_session_id.as_deref(),
    )
    .await
    .inspect_err(|_| {
        store.finish_task(&task_id, "failed", None);
        if let Some(w) = &worktree {
            let _ = worktree::remove(Path::new(&cwd), &task_id, true);
            eprintln!("worktree cleaned after spawn failure: {}", w.dir.display());
        }
    })
    .map_err(|e| e.to_string())?;

    let mut child = child;
    let stdout = child.inner().stdout.take();
    let stderr = child.inner().stderr.take();

    registry
        .0
        .lock()
        .map_err(|_| "task registry poisoned")?
        .insert(
            task_id.clone(),
            RunningTask {
                label: harness.name().to_string(),
                child: Some(child),
                cancelled: false,
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
            child.start_kill().map_err(|e| format!("终止失败：{e}"))?;
            task.cancelled = true;
        }
        Ok(())
    } else {
        Err(format!("unknown task: {task_id}"))
    }
}

/// 前端 → Rust：最近的任务历史。
#[tauri::command]
async fn list_tasks(store: State<'_, Store>, limit: Option<i64>) -> Result<Vec<TaskRow>, String> {
    store.list_tasks(limit.unwrap_or(50))
}

/// 前端 → Rust：读取某个任务的全部事件（历史回放）。
#[tauri::command]
async fn get_task_events(
    store: State<'_, Store>,
    task_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    conversation_events(&store, &task_id)
}

pub(crate) fn conversation_events(
    store: &Store,
    task_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let row = store
        .get_task(task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let mut turns = if let Some(session) = row.session_id.as_deref() {
        store
            .list_tasks(i64::MAX)?
            .into_iter()
            .filter(|turn| {
                turn.harness == row.harness
                    && turn.session_id.as_deref() == Some(session)
                    && turn.created_at <= row.created_at
            })
            .collect::<Vec<_>>()
    } else {
        vec![row]
    };
    turns.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    let mut raw = Vec::new();
    for turn in turns {
        raw.extend(store.get_events(&turn.id, 0, i64::MAX)?);
    }
    Ok(raw
        .iter()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect())
}

#[cfg(test)]
mod conversation_tests {
    use super::*;

    #[test]
    fn history_replays_prior_turns_without_future_or_other_harness_events() {
        let store = Store::in_memory().unwrap();
        for (id, harness) in [("first", "deck"), ("other", "codex"), ("second", "deck")] {
            store
                .create_task(id, harness, ".", id, None, None, None)
                .unwrap();
            store.set_session_id(id, "shared-session").unwrap();
            store
                .append_event(
                    id,
                    &serde_json::json!({
                        "type": "user_message", "text": id
                    })
                    .to_string(),
                )
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let first = conversation_events(&store, "first").unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["text"], "first");
        let second = conversation_events(&store, "second").unwrap();
        assert_eq!(
            second
                .iter()
                .map(|event| event["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(conversation_events(&store, "missing").is_err());
    }
}

/// 前端 → Rust：任务工作目录的 git diff（M3 diff 面板数据源）。
#[tauri::command]
fn get_task_diff(store: State<'_, Store>, task_id: String) -> Result<String, String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;

    if !std::path::Path::new(&row.cwd).is_dir() {
        return Err(format!("任务目录不存在：{}", row.cwd));
    }

    // 非 git 目录：明确返回空 diff（不是错误），前端显示为"无改动"
    let inside = std::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&row.cwd)
        .stdin(Stdio::null())
        .output();
    match inside {
        Ok(out)
            if out.status.success()
                && out.stdout
                    == b"true
" => {}
        _ => return Ok(String::new()),
    }

    // worktree 任务：diff 对 base_branch（纯任务改动）；普通任务：对 HEAD
    let diff_args: Vec<&str> = match row.base_branch.as_deref() {
        Some(b) => vec!["--no-pager", "diff", "--no-color", "--unified=3", b],
        None => vec!["--no-pager", "diff", "--no-color", "--unified=3", "HEAD"],
    };
    let output = std::process::Command::new("git")
        .args(&diff_args)
        .current_dir(&row.cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法执行 git：{e}"))?;

    if !output.status.success() {
        // 只留一行关键信息，不把 git 的 usage 全文倒进 UI
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_line = stderr.lines().next().unwrap_or("").trim();
        return Err(format!("git diff 失败：{first_line}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 前端 → Rust：删除会话（运行中先终止；事件与任务记录一并清除）。
#[tauri::command]
fn delete_task(
    app: AppHandle,
    registry: State<'_, TaskRegistry>,
    pi_registry: State<'_, pi_session::PiRegistry>,
    store: State<'_, Store>,
    task_id: String,
) -> Result<(), String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    if row.status == "running" {
        let _ = cancel_task(registry, task_id.clone());
        if row.harness == "deck" {
            let _ = pi_command(pi_registry, task_id.clone(), "abort".into(), None);
        }
    }
    store.delete_task(&task_id)?;
    let _ = app.emit("task-deleted", &task_id);
    Ok(())
}

/// Delete a conversation by any turn, including turns outside the UI history window.
#[tauri::command]
fn delete_session(
    app: AppHandle,
    registry: State<'_, TaskRegistry>,
    pi_registry: State<'_, pi_session::PiRegistry>,
    store: State<'_, Store>,
    task_id: String,
) -> Result<Vec<String>, String> {
    let turns = store.session_tasks(&task_id)?;
    for turn in &turns {
        if turn.status == "running" {
            if turn.harness == "deck" {
                pi_command(pi_registry.clone(), turn.id.clone(), "abort".into(), None)?;
            } else {
                cancel_task(registry.clone(), turn.id.clone())?;
            }
        }
    }
    let ids = turns.into_iter().map(|turn| turn.id).collect::<Vec<_>>();
    store.delete_tasks(&ids)?;
    for id in &ids {
        let _ = app.emit("task-deleted", id);
    }
    Ok(ids)
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

pub(crate) fn pi_session_task_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("deck-{nanos}")
}

/// 前端 → Rust：AI 交接——用 deck 运行时（pi）把会话记录压缩成交接简报再组装。
/// AI 压缩是唯一路径：无 key / 失败 / 超时都明确报错，不做劣质降级。
#[tauri::command]
async fn build_smart_handoff_prompt(
    app: AppHandle,
    store: State<'_, Store>,
    task_id: String,
) -> Result<String, String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let events = conversation_events(&store, &task_id)?
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>();
    let convo = handoff::render_conversation(&events);

    // 无会话记录：不是压缩失败，直接组装「仅任务原话」的交接
    let summary_note = if convo.trim().is_empty() {
        String::from("（该任务无对话记录。请直接执行下方的原始任务。）")
    } else {
        // 压缩模型与 key：优先 GLM，退 GPT（来自设置面板）
        let profiles: Vec<pi_session::ModelProfileParam> = store
            .list_model_profiles(true)?
            .into_iter()
            .map(|p| pi_session::ModelProfileParam {
                id: p.id.clone(),
                provider: p.provider,
                key: p.api_key,
                base_url: p.base_url,
                model: p.model,
                protocol: p.protocol,
                models: profile_models_param(&store, &p.id),
            })
            .collect();
        if profiles.is_empty() {
            return Err("未配置任何启用的模型档案——请到设置面板添加并启用".into());
        }

        let sidecar = sidecar_path(&app);
        match tokio::time::timeout(
            std::time::Duration::from_secs(90),
            pi_session::pi_summarize_text(&sidecar, &profiles, &row.cwd, &convo),
        )
        .await
        {
            Ok(Ok(s)) if !s.trim().is_empty() => s,
            Ok(Ok(_)) => return Err("AI 压缩返回了空简报，请重试".into()),
            Ok(Err(e)) => return Err(format!("AI 压缩失败：{e}")),
            Err(_) => return Err("AI 压缩超时（90 秒）——请重试或检查网络".into()),
        }
    };

    let model_note = row
        .model
        .as_deref()
        .map(|m| format!("（模型 {m}）"))
        .unwrap_or_default();

    Ok(handoff::assemble_ai_handoff(
        &row.harness,
        &model_note,
        &row.prompt,
        &summary_note,
        &handoff::convo_tail(&convo, 3_000),
    ))
}

// ── 轮次产出面板：改动文件（+/-行、diff、撤销）与生成工件 ──

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TurnFileChange {
    pub path: String,
    /// added | modified | deleted
    pub status: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
    pub diff: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TurnArtifact {
    pub path: String,
    /// image | archive | sheet | doc | pdf | other
    pub kind: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TurnArtifacts {
    pub files: Vec<TurnFileChange>,
    pub artifacts: Vec<TurnArtifact>,
    /// git 操作的工作目录（worktree 任务的隔离目录）
    pub base_dir: String,
}

const TURN_DIFF_CAP: usize = 60_000;

fn artifact_kind(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    let ext = ext.as_str();
    Some(match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" => "image",
        "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "xz" | "bz2" => "archive",
        "xlsx" | "xls" | "csv" => "sheet",
        "docx" | "doc" | "pptx" | "ppt" => "doc",
        "pdf" => "pdf",
        _ => return None,
    })
}

fn turn_git(dir: &std::path::Path, args: &[&str]) -> Option<std::process::Output> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .creation_flags(0x0800_0000)
        .output()
        .ok()
}

fn turn_git_ok(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = turn_git(dir, args)?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// status --porcelain 行 → (xy, path)；处理 R 重命名的 "new -> old" 与引号
fn parse_porcelain(line: &str) -> Option<(String, String)> {
    if line.len() < 4 {
        return None;
    }
    let xy = line[..2].to_string();
    let mut path = line[3..].trim().to_string();
    if path.starts_with('"') && path.ends_with('"') {
        path = path[1..path.len() - 1].to_string();
    }
    if path.contains(" -> ") {
        let (a, _) = path.split_once(" -> ").unwrap();
        path = a.trim().to_string();
    }
    Some((xy, path))
}

#[tauri::command]
fn get_turn_artifacts(store: State<'_, Store>, task_id: String) -> Result<TurnArtifacts, String> {
    use std::collections::BTreeMap;
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let dir = row.worktree_dir.clone().unwrap_or_else(|| row.cwd.clone());
    let dir_path = std::path::Path::new(&dir);
    if !dir_path.is_dir() {
        return Err(format!("任务目录不存在：{dir}"));
    }
    // 非 git 目录：扫描任务开始后新建/修改的文件（浅层，跳过依赖与隐藏目录）
    if turn_git_ok(dir_path, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() != "true")
        .unwrap_or(true)
    {
        let started = row.created_at - 5_000; // 容忍时钟偏差
        let mut artifacts: Vec<TurnArtifact> = Vec::new();
        let skip = |name: &str| {
            matches!(
                name,
                "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".venv" | "vendor"
            ) || name.starts_with('.')
        };
        let mut stack = vec![dir_path.to_path_buf()];
        let mut visited = 0usize;
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else {
                continue;
            };
            for entry in rd.flatten() {
                visited += 1;
                if visited > 5000 {
                    return Ok(TurnArtifacts {
                        files: Vec::new(),
                        artifacts,
                        base_dir: dir,
                    });
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let p = entry.path();
                if p.is_dir() {
                    if !skip(&name) {
                        stack.push(p);
                    }
                    continue;
                }
                if skip(&name) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if modified < started {
                    continue;
                }
                let rel = p
                    .strip_prefix(dir_path)
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or(name.clone());
                if let Some(kind) = artifact_kind(&rel) {
                    artifacts.push(TurnArtifact {
                        path: rel,
                        kind: kind.to_string(),
                        size: meta.len(),
                    });
                }
            }
        }
        artifacts.sort_by(|a, b| a.path.cmp(&b.path));
        return Ok(TurnArtifacts {
            files: Vec::new(),
            artifacts,
            base_dir: dir,
        });
    }

    // 1) status --porcelain：改动全集（含未跟踪）
    let status_out = turn_git_ok(dir_path, &["status", "--porcelain"]).unwrap_or_default();
    let entries: Vec<(String, String)> = status_out
        .lines()
        .filter_map(parse_porcelain)
        .filter(|(_, path)| !path.is_empty() && !path.starts_with(".git/"))
        .collect();

    // 2) numstat（跟踪文件 vs HEAD）：path → (added, removed, binary)
    let numstat_out = turn_git_ok(dir_path, &["diff", "--numstat", "HEAD"]).unwrap_or_default();
    let mut numstat: BTreeMap<String, (Option<u64>, Option<u64>)> = BTreeMap::new();
    for line in numstat_out.lines() {
        let mut parts = line.split('\t');
        let (Some(a), Some(r), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let added = if a == "-" {
            None
        } else {
            a.parse::<u64>().ok()
        };
        let removed = if r == "-" {
            None
        } else {
            r.parse::<u64>().ok()
        };
        numstat.insert(p.to_string(), (added, removed));
    }

    // 3) 逐文件：状态、行数、diff 文本（cap）
    let mut files = Vec::new();
    let mut artifacts = Vec::new();
    for (xy, path) in &entries {
        let untracked = xy.starts_with("??");
        let deleted = xy.contains('D');
        let full = dir_path.join(path);
        let (added, removed, binary) = if untracked {
            match std::fs::read(full) {
                Ok(bytes) => {
                    let bin = bytes.contains(&0);
                    (
                        if bin {
                            None
                        } else {
                            Some(bytes.iter().filter(|&&b| b == b'\n').count() as u64 + 1)
                        },
                        Some(0),
                        bin,
                    )
                }
                Err(_) => (None, Some(0), false),
            }
        } else {
            let (a, r) = numstat.get(path).copied().unwrap_or((None, None));
            (a, r, a.is_none() && r.is_none())
        };

        let diff = if deleted {
            String::new()
        } else {
            let text = if untracked {
                turn_git(dir_path, &["diff", "--no-index", "--", "/dev/null", path])
                    .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            } else {
                turn_git_ok(dir_path, &["diff", "HEAD", "--unified=3", "--", path])
            }
            .unwrap_or_default();
            text.chars().take(TURN_DIFF_CAP).collect()
        };

        let status = if untracked {
            "added"
        } else if deleted {
            "deleted"
        } else {
            "modified"
        };

        if let Some(kind) = artifact_kind(path) {
            let size = std::fs::metadata(dir_path.join(path))
                .map(|m| m.len())
                .unwrap_or(0);
            artifacts.push(TurnArtifact {
                path: path.clone(),
                kind: kind.to_string(),
                size,
            });
        }

        files.push(TurnFileChange {
            path: path.clone(),
            status: status.to_string(),
            added,
            removed,
            binary,
            diff,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    artifacts.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(TurnArtifacts {
        files,
        artifacts,
        base_dir: dir,
    })
}

/// 撤销单文件改动：未跟踪 = 删除新文件；跟踪 = 还原到 HEAD。破坏性操作由前端二次确认。
#[tauri::command]
fn undo_task_file(store: State<'_, Store>, task_id: String, path: String) -> Result<(), String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let dir = row.worktree_dir.clone().unwrap_or_else(|| row.cwd.clone());
    let dir_path = std::path::Path::new(&dir);
    if !dir_path.is_dir() {
        return Err(format!("任务目录不存在：{dir}"));
    }
    let safe = path.replace('"', "");
    let status_out =
        turn_git_ok(dir_path, &["status", "--porcelain", "--", &safe]).ok_or("git status 失败")?;
    let untracked = status_out
        .lines()
        .next()
        .map(|l| l.starts_with("??"))
        .unwrap_or(false);
    let out = if untracked {
        turn_git(dir_path, &["clean", "-f", "--", &safe])
    } else {
        turn_git(dir_path, &["checkout", "HEAD", "--", &safe])
    };
    match out {
        Some(o) if o.status.success() => Ok(()),
        Some(o) => Err(format!(
            "撤销失败：{}",
            String::from_utf8_lossy(&o.stderr)
                .lines()
                .next()
                .unwrap_or("未知错误")
        )),
        None => Err("无法执行 git".into()),
    }
}

/// 用系统默认程序打开工件；reveal = 在文件夹中显示。
#[tauri::command]
fn open_artifact(path: String, reveal: bool) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let full = if p.is_absolute() {
        path.clone()
    } else {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        cwd.join(p).display().to_string()
    };
    if !std::path::Path::new(&full).exists() {
        return Err(format!("文件不存在：{full}"));
    }
    if reveal {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{full}\""))
                .creation_flags(0x0800_0000)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(windows))]
        let _ = reveal;
    } else {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &full])
                .creation_flags(0x0800_0000)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        // 本项目仅分发 Windows（NSIS）；非 Windows 无操作
    }
    Ok(())
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
/// opencode 调 `opencode models`；zcode 读 ~/.zcode/v2/config.json 的
/// provider.models（按 setting.json 选中的 provider 过滤）；其余返回空。
#[tauri::command]
async fn discover_models(harness: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || match harness.as_str() {
        "codex" => discover_codex_models(),
        "opencode" => discover_opencode_models(),
        "zcode" => discover_zcode_models(),
        _ => Vec::new(),
    })
    .await
    .unwrap_or_default()
}

/// ZCode 模型目录：config.json → provider.<选中或全部>.models 的键。
/// 返回 "providerId/modelId"（ZCode ModelSelection 的 picker 形态）。
fn discover_zcode_models() -> Vec<String> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let cfg: serde_json::Value = match std::fs::read_to_string(home.join(".zcode/v2/config.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return Vec::new(),
    };
    let providers = cfg.get("provider").and_then(|v| v.as_object());
    let Some(providers) = providers else {
        return Vec::new();
    };

    // 用户在 ZCode 里选中的 provider（setting.json → family selected key 去 "coding-plan:" 前缀）
    let selected: Option<String> = std::fs::read_to_string(home.join(".zcode/v2/setting.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|s| {
            s.get("modelProviderFamilySelectedKeys")?
                .get("bigmodel")?
                .as_str()
                .map(str::to_string)
        })
        .map(|k| k.trim_start_matches("coding-plan:").to_string());

    let mut out = Vec::new();
    let mut ids: Vec<&String> = providers.keys().collect();
    ids.sort();
    for pid in ids {
        if let Some(sel) = &selected {
            if pid.as_str() != sel && !pid.starts_with("builtin:") {
                continue;
            }
            if pid.starts_with("builtin:") && pid.as_str() != sel && sel.starts_with("builtin:") {
                continue;
            }
        }
        if let Some(models) = providers[pid].get("models").and_then(|m| m.as_object()) {
            for mid in models.keys() {
                out.push(format!("{pid}/{mid}"));
            }
        }
    }
    out
}

/// 把 ZCode 默认模型写入 personal 配置（官方 /model 的持久化字段）。
/// model 形如 "providerId/modelId"；原子替换，保留其余字段。
fn write_zcode_default_model(model: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("无法定位家目录")?;
    let path = home.join(".zcode/v2/config.json");
    let (provider_id, model_id) = model
        .split_once('/')
        .ok_or_else(|| format!("ZCode 模型需为 providerId/modelId：{model}"))?;
    let mut cfg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| format!("读取 ZCode 配置失败：{e}"))?,
    )
    .map_err(|e| format!("解析 ZCode 配置失败：{e}"))?;
    cfg["defaultModelSelection"] = serde_json::json!({
        "providerId": provider_id,
        "modelId": model_id,
    });
    // 原子写：临时文件 + rename
    let tmp = path.with_extension("json.agentdeck-tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&cfg).unwrap_or_default())
        .map_err(|e| format!("写入 ZCode 配置失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换 ZCode 配置失败：{e}"))?;
    Ok(())
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
    let mut command = std::process::Command::new("cmd");
    command
        .args(["/C", "opencode", "models"])
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output();
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

// ── 模型配置档案（多供应商，用户启停） ─────────────────────

/// 前端 → Rust：模型配置档案列表（只读表，不做任何自动导入）。
#[tauri::command]
fn list_model_profiles(store: State<'_, Store>) -> Result<Vec<ModelProfile>, String> {
    store.list_model_profiles(false)
}

/// 前端 → Rust：新增模型配置档案。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_model_profile(
    store: State<'_, Store>,
    provider: String,
    label: Option<String>,
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
) -> Result<ModelProfile, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let id = format!("mp-{nanos}");
    store.add_model_profile(
        &id,
        &provider,
        label.as_deref(),
        &api_key,
        base_url.as_deref(),
        model.as_deref(),
        protocol.as_deref(),
        true,
    )?;
    store
        .get_model_profile(&id)?
        .ok_or_else(|| "创建后未找到档案".into())
}

/// 前端 → Rust：编辑模型配置档案（整体覆盖，enabled 不动）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_model_profile(
    store: State<'_, Store>,
    id: String,
    provider: String,
    label: Option<String>,
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
) -> Result<ModelProfile, String> {
    store.update_model_profile(
        &id,
        &provider,
        label.as_deref(),
        &api_key,
        base_url.as_deref(),
        model.as_deref(),
        protocol.as_deref(),
    )?;
    store
        .get_model_profile(&id)?
        .ok_or_else(|| "更新后未找到档案".into())
}

/// 前端 → Rust：启停配置档案。
#[tauri::command]
fn set_model_profile_enabled(
    store: State<'_, Store>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    store.set_model_profile_enabled(&id, enabled)
}

/// 前端 → Rust：删除配置档案（级联清掉模型列表）。
#[tauri::command]
fn delete_model_profile(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_model_profile(&id)
}

/// 前端 → Rust：某供应商档案下的模型列表。
#[tauri::command]
fn list_profile_models(
    store: State<'_, Store>,
    profile_id: String,
) -> Result<Vec<ProfileModelRow>, String> {
    store.list_profile_models(&profile_id)
}

/// 前端 → Rust：向供应商档案添加一个模型（可选声明上下文窗口）。
#[tauri::command]
fn add_profile_model(
    store: State<'_, Store>,
    profile_id: String,
    model: String,
    context_window: Option<i64>,
    max_tokens: Option<i64>,
) -> Result<ProfileModelRow, String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".into());
    }
    store.add_profile_model(&profile_id, model.trim(), context_window, max_tokens)
}

/// 前端 → Rust：编辑模型行（内联保存）。
#[tauri::command]
fn update_profile_model(
    store: State<'_, Store>,
    id: String,
    model: String,
    context_window: Option<i64>,
    max_tokens: Option<i64>,
) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("模型名称不能为空".into());
    }
    store.update_profile_model(&id, model.trim(), context_window, max_tokens)
}

/// 前端 → Rust：删除模型列表中的一行。
#[tauri::command]
fn delete_profile_model(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_profile_model(&id)
}

/// 前端 → Rust：清空供应商档案的模型列表。
#[tauri::command]
fn clear_profile_models(store: State<'_, Store>, profile_id: String) -> Result<(), String> {
    store.clear_profile_models(&profile_id)
}

/// 上游倍率来源摘要（fetch_upstream_rates 返回）
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct UpstreamRatesSummary {
    /// sub2api 模型广场 | new-api pricing
    source: &'static str,
    /// 命中并落库的模型数（含新增行）
    applied: usize,
}

struct UpstreamRates {
    source: &'static str,
    rates: Vec<(String, f64)>,
}

fn upstream_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// sub2api 模型广场：GET {base}/api/v1/model-plaza（匿名可访问，带 token 显示专属倍率）。
/// 返回 模型名 → 生效倍率（user_rate_multiplier 优先于分组 rate_multiplier）。
async fn probe_sub2api_plaza(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
) -> Result<UpstreamRates, String> {
    let url = format!("{base}/api/v1/model-plaza");
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("上游返回 {}", resp.status()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    let groups = v
        .get("groups")
        .and_then(|x| x.as_array())
        .ok_or("响应缺少 groups 字段")?;
    let mut out: Vec<(String, f64)> = Vec::new();
    for g in groups {
        // 生效倍率：用户专属倍率优先，否则分组倍率
        let effective_rate = g
            .get("user_rate_multiplier")
            .and_then(|x| x.as_f64())
            .or_else(|| g.get("rate_multiplier").and_then(|x| x.as_f64()));
        let Some(default_rate) = effective_rate else {
            continue;
        };
        if let Some(models) = g.get("models").and_then(|x| x.as_array()) {
            for m in models {
                let Some(name) = m.get("name").and_then(|x| x.as_str()) else {
                    continue;
                };
                if !name.is_empty() {
                    out.push((name.trim().to_string(), default_rate));
                }
            }
        }
    }
    if out.is_empty() {
        return Err("模型广场没有返回任何模型".into());
    }
    Ok(UpstreamRates {
        source: "sub2api",
        rates: out,
    })
}

/// new-api / one-api 系价格表兜底：GET {base}/api/pricing。
async fn probe_newapi_pricing(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
) -> Result<UpstreamRates, String> {
    let url = format!("{base}/api/pricing");
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("上游返回 {}", resp.status()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    let data = v
        .get("data")
        .and_then(|x| x.as_array())
        .ok_or("响应缺少 data 字段")?;
    let mut out: Vec<(String, f64)> = Vec::new();
    for m in data {
        let Some(name) = m.get("model_name").and_then(|x| x.as_str()) else {
            continue;
        };
        // quota_type 0 = 按倍率计费；1 = 按次（model_price），两者都展示为倍率口径
        let rate = m
            .get("model_ratio")
            .and_then(|x| x.as_f64())
            .or_else(|| m.get("model_price").and_then(|x| x.as_f64()));
        if let Some(rate) = rate {
            out.push((name.trim().to_string(), rate));
        }
    }
    if out.is_empty() {
        return Err("价格表没有返回任何模型".into());
    }
    Ok(UpstreamRates {
        source: "new-api",
        rates: out,
    })
}

/// 前端 → Rust：获取上游计费倍率并落库（sub2api 模型广场优先，new-api 价格表兜底）。
/// 目录中没有的模型会作为新行插入（倍率已知、上下文窗口未知）。
#[tauri::command]
async fn fetch_upstream_rates(
    store: State<'_, Store>,
    profile_id: String,
    base_url: String,
    api_key: String,
) -> Result<UpstreamRatesSummary, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先填写并保存 Base URL".into());
    }
    let client = upstream_http_client()?;
    let upstream = match probe_sub2api_plaza(&client, &base, api_key.trim()).await {
        Ok(r) => r,
        Err(plaza_err) => match probe_newapi_pricing(&client, &base, api_key.trim()).await {
            Ok(r) => r,
            Err(_) => return Err(format!("未识别到倍率接口（{plaza_err}）")),
        },
    };
    let mut applied = 0usize;
    for (model, rate) in &upstream.rates {
        let updated = store.set_profile_model_rate(&profile_id, model, *rate)?;
        if !updated {
            store.add_profile_model(&profile_id, model, None, None)?;
            store.set_profile_model_rate(&profile_id, model, *rate)?;
        }
        applied += 1;
    }
    Ok(UpstreamRatesSummary {
        source: upstream.source,
        applied,
    })
}

/// 前端 → Rust：从上游拉取模型列表（OpenAI 兼容 GET {base}/models）。
#[tauri::command]
async fn fetch_upstream_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先填写并保存 Base URL".into());
    }
    let url = format!("{base}/models");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .bearer_auth(api_key.trim())
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("上游返回 {}", resp.status()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败：{e}"))?;
    // 兼容三种形态：{data:[{id}]} / {models:[{id}|str]} / [str]
    let mut ids: Vec<String> = Vec::new();
    let entries = v
        .get("data")
        .and_then(|x| x.as_array())
        .or_else(|| v.get("models").and_then(|x| x.as_array()))
        .or_else(|| v.as_array());
    if let Some(list) = entries {
        for item in list {
            let id = item
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| item.as_str())
                .unwrap_or_default();
            if !id.trim().is_empty() {
                ids.push(id.trim().to_string());
            }
        }
    }
    if ids.is_empty() {
        return Err("上游没有返回任何模型".into());
    }
    ids.sort();
    ids.dedup();
    ids.truncate(300);
    Ok(ids)
}

// ── 项目实体（Codex 式一等公民） ──────────────────────────

/// 前端 → Rust：创建项目（名称 + 源文件夹）。
#[tauri::command]
fn create_project(
    store: State<'_, Store>,
    name: String,
    dir: String,
) -> Result<ProjectRow, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let id = format!("prj-{nanos}");
    store.create_project(&id, &name, &dir)?;
    let all = store.list_projects()?;
    all.into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "创建后未找到".into())
}

/// 前端 → Rust：项目列表。
#[tauri::command]
fn list_projects(store: State<'_, Store>) -> Result<Vec<ProjectRow>, String> {
    store.list_projects()
}

/// 前端 → Rust：删除项目（任务保留但解除挂靠）。
#[tauri::command]
fn delete_project(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_project(&id)
}

// ── worktree 合并/放弃（任务完成后） ─────────────────────

/// 前端 → Rust：把任务分支合并回主目录，然后清理 worktree 与分支。
#[tauri::command]
fn merge_task_worktree(store: State<'_, Store>, task_id: String) -> Result<String, String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let branch = row
        .base_branch
        .ok_or_else(|| "该任务没有关联的 worktree".to_string())?;
    let main_dir = Path::new(&row.cwd)
        .ancestors()
        .find(|p| worktree::is_git_repo(p))
        .ok_or_else(|| "主目录不是 git 仓库".to_string())?
        .to_path_buf();
    let out = worktree::merge(&main_dir, &branch)?;
    worktree::remove(&main_dir, &task_id, true)?;
    store.set_task_worktree(&task_id, "", "", "")?;
    Ok(out)
}

/// 前端 → Rust：放弃任务的 worktree（不合并）。
#[tauri::command]
fn discard_task_worktree(store: State<'_, Store>, task_id: String) -> Result<(), String> {
    let row = store
        .get_task(&task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let main_dir = Path::new(&row.cwd)
        .ancestors()
        .find(|p| worktree::is_git_repo(p))
        .ok_or_else(|| "主目录不是 git 仓库".to_string())?
        .to_path_buf();
    worktree::remove(&main_dir, &task_id, true)?;
    store.set_task_worktree(&task_id, "", "", "")?;
    Ok(())
}

/// 前端 → Rust：默认工作目录。优先最近一次使用的目录，
/// 否则 AgentDeck 自己的工作区（~/AgentDeck，自动创建）——对用户透明。
#[tauri::command]
fn get_default_cwd(store: State<'_, Store>) -> String {
    // 最近一次使用的目录优先（派任务时自动记住，composer 可见）；
    // 否则透明使用 AgentDeck 自己的工作区 ~/AgentDeck（自动创建）
    store
        .get_setting("default_cwd")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            let own = dirs::home_dir()
                .map(|h| h.join("AgentDeck"))
                .expect("no home dir");
            let _ = std::fs::create_dir_all(&own);
            own.to_string_lossy().to_string()
        })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 数据库放在系统应用数据目录（%APPDATA%/com.shiyoo.agentdeck/）
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("failed to create data dir");
            let store = Store::open(&dir.join("agent-deck.db")).expect("failed to open store");
            let cleanup_root = store.get_setting("default_cwd").ok().flatten();
            app.manage(store);
            // Git maintenance must not delay window creation.
            if let Some(root) = cleanup_root {
                tauri::async_runtime::spawn_blocking(move || {
                    worktree::prune_stale(Path::new(&root))
                });
            }
            Ok(())
        })
        .manage(TaskRegistry::default())
        .manage(collaboration::CollaborationRegistry::default())
        .manage(pi_session::PiRegistry::default())
        .manage(diff_watch::DiffWatchRegistry::default())
        .invoke_handler(tauri::generate_handler![
            start_task,
            collaboration::start_collaboration,
            collaboration::cancel_collaboration,
            collaboration::list_collaborations,
            check_harness,
            cancel_task,
            delete_task,
            get_turn_artifacts,
            undo_task_file,
            open_artifact,
            delete_session,
            list_tasks,
            get_task_events,
            get_task_diff,
            run_login,
            pi_command,
            get_setting,
            set_setting,
            get_default_cwd,
            merge_task_worktree,
            discard_task_worktree,
            create_project,
            list_projects,
            delete_project,
            discover_models,
            build_smart_handoff_prompt,
            diff_watch::diff_watch_start,
            diff_watch::diff_watch_stop,
            list_model_profiles,
            add_model_profile,
            update_model_profile,
            set_model_profile_enabled,
            delete_model_profile,
            list_profile_models,
            add_profile_model,
            update_profile_model,
            delete_profile_model,
            clear_profile_models,
            fetch_upstream_models,
            fetch_upstream_rates
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
