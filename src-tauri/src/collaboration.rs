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
}

#[derive(Clone, Default)]
pub struct CollaborationRegistry(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

fn publish(app: &AppHandle, store: &Store, run: &Collaboration) -> Result<(), String> {
    store.save_collaboration(
        &run.id,
        &serde_json::to_string(run).map_err(|e| e.to_string())?,
    )?;
    let _ = app.emit("collaboration-update", run);
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
    let _ = pi_session::send_command(&app.state::<pi_session::PiRegistry>(), id, "abort", None);
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
pub async fn start_collaboration(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, CollaborationRegistry>,
    source_task_id: String,
    mentor: String,
    worker: String,
    max_rounds: u32,
) -> Result<Collaboration, String> {
    let mentor = mentor.to_ascii_lowercase();
    let worker = worker.to_ascii_lowercase();
    validate_pair(&mentor, &worker, max_rounds)?;
    let source = store.get_task(&source_task_id)?.ok_or("源任务不存在")?;
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
        } else if which::which(Harness::parse(harness)?.program()).is_err() {
            return Err(format!("未找到 {harness}，请先安装并登录"));
        }
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
    };
    publish(&app, &store, &run)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    active.insert(run.id.clone(), cancelled.clone());
    drop(active);
    let initial = run.clone();
    let store = store.clone_handle();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut run = run;
        let result = run_flow(&app, &store, &mut run, &cancelled).await;
        if cancelled.load(Ordering::SeqCst) {
            run.status = "cancelled".into();
        } else if let Err(error) = result {
            run.status = "failed".into();
            run.error = Some(error);
        }
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
    let task = crate::start_task_impl(
        app.clone(),
        app.state::<TaskRegistry>(),
        app.state::<Store>(),
        app.state::<pi_session::PiRegistry>(),
        harness.into(),
        source.cwd,
        prompt,
        Some(mode.into()),
        None,
        Some("auto".into()),
        None,
        Some(run.source_task_id.clone()),
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
    loop {
        if cancelled.load(Ordering::SeqCst) {
            cancel_child(app, &task.task_id);
        }
        let row = store.get_task(&task.task_id)?.ok_or("阶段任务已被删除")?;
        if row.status != "running" {
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
    let events = crate::conversation_events(store, &source.id)?
        .into_iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>();
    let context = handoff::convo_tail(&handoff::render_conversation(&events), 24_000);
    let mentor = run.mentor.clone();
    let worker = run.worker.clone();
    let mentor_mode = if mentor == "codex" {
        "readonly"
    } else {
        "plan"
    };
    let worker_mode = if worker == "codex" { "write" } else { "build" };
    let goal = format!(
        "原始任务：{}\n会话记录（可能截断，须核对实际文件）：\n{context}",
        source.prompt
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
                "你是执行方，由 {mentor} 指导。只在当前目录工作，保留已有改动，不再委派。\n\
             按指导实施并验证；遇到冲突说明原因，报告修改文件、测试结果和未完成项。\n\
             {goal}\n指导/返工要求：\n{instructions}"
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
}
