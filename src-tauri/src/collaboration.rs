use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{Store, TaskRegistry, executors::Harness, handoff, pi_session};

fn same_directory(left: &str, right: &str) -> Result<bool, String> {
    let left = std::fs::canonicalize(left).map_err(|e| format!("工作目录不可用：{e}"))?;
    let right = std::fs::canonicalize(right).map_err(|e| format!("工作目录不可用：{e}"))?;
    #[cfg(windows)]
    {
        Ok(left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy()))
    }
    #[cfg(not(windows))]
    {
        Ok(left == right)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collaboration {
    pub id: String,
    pub source_task_id: String,
    pub mentor: String,
    pub worker: String,
    pub status: String,
    pub phase: String,
    pub round: u32,
    pub max_rounds: u32,
    pub current_task_id: Option<String>,
    pub task_ids: Vec<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default = "default_timeout")]
    pub phase_timeout_secs: u64,
    #[serde(default)]
    pub execution: PhaseExecution,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PhaseExecution {
    #[serde(default)]
    pub planning: crate::execution::ExecutionConfig,
    #[serde(default)]
    pub executing: crate::execution::ExecutionConfig,
    #[serde(default)]
    pub reviewing: crate::execution::ExecutionConfig,
}

fn default_timeout() -> u64 {
    900
}
fn restricted_mode(mode: Option<&str>) -> bool {
    mode.is_some_and(|mode| !matches!(mode, "" | "auto" | "default" | "full" | "yolo"))
}

#[derive(Clone, Default)]
pub struct CollaborationRegistry(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

fn publish(app: &AppHandle, store: &Store, run: &Collaboration) -> Result<(), String> {
    if store.get_task(&run.source_task_id)?.is_none() {
        return Err("源会话已删除".into());
    }
    store.save_collaboration(
        &run.id,
        &serde_json::to_string(run).map_err(|e| e.to_string())?,
    )?;
    let _ = app.emit("collaboration-update", run);
    Ok(())
}

pub(crate) fn stop_for_tasks(app: &AppHandle, store: &Store, ids: &[String]) -> Result<(), String> {
    crate::orchestration::stop_for_tasks(app, store, ids)?;
    let registry = app.state::<CollaborationRegistry>();
    for raw in store.list_collaborations()? {
        let run: Collaboration = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if ids.contains(&run.source_task_id) || run.task_ids.iter().any(|id| ids.contains(id)) {
            if let Some(cancelled) = registry
                .0
                .lock()
                .map_err(|_| "collaboration registry poisoned")?
                .get(&run.id)
            {
                cancelled.store(true, Ordering::SeqCst);
            }
            if let Some(id) = run.current_task_id {
                cancel_child(app, &id);
            }
        }
    }
    Ok(())
}

pub fn validate_pair(mentor: &str, worker: &str, max_rounds: u32) -> Result<(), String> {
    if mentor != "deck" {
        Harness::parse(mentor)?;
    }
    if worker != "deck" {
        Harness::parse(worker)?;
    }
    if mentor == worker {
        return Err("指导方和执行方必须不同".into());
    }
    if !(1..=3).contains(&max_rounds) {
        return Err("执行轮数必须在 1 到 3 之间".into());
    }
    Ok(())
}

pub fn review_approved(text: &str) -> bool {
    // Only a standalone protocol record is a verdict, never a quoted example.
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| {
            serde_json::from_str::<serde_json::Value>(line.trim())
                .ok()
                .is_some_and(|v| {
                    v.get("agent_deck_verdict").and_then(|v| v.as_str()) == Some("approved")
                })
        })
}

fn cancel_child(app: &AppHandle, id: &str) {
    let _ = crate::cancel_task(app.state::<TaskRegistry>(), id.to_string());
    let _ = pi_session::send_command(
        &app.state::<pi_session::PiRegistry>(),
        id,
        "abort",
        None,
        None,
    );
}

#[tauri::command]
pub fn list_collaborations(store: State<'_, Store>) -> Result<Vec<Collaboration>, String> {
    store
        .list_collaborations()?
        .into_iter()
        .map(|raw| serde_json::from_str(&raw).map_err(|e| format!("协作记录损坏：{e}")))
        .collect()
}

