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
use crate::store::{ModelProfile, ProjectRow, Store, TaskRow};

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
/// command-group 的进程组子进程：start_kill 会终止整棵进程树
/// （cmd /C → node → CLI），杜绝 Windows 上的孤儿进程烧额度。
pub struct RunningTask {
    pub label: String,
    pub child: Option<command_group::AsyncGroupChild>,
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
) -> Result<TaskStartInfo, String> {
    // deck = AgentDeck 自有运行时（pi sidecar），走独立通道
    if harness.eq_ignore_ascii_case("deck") {
        let task_id = pi_session_task_id();
        let deck_project = store.find_project_by_dir(&cwd).ok().flatten().map(|p| p.id);
        store.create_task(
            &task_id,
            "deck",
            &cwd,
            &prompt,
            mode.as_deref(),
            None,
            deck_project.as_deref(),
        )?;
        // 模型池：启用的配置档案按创建顺序构成自治链（sidecar 内自动降级）
        let profiles: Vec<pi_session::ModelProfileParam> = store
            .list_model_profiles(true)?
            .into_iter()
            .map(|p| pi_session::ModelProfileParam {
                provider: p.provider,
                key: p.api_key,
                base_url: p.base_url,
            })
            .collect();
        let use_cwd_deck = cwd.clone();
        let task_memories = store.list_memories(&cwd, 20).unwrap_or_default();
        let params = pi_session::PiRunParams {
            prompt,
            model: "auto".into(),
            cwd: use_cwd_deck,
            profiles,
            memories: task_memories,
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

    // git 仓库内派发的任务：自动 worktree 隔离（改动圈在任务分支里）
    let mut worktree: Option<WorktreePaths> = None;
    if harness.name() != "deck"
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
    if let Some(w) = &worktree {
        store.set_task_worktree(
            &task_id,
            &w.branch,
            &w.base_commit,
            &w.dir.to_string_lossy(),
        )?;
    }

    let cli_project = store
        .find_project_by_dir(&task_cwd)
        .ok()
        .flatten()
        .map(|p| p.id);
    store.create_task(
        &task_id,
        harness.name(),
        &task_cwd,
        &prompt,
        mode.as_deref(),
        model.as_deref(),
        cli_project.as_deref(),
    )?;

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
    let events = store.get_events(&task_id, 0, i64::MAX)?;
    let convo = handoff::render_conversation(&events);

    // 无会话记录：不是压缩失败，直接组装「仅任务原话」的交接
    let summary_note = if convo.trim().is_empty() {
        String::from("（该任务无对话记录。请直接执行下方的原始任务。）")
    } else {
        // 压缩模型与 key：优先 GLM，退 GPT（来自设置面板）
        let profiles = store.list_model_profiles(true)?;
        let profile = profiles
            .iter()
            .find(|p| p.provider == "glm")
            .or(profiles.first())
            .ok_or("未配置任何启用的模型档案——请到设置面板添加并启用")?;

        let sidecar = sidecar_path(&app);
        match tokio::time::timeout(
            std::time::Duration::from_secs(90),
            pi_session::pi_summarize_text(
                &sidecar,
                &profile.provider,
                &profile.api_key,
                profile.base_url.as_deref(),
                &row.cwd,
                &convo,
            ),
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

/// 本机发现的可复用凭据（避免用户重复配 key）
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DiscoveredCredential {
    /// glm | gpt
    pub target: String,
    /// 来源描述（如 "opencode（zhipuai-coding-plan）"）
    pub source: String,
    pub key: String,
}

/// 前端 → Rust：扫描本机可复用的明文凭据。
/// ZCode 的 credentials.json 是机器绑定加密存储（enc: 前缀）读不了；
/// opencode 的 auth.json 是明文，ZCode 登录用户的 coding-plan key 就在里面。
fn discover_credentials_inner() -> Vec<DiscoveredCredential> {
    let mut out: Vec<DiscoveredCredential> = Vec::new();
    let mut push = |target: &str, source: &str, key: &str| {
        if !key.trim().is_empty()
            && !key.starts_with("enc:")
            && !out.iter().any(|c| c.target == target)
        {
            out.push(DiscoveredCredential {
                target: target.to_string(),
                source: source.to_string(),
                key: key.trim().to_string(),
            });
        }
    };

    if let Some(home) = dirs::home_dir() {
        let path = home
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json");
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
            && let Some(map) = v.as_object()
        {
            for (provider, entry) in map {
                let key = entry
                    .get("key")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default();
                let lower = provider.to_lowercase();
                if lower.contains("zhipuai") || lower.contains("zai") {
                    push("glm", &format!("opencode（{provider}）"), key);
                } else if lower.contains("openai") {
                    push("gpt", &format!("opencode（{provider}）"), key);
                }
            }
        }
    }
    if let Ok(k) = std::env::var("ZAI_API_KEY") {
        push("glm", "环境变量 ZAI_API_KEY", &k);
    }
    if let Ok(k) = std::env::var("OPENAI_API_KEY") {
        push("gpt", "环境变量 OPENAI_API_KEY", &k);
    }
    out
}

// ── 模型配置档案（多供应商，用户启停） ─────────────────────

/// 前端 → Rust：模型配置档案列表（空表时自动从本机凭据种子导入）。
#[tauri::command]
fn list_model_profiles(store: State<'_, Store>) -> Result<Vec<ModelProfile>, String> {
    let profiles = store.list_model_profiles(false)?;
    if !profiles.is_empty() {
        return Ok(profiles);
    }
    // 自动种子：本机可发现的凭据 → 启用档案（opencode 登录的 key 等）
    let base = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    for (i, c) in discover_credentials_inner().into_iter().enumerate() {
        store.add_model_profile(
            &format!("mp-{}-{i}", base),
            &c.target,
            Some(&format!("自动导入 · {}", c.source)),
            &c.key,
            None,
            true,
        )?;
    }
    store.list_model_profiles(false)
}

/// 前端 → Rust：新增模型配置档案。
#[tauri::command]
fn add_model_profile(
    store: State<'_, Store>,
    provider: String,
    label: Option<String>,
    api_key: String,
    base_url: Option<String>,
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
        true,
    )?;
    store
        .get_model_profile(&id)?
        .ok_or_else(|| "创建后未找到档案".into())
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

/// 前端 → Rust：删除配置档案。
#[tauri::command]
fn delete_model_profile(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete_model_profile(&id)
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
            // 清理 git worktree 残留登记（用户手动删目录后的元数据）
            if let Some(root) = store.get_setting("default_cwd").ok().flatten() {
                worktree::prune_stale(Path::new(&root));
            }
            app.manage(store);
            Ok(())
        })
        .manage(TaskRegistry::default())
        .manage(pi_session::PiRegistry::default())
        .manage(diff_watch::DiffWatchRegistry::default())
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
            set_model_profile_enabled,
            delete_model_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
