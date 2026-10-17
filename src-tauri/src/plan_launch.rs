//! Confirmed plans must release their waiting planner before acquiring its workspace.
use crate::{Store, TaskRegistry, execution, orchestration, pi_session};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Default)]
pub struct PlanLaunchRegistry(Arc<Mutex<HashSet<String>>>);
struct LaunchGuard(PlanLaunchRegistry, String);
impl Drop for LaunchGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.0.lock() {
            active.remove(&self.1);
        }
    }
}

#[derive(Deserialize)]
struct Plan {
    nodes: Vec<orchestration::NodeSpec>,
    parallel: usize,
    minutes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PlanOutcome {
    pub kind: String,
    pub task_id: Option<String>,
    pub run: Option<orchestration::GraphRun>,
}

fn pending_plan(events: &[String], approval_id: &str) -> Result<Plan, String> {
    let mut pending = None;
    for raw in events {
        let event: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        if event["type"] == "deck_approval_request" {
            pending = if event["id"] == approval_id && event["tool"] == "propose_collaboration" {
                Some(event["args"]["__plan"].clone())
            } else {
                None
            };
        }
        if event["type"] == "deck_approval_decided" && event["id"] == approval_id {
            pending = None;
        }
    }
    serde_json::from_value(pending.ok_or("协作计划审批已失效，请重新生成计划")?)
        .map_err(|e| format!("协作计划无效：{e}"))
}

fn verify_nodes(plan: &Plan, nodes: &[orchestration::NodeSpec]) -> Result<(), String> {
    // The UI may select concrete models, but confirmation must not rewrite the approved work.
    if plan.nodes.len() != nodes.len() {
        return Err("协作计划节点已变化".into());
    }
    for (expected, actual) in plan.nodes.iter().zip(nodes) {
        let mut expected = serde_json::to_value(expected).map_err(|e| e.to_string())?;
        let mut actual = serde_json::to_value(actual).map_err(|e| e.to_string())?;
        for node in [&mut expected, &mut actual] {
            node.as_object_mut().unwrap().remove("execution");
            if let Some(s) = node["supervision"].as_object_mut() {
                s.remove("execution");
            }
        }
        if expected != actual {
            return Err("协作计划任务、权限或依赖已变化，请重新确认计划".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_approved_plan(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, PlanLaunchRegistry>,
    task_id: String,
    approval_id: String,
    nodes: Vec<orchestration::NodeSpec>,
) -> Result<PlanOutcome, String> {
    start_approved_plan_impl(app, store, registry, task_id, approval_id, nodes, None).await
}

pub(crate) async fn start_approved_plan_impl(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, PlanLaunchRegistry>,
    task_id: String,
    approval_id: String,
    nodes: Vec<orchestration::NodeSpec>,
    reservation: Option<crate::store::ConversationLaunch>,
) -> Result<PlanOutcome, String> {
    {
        let mut active = registry.0.lock().map_err(|_| "plan registry poisoned")?;
        if !active.insert(task_id.clone()) {
            return Err("该计划正在交接，请勿重复启动".into());
        }
    }
    let _guard = LaunchGuard(registry.inner().clone(), task_id.clone());
    let source = store.get_task(&task_id)?.ok_or("规划任务已删除")?;
    let events = store.get_events(&task_id, 0, i64::MAX)?;
    for raw in &events {
        let event: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        if event["type"] == "collaboration_plan_started" && event["approval_id"] == approval_id {
            return serde_json::from_value(event["result"].clone()).map_err(|e| e.to_string());
        }
    }
    // Recover a launch whose process started before the acknowledgement was
    // persisted. Refuse to dispatch another executor for the same proposal.
    let launched = store.list_graph_runs_for_request(&task_id)?;
    if let Some(run) = launched.into_iter().next() {
        return Ok(PlanOutcome {
            kind: "graph".into(),
            task_id: None,
            run: Some(run),
        });
    }
    let ambiguous_launch = events.iter().any(|raw| {
        serde_json::from_str::<Value>(raw)
            .ok()
            .is_some_and(|v| v["type"] == "plan_launch_intent" && v["approval_id"] == approval_id)
    }) && !events.iter().any(|raw| {
        serde_json::from_str::<Value>(raw)
            .ok()
            .is_some_and(|v| v["type"] == "plan_launch_failed" && v["approval_id"] == approval_id)
    });
    if ambiguous_launch {
        return Err("上次交接在启动期间中断，请核对执行记录；为避免重复执行，未再次派发".into());
    }
    let semantic = events.iter().any(|raw| {
        serde_json::from_str::<Value>(raw)
            .ok()
            .is_some_and(|v| v["planning"] == true || v["args"]["__workflow"] == true)
    });
    let handed_off = events.iter().any(|raw| {
        serde_json::from_str::<Value>(raw)
            .ok()
            .is_some_and(|v| v["type"] == "workflow_handoff_stopped")
    });
    let planner_stopped = events.iter().any(|raw| {
        serde_json::from_str::<Value>(raw)
            .ok()
            .is_some_and(|v| v["type"] == "plan_planner_stopped" && v["approval_id"] == approval_id)
    });
    if (!semantic
        && (source.harness != "deck"
            || !(source.status == "running" || (source.status == "cancelled" && planner_stopped))))
        || (semantic && source.status != "done" && !(handed_off && source.status == "cancelled"))
    {
        return Err("规划执行者已结束，请重新生成计划".into());
    }
    let plan = pending_plan(&store.get_events(&task_id, 0, i64::MAX)?, &approval_id)?;
    if semantic && crate::workflow::superseded(&store, &task_id)? {
        return Err("用户已发送新要求，旧计划已失效，请使用最新计划".into());
    }
    verify_nodes(&plan, &nodes)?;
    orchestration::validate(&nodes, plan.parallel, plan.minutes.saturating_mul(60))?;
    crate::workflow::validate_budget(
        &store,
        nodes.len(),
        plan.parallel,
        plan.minutes.saturating_mul(60),
    )?;
    let restricted = crate::workflow::readonly_mode(source.mode.as_deref());
    if restricted && nodes.iter().any(|n| !n.read_only) {
        return Err("源会话权限受限，只能派发只读协作者".into());
    }
    execution::initialize(&app);
    let cid = store.ensure_conversation(&task_id)?;
    // All launch/delete entry points share this reservation, including ordinary sends.
    // Keep ownership through shutdown and transfer it into the actual launch.
    let reservation = match reservation {
        Some(guard) => guard,
        None => store.claim_conversation_mutation(&cid)?,
    };
    let policy = store.context_policy(&task_id)?;
    for node in &nodes {
        let targets = std::iter::once((
            &node.harness,
            &node.execution,
            node.contract.model_hint.clone(),
        ))
        .chain(
            node.supervision
                .as_ref()
                .map(|s| (&s.commander, &s.execution, s.model_hint.clone())),
        );
        for (harness, config, hint) in targets {
            policy.authorize(harness)?;
            if harness != "deck"
                && crate::discovery::locate(crate::executors::Harness::parse(harness)?).is_none()
            {
                return Err(format!("未安装 {harness}"));
            }
            let copy = store.clone_handle();
            let cid = cid.clone();
            let harness = harness.clone();
            let config = config.clone();
            tokio::task::spawn_blocking(move || {
                crate::workflow::verify_binding(&copy, &harness, &config, hint.as_deref())?;
                execution::resolve(&copy, Some(&cid), &harness, &config)
            })
            .await
            .map_err(|e| e.to_string())??;
        }
    }
    let direct = nodes.len() == 1
        && nodes[0].supervision.is_none()
        && nodes[0].contract.workspace == crate::workflow_artifacts::WorkspaceKind::Git
        && !nodes[0].contract.acceptance;
    if !direct {
        let root = store.get_task(&cid)?.ok_or("会话根任务不存在")?;
        if crate::workflow::readonly_mode(root.mode.as_deref())
            && nodes.iter().any(|n| !n.read_only)
        {
            return Err("源会话权限受限，只能派发只读协作者".into());
        }
        let cwd = std::path::PathBuf::from(&root.cwd);
        let artifacts =
            nodes[0].contract.workspace == crate::workflow_artifacts::WorkspaceKind::Artifacts;
        tokio::task::spawn_blocking(move || {
            if artifacts {
                Ok(String::new())
            } else {
                orchestration::graph_baseline(&cwd)
            }
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    // Resolve approval by handing over, not by telling the planner execution has already started.
    if !semantic && source.status == "running" {
        store.append_event(
            &task_id,
            &json!({"type":"plan_planner_stopped","approval_id":approval_id}).to_string(),
        )?;
        pi_session::send_command(
            &app.state::<pi_session::PiRegistry>(),
            &task_id,
            "abort",
            None,
            None,
        )?;
    }
    // Keep the proposal pending until a real task/graph was launched. Failed
    // preflight or launch remains retryable and cannot consume the approval.
    crate::await_stopped(&store, std::slice::from_ref(&task_id))
        .await
        .map_err(|_| "规划执行者尚未确认停止，未启动执行任务，请稍后重新安排".to_string())?;
    store
        .await_workspace_released(&source.cwd, std::time::Duration::from_secs(10))
        .await?;
    let result = if direct {
        store.append_event(
            &task_id,
            &json!({"type":"plan_launch_intent","approval_id":approval_id}).to_string(),
        )?;
        let node = nodes.into_iter().next().unwrap();
        let mode = if node.read_only {
            if node.harness == "codex" {
                "readonly"
            } else {
                "plan"
            }
        } else {
            match node.harness.as_str() {
                "codex" => "write",
                "deck" => "auto",
                _ => "build",
            }
        };
        let task = crate::start_task_impl(
            app.clone(),
            app.state::<TaskRegistry>(),
            app.state::<Store>(),
            app.state::<pi_session::PiRegistry>(),
            node.harness,
            source.cwd,
            node.prompt,
            Some(mode.into()),
            node.execution.model,
            Some("auto".into()),
            None,
            source.project_id,
            Some(cid),
            Some(true),
            Vec::new(),
            None,
            None,
            node.execution.effort,
            None,
            None,
            Some(reservation),
            None,
        )
        .await
        .inspect_err(|_error| {
            let _ = store.append_event(
                &task_id,
                &json!({"type":"plan_launch_failed","approval_id":approval_id}).to_string(),
            );
        })?;
        PlanOutcome {
            kind: "task".into(),
            task_id: Some(task.task_id),
            run: None,
        }
    } else {
        let run = orchestration::start_graph_run_reserved(
            app.clone(),
            app.state::<Store>(),
            app.state::<orchestration::GraphRegistry>(),
            task_id.clone(),
            nodes,
            plan.parallel,
            plan.minutes * 60,
            Some(reservation),
        )
        .await?;
        PlanOutcome {
            kind: "graph".into(),
            task_id: None,
            run: Some(run),
        }
    };
    store.append_event(
        &task_id,
        &json!({
            "type":"deck_approval_decided","id":approval_id,"approved":true,"handoff":true
        })
        .to_string(),
    )?;
    store.append_event(
        &task_id,
        &json!({
            "type": "collaboration_plan_started", "approval_id":approval_id, "result": result
        })
        .to_string(),
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn events() -> Vec<String> {
        vec![
            json!({"type":"deck_approval_request","id":"approval","tool":"propose_collaboration",
            "args":{"__plan":{"parallel":2,"minutes":15,"nodes":[{
                "id":"cleanup","harness":"opencode","prompt":"Inspect sandbox","dependencies":[],
                "read_only":true
            }]}}})
            .to_string(),
        ]
    }
    #[test]
    fn only_pending_collaboration_approvals_can_launch_and_models_can_be_selected() {
        let mut events = events();
        let plan = pending_plan(&events, "approval").unwrap();
        let mut nodes = plan.nodes.clone();
        nodes[0].execution.model = Some("provider/model:free".into());
        assert!(verify_nodes(&plan, &nodes).is_ok());
        nodes[0].read_only = false;
        assert!(verify_nodes(&plan, &nodes).is_err());
        assert!(pending_plan(&events, "other").is_err());
        events.push(json!({"type":"deck_approval_decided","id":"approval"}).to_string());
        assert!(pending_plan(&events, "approval").is_err());
    }
}