#[tauri::command]
pub fn cancel_collaboration(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, CollaborationRegistry>,
    id: String,
) -> Result<(), String> {
    let cancelled = registry
        .0
        .lock()
        .map_err(|_| "collaboration registry poisoned")?
        .get(&id)
        .cloned()
        .ok_or("协作已结束或已中断")?;
    cancelled.store(true, Ordering::SeqCst);
    if let Some(raw) = store.get_collaboration(&id)? {
        let run: Collaboration = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if let Some(task_id) = run.current_task_id {
            cancel_child(&app, &task_id);
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_collaboration(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, CollaborationRegistry>,
    source_task_id: String,
    mentor: String,
    worker: String,
    max_rounds: u32,
    read_only: Option<bool>,
    phase_timeout_secs: Option<u64>,
    execution: Option<PhaseExecution>,
) -> Result<Collaboration, String> {
    let mentor = mentor.to_ascii_lowercase();
    let worker = worker.to_ascii_lowercase();
    validate_pair(&mentor, &worker, max_rounds)?;
    let source = store.get_task(&source_task_id)?.ok_or("源任务不存在")?;
    let phase_timeout_secs = phase_timeout_secs.unwrap_or_else(default_timeout);
    if !(60..=3600).contains(&phase_timeout_secs) {
        return Err("阶段时限必须在 60 到 3600 秒之间".into());
    }
    if source.status == "running" {
        return Err("请先等待源任务结束或停止源任务".into());
    }
    if !std::path::Path::new(&source.cwd).is_dir() {
        return Err("原任务工作目录不存在".into());
    }
    for harness in [&mentor, &worker] {
        if harness == "deck" {
            if which::which("node").is_err() {
                return Err("未找到 Node.js，无法运行 AgentDeck Agent".into());
            }
        } else if crate::discovery::locate(Harness::parse(harness)?).is_none() {
            return Err(format!("未找到 {harness}，请先安装并登录"));
        }
    }
    let conversation_id = store.ensure_conversation(&source_task_id)?;
    let execution = execution.unwrap_or_default();
    crate::execution::initialize(&app);
    for (harness, config) in [
        (&mentor, &execution.planning),
        (&worker, &execution.executing),
        (&mentor, &execution.reviewing),
    ] {
        let copy = store.clone_handle();
        let cid = conversation_id.clone();
        let harness = harness.clone();
        let config = config.clone();
        tokio::task::spawn_blocking(move || {
            crate::execution::resolve(&copy, Some(&cid), &harness, &config)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let mut active = registry
        .0
        .lock()
        .map_err(|_| "collaboration registry poisoned")?;
    for raw in store.list_collaborations()? {
        let previous: Collaboration = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if previous.status == "running" {
            let previous_source = store
                .get_task(&previous.source_task_id)?
                .ok_or("源任务不存在")?;
            if same_directory(&source.cwd, &previous_source.cwd)? {
                return Err("该工作目录已有协作运行中".into());
            }
        }
    }
    let run = Collaboration {
        id: format!("collab-{}", crate::pi_session_task_id()),
        source_task_id,
        mentor,
        worker,
        status: "running".into(),
        phase: "planning".into(),
        round: 0,
        max_rounds,
        current_task_id: None,
        task_ids: Vec::new(),
        error: None,
        conversation_id: Some(conversation_id),
        read_only: read_only.unwrap_or(false) || restricted_mode(source.mode.as_deref()),
        phase_timeout_secs,
        execution,
    };
    let workspace = store.claim_workspace(&source.cwd, &run.id)?;
    publish(&app, &store, &run)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    active.insert(run.id.clone(), cancelled.clone());
    drop(active);
    let initial = run.clone();
    let store = store.clone_handle();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _workspace = workspace;
        let mut run = run;
        let result = run_flow(&app, &store, &mut run, &cancelled).await;
        if cancelled.load(Ordering::SeqCst) {
            run.status = "cancelled".into();
        } else if let Err(error) = result {
            run.status = "failed".into();
            run.error = Some(error);
        }
        run.current_task_id = None;
        let _ = publish(&app, &store, &run);
        if let Ok(mut active) = registry.0.lock() {
            active.remove(&run.id);
        }
    });
    Ok(initial)
}

async fn stage(
    app: &AppHandle,
    store: &Store,
    run: &mut Collaboration,
    cancelled: &AtomicBool,
    harness: &str,
    mode: &str,
    prompt: String,
) -> Result<String, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("协作已停止".into());
    }
    let source = store
        .get_task(&run.source_task_id)?
        .ok_or("源任务已被删除")?;
    let initial = match run.phase.as_str() {
        "planning" => &run.execution.planning,
        "executing" => &run.execution.executing,
        _ => &run.execution.reviewing,
    };
    let config = initial.clone();
    let task = crate::start_task_impl(
        app.clone(),
        app.state::<TaskRegistry>(),
        app.state::<Store>(),
        app.state::<pi_session::PiRegistry>(),
        harness.into(),
        source.cwd,
        prompt,
        Some(mode.into()),
        config.model,
        Some("auto".into()),
        None,
        source.project_id,
        Some(source.conversation_id.unwrap_or_else(|| source.id.clone())),
        Some(true),
        Vec::new(),
        Some(run.id.clone()),
        None,
        config.effort,
        Some(run.phase.clone()),
        None,
        None,
    )
    .await?;
    run.current_task_id = Some(task.task_id.clone());
    run.task_ids.push(task.task_id.clone());
    if let Err(error) = publish(app, store, run) {
        cancel_child(app, &task.task_id);
        return Err(error);
    }
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(run.phase_timeout_secs);
    let mut stopped_at = None;
    let mut timed_out = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            timed_out = true;
        }
        if cancelled.load(Ordering::SeqCst) || timed_out {
            cancel_child(app, &task.task_id);
            let stopped = stopped_at.get_or_insert_with(tokio::time::Instant::now);
            if stopped.elapsed() >= std::time::Duration::from_secs(10) {
                return Err(
                    "阶段未在取消时限内结束；工作目录仍由运行任务阻止派发，请检查执行者".into(),
                );
            }
        }
        let row = store.get_task(&task.task_id)?.ok_or("阶段任务已被删除")?;
        if row.status != "running" {
            if timed_out {
                return Err(format!(
                    "{} 阶段超过 {} 秒时限",
                    run.phase, run.phase_timeout_secs
                ));
            }
            if cancelled.load(Ordering::SeqCst) {
                return Err("协作已停止".into());
            }
            if row.status != "done" {
                return Err(format!(
                    "{} 阶段 {}：{}",
                    run.phase, row.status, task.task_id
                ));
            }
            let events = store.get_events(&task.task_id, 0, i64::MAX)?;
            let text = handoff::assistant_text(&events);
            if text.trim().is_empty() {
                return Err(format!("{} 未返回有效回复", run.phase));
            }
            return Ok(text);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn run_flow(
    app: &AppHandle,
    store: &Store,
    run: &mut Collaboration,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let source = store.get_task(&run.source_task_id)?.ok_or("源任务不存在")?;
    let mut turns = store.session_tasks(&source.id)?;
    turns.sort_by(crate::conversation::turn_order);
    let mut latest_request = source.prompt.clone();
    for turn in turns {
        for event in store.get_events(&turn.id, 0, i64::MAX)? {
            let event: serde_json::Value =
                serde_json::from_str(&event).map_err(|e| e.to_string())?;
            if event["type"] == "user_message" && event["hidden"] != true {
                if let Some(text) = event["text"].as_str() {
                    latest_request = text.into();
                }
            }
        }
    }
    let mentor = run.mentor.clone();
    let worker = run.worker.clone();
    let mentor_mode = if mentor == "codex" {
        "readonly"
    } else {
        "plan"
    };
    let worker_mode = if run.read_only {
        if worker == "codex" {
            "readonly"
        } else {
            "plan"
        }
    } else if worker == "codex" {
        "write"
    } else {
        "build"
    };
    let goal = format!(
        "用户最新要求：{latest_request}\n历史由 AgentDeck 另行同步；最新要求与共享任务约束优先，不重放旧工具调用。"
    );
    let plan = stage(
        app,
        store,
        run,
        cancelled,
        &mentor,
        mentor_mode,
        format!(
            "你是 {worker} 的指导方。只检查文件，不修改文件，不委派其他智能体。\n\
         根据任务和工作目录现状，给出明确的实施步骤、边界、风险和可执行验收标准。\n{goal}"
        ),
    )
    .await?;
    let mut instructions = plan.clone();
    for round in 1..=run.max_rounds {
        run.round = round;
        run.phase = "executing".into();
        let result = stage(
            app,
            store,
            run,
            cancelled,
            &worker,
            worker_mode,
            format!(
                "你是执行方，由 {mentor} 指导。只在当前目录工作，保留已有改动，不再委派。{}\n\
             按指导实施并验证；遇到冲突说明原因，报告修改文件、测试结果和未完成项。\n\
             {goal}\n指导/返工要求：\n{instructions}",
                if run.read_only {
                    "本流程只读；只提交分析和实施建议，不修改文件。"
                } else {
                    ""
                }
            ),
        )
        .await?;
        run.phase = "reviewing".into();
        let review = stage(app, store, run, cancelled, &mentor, mentor_mode, format!(
            "你是 {worker} 的验收方。只检查文件，不修改、不委派。核对实际 diff 和验收证据，\
             不要仅相信执行方自述。缺少证据时要求返工。\n{goal}\n原指导：\n{plan}\n\
             本轮要求：\n{instructions}\n执行报告：\n{result}\n\
             给出验收结论和具体返工项。最后一行必须是单独的 JSON：\
             {{\"agent_deck_verdict\":\"approved\"}} 或 {{\"agent_deck_verdict\":\"changes_requested\"}}。"
        )).await?;
        if review_approved(&review) {
            run.status = "done".into();
            return Ok(());
        }
        instructions = review;
    }
    run.status = "needs_attention".into();
    run.error = Some("达到执行轮数上限，尚未通过指导方验收".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_six_directions_are_supported() {
        for mentor in ["codex", "zcode", "opencode"] {
            for worker in ["codex", "zcode", "opencode"] {
                assert_eq!(validate_pair(mentor, worker, 2).is_ok(), mentor != worker);
            }
        }
        assert!(validate_pair("unknown", "codex", 2).is_err());
        assert!(validate_pair("zcode", "codex", 0).is_err());
        assert!(validate_pair("zcode", "codex", 4).is_err());
    }

    #[test]
    fn review_requires_final_structured_verdict() {
        assert!(review_approved(
            "Verified\n{\"agent_deck_verdict\":\"approved\"}\n"
        ));
        assert!(!review_approved("approved"));
        assert!(!review_approved(
            "Example: {\"agent_deck_verdict\":\"approved\"}"
        ));
        assert!(!review_approved(
            "{\"agent_deck_verdict\":\"approved\"}\nNeeds changes"
        ));
        assert!(!review_approved(
            "{\"agent_deck_verdict\":\"changes_requested\"}"
        ));
    }

    #[test]
    fn old_workflows_keep_safe_timeout_defaults_and_restrictions_are_not_elevated() {
        let run: Collaboration = serde_json::from_value(serde_json::json!({
            "id":"flow","source_task_id":"a","mentor":"codex","worker":"zcode",
            "status":"done","phase":"reviewing","round":1,"max_rounds":2,
            "current_task_id":null,"task_ids":[],"error":null
        }))
        .unwrap();
        assert_eq!(run.phase_timeout_secs, 900);
        assert!(restricted_mode(Some("approved")));
        assert!(restricted_mode(Some("readonly")));
        assert!(restricted_mode(Some("write")));
        assert!(!restricted_mode(Some("yolo")));
        assert!(!restricted_mode(Some("full")));
    }
}
