//! Bounded DAG execution: isolated branches, immutable patches, explicit integration.
use crate::{Store, TaskRegistry, executors::Harness, pi_session};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeSpec {
    pub id: String,
    pub harness: String,
    pub prompt: String,
    pub dependencies: Vec<String>,
    pub read_only: bool,
    #[serde(default)]
    pub execution: crate::execution::ExecutionConfig,
    #[serde(default)]
    pub supervision: Option<Supervision>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Supervision {
    pub commander: String,
    pub max_rounds: u32,
    #[serde(default)]
    pub execution: crate::execution::ExecutionConfig,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StageRecord {
    pub phase: String,
    pub round: u32,
    pub harness: String,
    pub task_id: String,
    pub report: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub spec: NodeSpec,
    pub status: String,
    pub task_id: Option<String>,
    pub worktree: Option<String>,
    pub baseline_tree: Option<String>,
    pub patch_path: Option<String>,
    pub patch_hash: Option<String>,
    pub report: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub history: Vec<StageRecord>,
}
impl Node {
    fn harness(&self) -> &str {
        match (&self.spec.supervision, self.phase.as_str()) {
            (Some(s), "planning" | "reviewing") => &s.commander,
            _ => &self.spec.harness,
        }
    }
    // A successful process exit is only a stage result; the commander owns acceptance.
    fn finish_stage(&mut self, report: String) -> bool {
        if let Some(supervision) = &self.spec.supervision {
            self.history.push(StageRecord {
                phase: self.phase.clone(),
                round: self.round,
                harness: self.harness().into(),
                task_id: self.task_id.clone().unwrap_or_default(),
                report: report.clone(),
            });
            match self.phase.as_str() {
                "planning" => {
                    self.phase = "executing".into();
                    self.round = 1;
                }
                "executing" => self.phase = "reviewing".into(),
                "reviewing" if crate::collaboration::review_approved(&report) => {
                    self.status = "done".into();
                    self.report = Some(
                        self.history
                            .iter()
                            .map(|s| {
                                format!(
                                    "{} / {} / round {}\n{}",
                                    s.harness, s.phase, s.round, s.report
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n"),
                    );
                    return true;
                }
                "reviewing" if self.round < supervision.max_rounds => {
                    self.phase = "executing".into();
                    self.round += 1;
                }
                _ => {
                    self.status = "needs_attention".into();
                    self.error = Some("达到执行轮数上限，尚未通过指挥方验收".into());
                    self.report = Some(report);
                    return false;
                }
            }
            self.status = "pending".into();
            self.report = Some(report);
            false
        } else {
            self.status = "done".into();
            self.report = Some(report);
            true
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphRun {
    pub id: String,
    pub source_task_id: String,
    pub context_source_task_id: String,
    pub conversation_id: String,
    pub cwd: String,
    pub base_commit: String,
    pub status: String,
    pub nodes: Vec<Node>,
    pub max_parallel: usize,
    pub timeout_secs: u64,
    pub error: Option<String>,
    pub integrated: bool,
    #[serde(default)]
    pub state_version: i64,
    #[serde(default)]
    pub policy_version: i64,
}
#[derive(Clone, Default)]
pub struct GraphRegistry(
    Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    Arc<Mutex<HashSet<(String, String)>>>,
);

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("Git 启动失败：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

pub(crate) fn graph_baseline(cwd: &Path) -> Result<String, String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"])?;
    if crate::coordination::directory_key(root.trim())?
        != crate::coordination::directory_key(cwd.to_str().ok_or("目录编码无效")?)?
    {
        return Err("并行任务需要以 Git 仓库根目录为工作目录".into());
    }
    if !git(cwd, &["status", "--porcelain"])?.trim().is_empty() {
        return Err(
            "并行任务需要干净的 Git 基线，请先提交或自行保存现有改动；不会自动暂存或丢弃改动"
                .into(),
        );
    }
    Ok(git(cwd, &["rev-parse", "HEAD"])?.trim().into())
}

pub fn validate(specs: &[NodeSpec], parallel: usize, timeout: u64) -> Result<Vec<usize>, String> {
    if specs.is_empty()
        || specs.len() > 12
        || !(1..=4).contains(&parallel)
        || !(60..=3600).contains(&timeout)
    {
        return Err("任务图限制：1 到 12 个任务、1 到 4 路并行、60 到 3600 秒总时限".into());
    }
    let mut ids = HashSet::new();
    for s in specs {
        if s.id.is_empty()
            || s.id.len() > 64
            || !s
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || !ids.insert(s.id.clone())
            || s.prompt.trim().is_empty()
            || s.prompt.len() > 16_000
            || s.dependencies.len() > 12
        {
            return Err("任务标识、要求或依赖无效".into());
        }
        if s.harness != "deck" {
            Harness::parse(&s.harness)?;
        }
        if let Some(supervision) = &s.supervision {
            crate::collaboration::validate_pair(
                &supervision.commander,
                &s.harness,
                supervision.max_rounds,
            )?;
        }
    }
    let mut order = Vec::new();
    let mut visited = HashSet::new();
    while order.len() < specs.len() {
        let next = specs.iter().enumerate().find(|(_, s)| {
            !visited.contains(&s.id)
                && s.dependencies
                    .iter()
                    .all(|d| ids.contains(d) && visited.contains(d))
        });
        let Some((i, s)) = next else {
            return Err("任务图存在循环、自依赖或未知依赖".into());
        };
        visited.insert(s.id.clone());
        order.push(i);
    }
    Ok(order)
}

fn ancestors(run: &GraphRun, index: usize) -> Result<Vec<usize>, String> {
    let specs = run.nodes.iter().map(|n| n.spec.clone()).collect::<Vec<_>>();
    let order = validate(&specs, run.max_parallel, run.timeout_secs)?;
    let mut needed = run.nodes[index]
        .spec
        .dependencies
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    for &i in order.iter().rev() {
        if needed.contains(&run.nodes[i].spec.id) {
            needed.extend(run.nodes[i].spec.dependencies.iter().cloned());
        }
    }
    Ok(order
        .into_iter()
        .filter(|&i| needed.contains(&run.nodes[i].spec.id))
        .collect())
}

fn save(app: &AppHandle, store: &Store, run: &GraphRun) -> Result<(), String> {
    if store.get_task(&run.source_task_id)?.is_none() {
        return Err("源会话已删除".into());
    }
    for node in &run.nodes {
        if let Some(id) = &node.task_id {
            if store.get_task(id)?.is_none() {
                return Err("任务图中的任务已删除".into());
            }
        }
    }
    let conn = store.conn.lock().map_err(|_| "store poisoned")?;
    conn.execute(
        "INSERT INTO graph_runs VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        rusqlite::params![
            run.id,
            run.conversation_id,
            serde_json::to_string(run).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("orchestration-update", run);
    Ok(())
}

fn load(store: &Store, id: &str) -> Result<GraphRun, String> {
    let conn = store.conn.lock().map_err(|_| "store poisoned")?;
    let raw: String = conn
        .query_row("SELECT data FROM graph_runs WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_graph_runs(store: State<'_, Store>, task_id: String) -> Result<Vec<GraphRun>, String> {
    let cid = store.ensure_conversation(&task_id)?;
    let conn = store.conn.lock().map_err(|_| "store poisoned")?;
    let mut stmt = conn
        .prepare("SELECT data FROM graph_runs WHERE conversation_id=?1 ORDER BY rowid DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([cid], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}

fn cancel_node(app: &AppHandle, node: &Node) {
    if let Some(id) = &node.task_id {
        let _ = crate::cancel_task(app.state::<TaskRegistry>(), id.clone());
        let _ = pi_session::send_command(
            &app.state::<pi_session::PiRegistry>(),
            id,
            "abort",
            None,
            None,
        );
    }
}

#[tauri::command]
pub fn cancel_graph_run(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, GraphRegistry>,
    id: String,
) -> Result<(), String> {
    let run = load(&store, &id)?;
    let flag = registry
        .0
        .lock()
        .map_err(|_| "graph registry poisoned")?
        .get(&id)
        .cloned()
        .ok_or("任务图已结束或中断")?;
    flag.store(true, Ordering::SeqCst);
    for node in &run.nodes {
        cancel_node(&app, node);
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_graph_node(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, GraphRegistry>,
    id: String,
    node_id: String,
) -> Result<(), String> {
    let run = load(&store, &id)?;
    if run.status != "running" {
        return Err("任务图已结束".into());
    }
    let node = run
        .nodes
        .iter()
        .find(|n| n.spec.id == node_id)
        .ok_or("节点不存在")?;
    if !matches!(node.status.as_str(), "pending" | "running") {
        return Err("任务链已结束".into());
    }
    registry
        .1
        .lock()
        .map_err(|_| "graph registry poisoned")?
        .insert((id, node_id));
    cancel_node(&app, node);
    Ok(())
}

pub(crate) fn stop_for_tasks(app: &AppHandle, store: &Store, ids: &[String]) -> Result<(), String> {
    let raws = {
        let conn = store.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare("SELECT data FROM graph_runs")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for raw in raws {
        let run: GraphRun = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if ids.contains(&run.source_task_id)
            || run.nodes.iter().any(|n| {
                n.task_id.as_ref().is_some_and(|id| ids.contains(id))
                    || n.history.iter().any(|stage| ids.contains(&stage.task_id))
            })
        {
            if let Some(flag) = app
                .state::<GraphRegistry>()
                .0
                .lock()
                .map_err(|_| "graph registry poisoned")?
                .get(&run.id)
            {
                flag.store(true, Ordering::SeqCst);
            }
            for node in &run.nodes {
                cancel_node(app, node);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_graph_run(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, GraphRegistry>,
    source_task_id: String,
    nodes: Vec<NodeSpec>,
    max_parallel: usize,
    timeout_secs: u64,
) -> Result<GraphRun, String> {
    start_graph_run_reserved(
        app,
        store,
        registry,
        source_task_id,
        nodes,
        max_parallel,
        timeout_secs,
        None,
    )
    .await
}

pub(crate) async fn start_graph_run_reserved(
    app: AppHandle,
    store: State<'_, Store>,
    registry: State<'_, GraphRegistry>,
    source_task_id: String,
    nodes: Vec<NodeSpec>,
    max_parallel: usize,
    timeout_secs: u64,
    reservation: Option<crate::store::ConversationLaunch>,
) -> Result<GraphRun, String> {
    validate(&nodes, max_parallel, timeout_secs)?;
    let selected = store.get_task(&source_task_id)?.ok_or("源任务不存在")?;
    let cid = store.ensure_conversation(&source_task_id)?;
    let source = store.get_task(&cid)?.ok_or("会话根任务不存在")?;
    let source_task_id = source.id.clone();
    if source.status == "running" {
        return Err("请先停止源任务或等待结束".into());
    }
    let restricted = [&selected, &source].iter().any(|s| {
        s.mode
            .as_deref()
            .is_some_and(|m| !matches!(m, "" | "auto" | "default" | "full" | "yolo"))
    });
    if restricted && nodes.iter().any(|n| !n.read_only) {
        return Err("源会话权限受限，只能派发只读协作者".into());
    }
    let _reservation = if let Some(guard) = reservation {
        store.accept_conversation_launch(&cid, guard)?
    } else {
        store.claim_conversation(&cid)?
    };
    crate::execution::initialize(&app);
    for node in &nodes {
        let copy = store.clone_handle();
        let resolving_cid = cid.clone();
        let resolving_node = node.clone();
        tokio::task::spawn_blocking(move || {
            crate::execution::resolve(
                &copy,
                Some(&resolving_cid),
                &resolving_node.harness,
                &resolving_node.execution,
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(supervision) = &node.supervision {
            let copy = store.clone_handle();
            let cid = cid.clone();
            let supervision = supervision.clone();
            tokio::task::spawn_blocking(move || {
                crate::execution::resolve(
                    &copy,
                    Some(&cid),
                    &supervision.commander,
                    &supervision.execution,
                )
            })
            .await
            .map_err(|e| e.to_string())??;
        }
    }
    let policy = store.context_policy(&source_task_id)?;
    for node in &nodes {
        for harness in std::iter::once(node.harness.as_str())
            .chain(node.supervision.as_ref().map(|s| s.commander.as_str()))
        {
            policy.authorize(harness)?;
            if harness != "deck" && crate::discovery::locate(Harness::parse(harness)?).is_none() {
                return Err(format!("未安装 {harness}"));
            }
        }
    }
    let id = format!("graph-{}", crate::pi_session_task_id());
    let lease = store.claim_workspace(&source.cwd, &id)?;
    let cwd = PathBuf::from(&source.cwd);
    let baseline = tokio::task::spawn_blocking(move || graph_baseline(&cwd))
        .await
        .map_err(|e| e.to_string())??;
    let mut turns = store.session_tasks(&source_task_id)?;
    turns.sort_by(crate::conversation::turn_order);
    let context_source_task_id = turns.last().ok_or("会话轮次缺失")?.id.clone();
    let state_version = store.shared_state(&cid)?.version;
    let run = GraphRun {
        id: id.clone(),
        source_task_id,
        context_source_task_id,
        conversation_id: cid,
        cwd: source.cwd,
        base_commit: baseline,
        status: "running".into(),
        max_parallel,
        timeout_secs,
        error: None,
        integrated: false,
        nodes: nodes
            .into_iter()
            .map(|spec| Node {
                phase: if spec.supervision.is_some() {
                    "planning"
                } else {
                    "executing"
                }
                .into(),
                round: 0,
                history: Vec::new(),
                spec,
                status: "pending".into(),
                task_id: None,
                worktree: None,
                baseline_tree: None,
                patch_path: None,
                patch_hash: None,
                report: None,
                error: None,
            })
            .collect(),
        state_version,
        policy_version: policy.version,
    };
    save(&app, &store, &run)?;
    let flag = Arc::new(AtomicBool::new(false));
    registry
        .0
        .lock()
        .map_err(|_| "graph registry poisoned")?
        .insert(id, flag.clone());
    let initial = run.clone();
    let store = store.clone_handle();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _lease = lease;
        let mut run = run;
        if let Err(error) = drive(&app, &store, &mut run, &flag).await {
            run.error = Some(error);
            run.status = "needs_attention".into();
            for node in &run.nodes {
                cancel_node(&app, node);
            }
        }
        let _ = save(&app, &store, &run);
        if let Ok(mut active) = registry.0.lock() {
            active.remove(&run.id);
        }
        if let Ok(mut cancelled) = registry.1.lock() {
            cancelled.retain(|(id, _)| id != &run.id);
        }
    });
    Ok(initial)
}

fn verified_patch(node: &Node) -> Result<PathBuf, String> {
    let path = PathBuf::from(node.patch_path.as_ref().ok_or("依赖成果缺失")?);
    let worktree = PathBuf::from(node.worktree.as_ref().ok_or("工作树缺失")?);
    let hash = git(
        &worktree,
        &["hash-object", path.to_str().ok_or("成果路径编码无效")?],
    )?;
    if node.patch_hash.as_deref() != Some(hash.trim()) {
        return Err("成果已变化，哈希校验失败".into());
    }
    Ok(path)
}

fn create_branch(run: &GraphRun, index: usize, root: &Path) -> Result<(String, String), String> {
    let dir = root.join(&run.id).join(&run.nodes[index].spec.id);
    std::fs::create_dir_all(dir.parent().ok_or("工作树目录无效")?).map_err(|e| e.to_string())?;
    let path = dir.to_str().ok_or("工作树目录编码无效")?;
    git(
        Path::new(&run.cwd),
        &["worktree", "add", "--detach", path, &run.base_commit],
    )?;
    for i in ancestors(run, index)? {
        let patch = verified_patch(&run.nodes[i])?;
        if std::fs::metadata(&patch).map_err(|e| e.to_string())?.len() > 0 {
            git(
                &dir,
                &["apply", "--binary", patch.to_str().ok_or("成果路径无效")?],
            )?;
        }
    }
    git(&dir, &["add", "--all"])?;
    let tree = git(&dir, &["write-tree"])?.trim().to_string();
    Ok((path.into(), tree))
}

fn collect_artifact(node: &Node, root: &Path, run_id: &str) -> Result<(String, String), String> {
    let cwd = Path::new(node.worktree.as_ref().ok_or("工作树缺失")?);
    git(cwd, &["add", "--all"])?;
    let tree = git(cwd, &["write-tree"])?;
    let base = node.baseline_tree.as_ref().ok_or("基线缺失")?;
    let patch = git(
        cwd,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            base,
            tree.trim(),
            "--",
        ],
    )?;
    if node.spec.read_only && !patch.is_empty() {
        return Err("只读专家修改了隔离文件，成果已拒绝；源工作区未集成".into());
    }
    let dir = root.join(run_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.patch", node.spec.id));
    std::fs::write(&path, patch).map_err(|e| e.to_string())?;
    let hash = git(cwd, &["hash-object", path.to_str().ok_or("成果路径无效")?])?
        .trim()
        .to_string();
    Ok((path.to_string_lossy().into_owned(), hash))
}

fn dispatch_allowed(
    store: &Store,
    run: &mut GraphRun,
    cancelled: &AtomicBool,
    deadline: tokio::time::Instant,
) -> Result<bool, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Ok(false);
    }
    if tokio::time::Instant::now() >= deadline {
        cancelled.store(true, Ordering::SeqCst);
        run.error = Some("任务图超过总时限".into());
        return Ok(false);
    }
    if store.shared_state(&run.conversation_id)?.version != run.state_version {
        cancelled.store(true, Ordering::SeqCst);
        run.error = Some("共享目标或约束已变化，任务图已停止；保留已有成果，请重新安排".into());
        return Ok(false);
    }
    if store.context_policy(&run.source_task_id)?.version != run.policy_version {
        cancelled.store(true, Ordering::SeqCst);
        run.error = Some("共享策略已变化，任务图已停止；保留已有成果，请重新安排".into());
        return Ok(false);
    }
    Ok(true)
}

async fn drive(
    app: &AppHandle,
    store: &Store,
    run: &mut GraphRun,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let data = crate::normalize_windows_path(app.path().app_data_dir().map_err(|e| e.to_string())?);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(run.timeout_secs);
    let mut stop_started = None;
    loop {
        dispatch_allowed(store, run, cancelled, deadline)?;
        let timed_out = tokio::time::Instant::now() >= deadline;
        let stopping = cancelled.load(Ordering::SeqCst) || timed_out;
        let mut changed = false;
        let cancelled_nodes = app
            .state::<GraphRegistry>()
            .1
            .lock()
            .map_err(|_| "graph registry poisoned")?
            .clone();
        for node in &mut run.nodes {
            if cancelled_nodes.contains(&(run.id.clone(), node.spec.id.clone())) {
                if node.status == "running" {
                    cancel_node(app, node);
                }
                if node.status == "pending" {
                    node.status = "cancelled".into();
                    changed = true;
                }
            }
        }
        if stopping {
            for node in &mut run.nodes {
                if node.status == "running" {
                    cancel_node(app, node);
                }
                if node.status == "pending" {
                    node.status = "cancelled".into();
                }
            }
            let since = stop_started.get_or_insert_with(tokio::time::Instant::now);
            if since.elapsed().as_secs() >= 10 {
                return Err("取消尚未收尾；运行任务继续阻止其工作树，需人工确认恢复".into());
            }
        }
        for i in 0..run.nodes.len() {
            if run.nodes[i].status != "running" {
                continue;
            }
            let id = run.nodes[i].task_id.clone().ok_or("任务标识缺失")?;
            let row = store.get_task(&id)?.ok_or("并行任务已删除")?;
            if row.status == "running" {
                continue;
            }
            changed = true;
            run.nodes[i].status = row.status;
            let node_stopping = stopping
                || cancelled_nodes.contains(&(run.id.clone(), run.nodes[i].spec.id.clone()));
            if run.nodes[i].status == "done" && !node_stopping {
                let report = crate::handoff::assistant_text(&store.get_events(&id, 0, i64::MAX)?);
                if report.trim().is_empty() {
                    run.nodes[i].status = "failed".into();
                    run.nodes[i].error = Some("执行者未返回有效报告，成果未获验收".into());
                    continue;
                }
                if !run.nodes[i].finish_stage(report) {
                    continue;
                }
                let node = run.nodes[i].clone();
                let root = data.join("collaboration-artifacts");
                let run_id = run.id.clone();
                match tokio::task::spawn_blocking(move || collect_artifact(&node, &root, &run_id))
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Ok((path, hash)) => {
                        run.nodes[i].patch_path = Some(path);
                        run.nodes[i].patch_hash = Some(hash);
                    }
                    Err(error) => {
                        run.nodes[i].status = "failed".into();
                        run.nodes[i].error = Some(error);
                    }
                }
            } else if node_stopping {
                run.nodes[i].status = "cancelled".into();
            }
        }
        for i in 0..run.nodes.len() {
            if run.nodes[i].status != "pending" {
                continue;
            }
            let dependencies = &run.nodes[i].spec.dependencies;
            if dependencies.iter().any(|d| {
                run.nodes.iter().any(|n| {
                    &n.spec.id == d
                        && matches!(
                            n.status.as_str(),
                            "failed" | "blocked" | "cancelled" | "needs_attention" | "interrupted"
                        )
                })
            }) {
                run.nodes[i].status = "blocked".into();
                changed = true;
                continue;
            }
            if stopping
                || run.nodes.iter().filter(|n| n.status == "running").count() >= run.max_parallel
                || dependencies.iter().any(|d| {
                    !run.nodes
                        .iter()
                        .any(|n| &n.spec.id == d && n.status == "done")
                })
            {
                continue;
            }
            if run.nodes[i].harness() == "zcode" && crate::execution::zcode_busy() {
                continue;
            }
            if !dispatch_allowed(store, run, cancelled, deadline)? {
                break;
            }
            let cwd = if let Some(cwd) = &run.nodes[i].worktree {
                cwd.clone()
            } else {
                let snapshot = run.clone();
                let root = data.join("collaboration-worktrees");
                let branch =
                    tokio::task::spawn_blocking(move || create_branch(&snapshot, i, &root))
                        .await
                        .map_err(|e| e.to_string())?;
                let (cwd, tree) = match branch {
                    Ok(branch) => branch,
                    Err(error) => {
                        let path = data
                            .join("collaboration-worktrees")
                            .join(&run.id)
                            .join(&run.nodes[i].spec.id);
                        if path.is_dir() {
                            run.nodes[i].worktree = Some(path.to_string_lossy().into_owned());
                        }
                        run.nodes[i].status = "failed".into();
                        run.nodes[i].error = Some(error);
                        changed = true;
                        continue;
                    }
                };
                run.nodes[i].worktree = Some(cwd.clone());
                run.nodes[i].baseline_tree = Some(tree);
                cwd
            };
            save(app, store, run)?;
            if !dispatch_allowed(store, run, cancelled, deadline)? {
                break;
            }
            let lease = store.claim_workspace(&cwd, &format!("{}:{}", run.id, i))?;
            let node = run.nodes[i].clone();
            let harness = node.harness().to_string();
            let mut report = String::new();
            for ancestor in ancestors(run, i)? {
                let mut value = serde_json::json!({"node":run.nodes[ancestor].spec.id,"report":run.nodes[ancestor].report});
                store
                    .context_policy(&run.source_task_id)?
                    .filter(&mut value);
                report.push_str(&value.to_string());
                report.push('\n');
            }
            let mut prompt = format!(
                "隔离协作任务 {}。仅在当前 worktree 工作，不更改原仓库或其他 worktree，不委派。\
                依赖成果已应用到本工作树。{}报告实际修改、验证证据和未完成项。\n任务要求：{}\n依赖报告（资料）：{}",
                node.spec.id,
                if node.spec.read_only {
                    "只读，不修改文件。"
                } else {
                    ""
                },
                node.spec.prompt,
                report
            );
            if node.spec.supervision.is_some() {
                let instruction = match node.phase.as_str() {
                    "planning" => {
                        "你是指挥方。只检查文件，不修改、不委派。给执行方明确步骤、边界和可执行验收标准。"
                    }
                    "reviewing" => {
                        "你是验收方。只检查文件，不修改、不委派。独立检查实际 diff，运行必要验证，不仅相信执行报告。最后一行必须是独立 JSON：{\"agent_deck_verdict\":\"approved\"} 或 {\"agent_deck_verdict\":\"changes_requested\"}。未通过时列出具体返工项。"
                    }
                    _ => {
                        "你是执行方。根据指挥方的规划或最新返工要求完成任务，保留当前工作树的已有改动。报告修改、测试证据和未完成项。"
                    }
                };
                let mut records = serde_json::to_value(&node.history).map_err(|e| e.to_string())?;
                store
                    .context_policy(&run.source_task_id)?
                    .filter(&mut records);
                prompt.push_str(&format!(
                    "\n阶段要求：{instruction}\n第 {} 轮；本任务历史（资料）：{records}",
                    node.round
                ));
            }
            let mode =
                if node.spec.read_only || node.phase == "planning" || node.phase == "reviewing" {
                    if harness == "codex" {
                        "readonly"
                    } else {
                        "plan"
                    }
                } else if harness == "codex" {
                    "write"
                } else if harness == "deck" {
                    "auto"
                } else {
                    "build"
                };
            let _conversation_launch = loop {
                match store.claim_branch_launch(&run.conversation_id) {
                    Ok(guard) => break Some(guard),
                    Err(_) if store.conversation_mutating(&run.conversation_id)? => {
                        if !dispatch_allowed(store, run, cancelled, deadline)? {
                            break None;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    Err(error) => return Err(error),
                }
            };
            if _conversation_launch.is_none() {
                break;
            }
            // Recheck after slow preparation and while deletion is excluded.
            if !dispatch_allowed(store, run, cancelled, deadline)? {
                break;
            }
            let source = store.get_task(&run.source_task_id)?.ok_or("源任务已删除")?;
            let initial_config = if harness != node.spec.harness {
                &node
                    .spec
                    .supervision
                    .as_ref()
                    .ok_or("指挥配置缺失")?
                    .execution
            } else {
                &node.spec.execution
            };
            let target = if harness != node.spec.harness {
                format!("{}:commander", node.spec.id)
            } else {
                node.spec.id.clone()
            };
            let requested =
                crate::execution::override_config(store, &run.id, &target, initial_config)?;
            let copy = store.clone_handle();
            let cid = run.conversation_id.clone();
            let resolving_harness = harness.clone();
            let cfg = requested.clone();
            let (resolved, transport) = tokio::task::spawn_blocking(move || {
                crate::execution::resolve(&copy, Some(&cid), &resolving_harness, &cfg)
            })
            .await
            .map_err(|e| e.to_string())??;
            let mut context = crate::conversation::prepare_execution(
                store,
                &run.context_source_task_id,
                &harness,
                &run.cwd,
                &prompt,
                None,
                &data.join("conversation-context"),
                &crate::pi_session_task_id(),
                true,
                resolved.model.as_deref(),
            )?;
            context.prompt.push_str(&format!(
                "\n本轮是隔离分支，实际工作目录为 {cwd}；原目录仅为历史来源，不得在那里执行写入。"
            ));
            let context_archive = context
                .sync_event
                .as_ref()
                .and_then(|event| event["context_sync"]["archive_path"].as_str())
                .map(str::to_owned);
            if !dispatch_allowed(store, run, cancelled, deadline)? {
                break;
            }
            if app
                .state::<GraphRegistry>()
                .1
                .lock()
                .map_err(|_| "graph registry poisoned")?
                .contains(&(run.id.clone(), node.spec.id.clone()))
            {
                run.nodes[i].status = "cancelled".into();
                changed = true;
                continue;
            }
            if harness == "zcode" && crate::execution::zcode_busy() {
                continue;
            }
            let task = crate::start_task_impl(
                app.clone(),
                app.state::<TaskRegistry>(),
                app.state::<Store>(),
                app.state::<pi_session::PiRegistry>(),
                harness.clone(),
                cwd,
                context.prompt.clone(),
                Some(mode.into()),
                resolved.model.clone(),
                Some("auto".into()),
                None,
                source.project_id,
                None,
                Some(true),
                Vec::new(),
                Some(format!("{}:{}", run.id, i)),
                context_archive,
                resolved.effort.clone(),
                None,
                Some((requested, resolved.clone(), transport)),
                None,
            )
            .await;
            let task = match task {
                Ok(task) => task,
                Err(error) => {
                    run.nodes[i].status = "failed".into();
                    run.nodes[i].error = Some(error);
                    changed = true;
                    continue;
                }
            };
            context.retain_archive();
            run.nodes[i].task_id = Some(task.task_id.clone());
            run.nodes[i].status = "running".into();
            if harness == node.spec.harness {
                run.nodes[i].spec.execution = resolved;
            } else if let Some(s) = &mut run.nodes[i].spec.supervision {
                s.execution = resolved;
            }
            // Branches share the public conversation, not native resume handles.
            store.set_task_conversation(&task.task_id, &run.conversation_id)?;
            store
                .conn
                .lock()
                .map_err(|_| "store poisoned")?
                .execute(
                    "DELETE FROM runtime_bindings WHERE task_id=?1 AND conversation_id!=?2",
                    rusqlite::params![task.task_id, run.conversation_id],
                )
                .map_err(|e| e.to_string())?;
            if let Some(event) = context.sync_event {
                store.append_event(&task.task_id, &event.to_string())?;
                store.record_delivery(&task.task_id, &run.conversation_id, &event)?;
            }
            save(app, store, run)?;
            // The child task itself now blocks this isolated directory.
            drop(lease);
            changed = true;
        }
        if changed {
            save(app, store, run)?;
        }
        if run
            .nodes
            .iter()
            .all(|n| !matches!(n.status.as_str(), "running" | "pending"))
        {
            let timed_out = tokio::time::Instant::now() >= deadline;
            let stopping = cancelled.load(Ordering::SeqCst) || timed_out;
            run.status = if stopping {
                "cancelled"
            } else if run.nodes.iter().all(|n| n.status == "done") {
                "done"
            } else {
                "needs_attention"
            }
            .into();
            if timed_out {
                run.error = Some("任务图超过总时限".into());
            }
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

#[tauri::command]
pub async fn integrate_graph_run(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    confirmed: bool,
) -> Result<GraphRun, String> {
    if !confirmed {
        return Err("集成成果需要明确确认".into());
    }
    let mut run = load(&store, &id)?;
    if run.status != "done" || run.integrated {
        return Err("仅可集成未集成且全部完成的任务图".into());
    }
    if store.shared_state(&run.conversation_id)?.version != run.state_version {
        return Err("共享目标或约束已变化，旧成果需要重新验收，已拒绝集成".into());
    }
    let _reservation = store.claim_conversation(&run.conversation_id)?;
    let _lease = store.claim_workspace(&run.cwd, &format!("integrate-{id}"))?;
    let data = crate::normalize_windows_path(app.path().app_data_dir().map_err(|e| e.to_string())?);
    let snapshot = run.clone();
    tokio::task::spawn_blocking(move || integrate(&snapshot, &data))
        .await
        .map_err(|e| e.to_string())??;
    run.integrated = true;
    save(&app, &store, &run)?;
    Ok(run)
}

fn managed_path(path: &Path, data: &Path, folder: &str) -> Result<(), String> {
    let data = std::fs::canonicalize(data).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(data.join(folder)).map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !root.starts_with(&data) || !path.starts_with(&root) || path == root {
        return Err("成果路径不在应用管理目录内，拒绝移除".into());
    }
    Ok(())
}

fn discard(run: &GraphRun, data: &Path) -> Result<(), String> {
    let integration_patch = data
        .join("collaboration-artifacts")
        .join(&run.id)
        .join("integration.patch");
    if integration_patch.exists() {
        managed_path(&integration_patch, data, "collaboration-artifacts")?;
    }
    // Validate every target before any removal, including symlink resolution.
    for node in &run.nodes {
        if let Some(path) = &node.worktree {
            if Path::new(path).exists() {
                managed_path(Path::new(path), data, "collaboration-worktrees")?;
            }
        }
        if let Some(path) = &node.patch_path {
            if Path::new(path).exists() {
                managed_path(Path::new(path), data, "collaboration-artifacts")?;
            }
        }
    }
    for node in &run.nodes {
        if let Some(path) = &node.worktree {
            if Path::new(path).exists() {
                git(
                    Path::new(&run.cwd),
                    &["worktree", "remove", "--force", path],
                )?;
            }
        }
        if let Some(path) = &node.patch_path {
            if Path::new(path).exists() {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    if integration_patch.exists() {
        std::fs::remove_file(&integration_patch).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn discard_graph_run(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    confirmed: bool,
) -> Result<GraphRun, String> {
    if !confirmed {
        return Err("移除隔离成果需要明确确认".into());
    }
    let mut run = load(&store, &id)?;
    if matches!(run.status.as_str(), "running" | "discarded") {
        return Err("运行中或已移除的成果不能再次移除".into());
    }
    let _reservation = store.claim_conversation(&run.conversation_id)?;
    let _root_lease = store.claim_workspace(&run.cwd, &format!("discard-{id}"))?;
    let mut leases = Vec::new();
    for node in &run.nodes {
        if let Some(path) = &node.worktree {
            if Path::new(path).exists() {
                leases.push(store.claim_workspace(path, &format!("discard-{id}"))?);
            }
        }
    }
    let data = crate::normalize_windows_path(app.path().app_data_dir().map_err(|e| e.to_string())?);
    let snapshot = run.clone();
    tokio::task::spawn_blocking(move || discard(&snapshot, &data))
        .await
        .map_err(|e| e.to_string())??;
    {
        let conn = store.conn.lock().map_err(|_| "store poisoned")?;
        for node in &run.nodes {
            if let Some(task) = &node.task_id {
                conn.execute("DELETE FROM runtime_bindings WHERE task_id=?1", [task])
                    .map_err(|e| e.to_string())?;
                conn.execute("UPDATE tasks SET session_id=NULL WHERE id=?1", [task])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    for node in &mut run.nodes {
        node.worktree = None;
        node.patch_path = None;
        node.patch_hash = None;
    }
    run.status = "discarded".into();
    save(&app, &store, &run)?;
    Ok(run)
}

fn integrate(run: &GraphRun, data: &Path) -> Result<(), String> {
    let cwd = Path::new(&run.cwd);
    if git(cwd, &["rev-parse", "HEAD"])?.trim() != run.base_commit
        || !git(cwd, &["status", "--porcelain"])?.trim().is_empty()
    {
        return Err("源工作区已变化，拒绝集成；所有分支成果仍然保留".into());
    }
    let dir = data
        .join("collaboration-worktrees")
        .join(&run.id)
        .join("integration");
    git(
        cwd,
        &[
            "worktree",
            "add",
            "--detach",
            dir.to_str().ok_or("集成目录无效")?,
            &run.base_commit,
        ],
    )?;
    let result = (|| {
        let specs = run.nodes.iter().map(|n| n.spec.clone()).collect::<Vec<_>>();
        for i in validate(&specs, run.max_parallel, run.timeout_secs)? {
            let patch = verified_patch(&run.nodes[i])?;
            if std::fs::metadata(&patch).map_err(|e| e.to_string())?.len() > 0 {
                git(
                    &dir,
                    &["apply", "--binary", patch.to_str().ok_or("成果路径无效")?],
                )?;
            }
        }
        git(&dir, &["add", "--all"])?;
        git(&dir, &["diff", "--check", "HEAD"])?;
        let tree = git(&dir, &["write-tree"])?;
        let patch = git(
            &dir,
            &[
                "diff",
                "--binary",
                "--no-ext-diff",
                "--no-textconv",
                &run.base_commit,
                tree.trim(),
                "--",
            ],
        )?;
        git(&dir, &["diff", "--check", "HEAD"])?;
        let path = data
            .join("collaboration-artifacts")
            .join(&run.id)
            .join("integration.patch");
        std::fs::write(&path, &patch).map_err(|e| e.to_string())?;
        if !patch.is_empty() {
            if git(cwd, &["rev-parse", "HEAD"])?.trim() != run.base_commit
                || !git(cwd, &["status", "--porcelain"])?.trim().is_empty()
            {
                return Err("集成准备期间源工作区发生变化，已停止集成".into());
            }
            let path = path.to_str().ok_or("成果路径无效")?;
            git(cwd, &["apply", "--check", "--binary", path])?;
            git(cwd, &["apply", "--binary", path])?;
        }
        Ok(())
    })();
    // Git owns this narrowly named worktree; do not recursively delete arbitrary paths.
    let _ = git(
        cwd,
        &[
            "worktree",
            "remove",
            "--force",
            dir.to_str().ok_or("集成目录无效")?,
        ],
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec(id: &str, deps: &[&str]) -> NodeSpec {
        NodeSpec {
            id: id.into(),
            dependencies: deps.iter().map(|s| s.to_string()).collect(),
            harness: "codex".into(),
            prompt: "test".into(),
            read_only: true,
            execution: Default::default(),
            supervision: None,
        }
    }
    #[test]
    fn validates_dag_and_budget() {
        assert_eq!(
            validate(&[spec("review", &["work"]), spec("work", &[])], 2, 900).unwrap(),
            vec![1, 0]
        );
        assert!(validate(&[spec("a", &["b"]), spec("b", &["a"])], 2, 900).is_err());
        assert!(validate(&[spec("a", &["missing"])], 2, 900).is_err());
        assert!(validate(&[spec("a", &[]), spec("a", &[])], 2, 900).is_err());
        assert!(validate(&[spec("../escape", &[])], 2, 900).is_err());
        assert!(validate(&[spec("a", &[])], 5, 900).is_err());
    }

    fn supervised(id: &str, commander: &str, worker: &str) -> Node {
        Node {
            spec: NodeSpec {
                harness: worker.into(),
                supervision: Some(Supervision {
                    commander: commander.into(),
                    max_rounds: 2,
                    execution: Default::default(),
                }),
                ..spec(id, &[])
            },
            status: "running".into(),
            phase: "planning".into(),
            round: 0,
            task_id: Some(format!("{id}-plan")),
            worktree: None,
            baseline_tree: None,
            patch_path: None,
            patch_hash: None,
            report: None,
            error: None,
            history: Vec::new(),
        }
    }

    #[test]
    fn all_twelve_directions_and_four_parallel_lanes_validate() {
        for commander in ["codex", "opencode", "zcode", "deck"] {
            for worker in ["codex", "opencode", "zcode", "deck"] {
                let node = supervised("chain", commander, worker);
                assert_eq!(validate(&[node.spec], 4, 900).is_ok(), commander != worker);
            }
        }
    }

    #[test]
    fn independent_command_chains_review_retry_and_exhaust_without_accepting_worker_claims() {
        let mut a = supervised("a", "opencode", "zcode");
        let mut b = supervised("b", "codex", "deck");
        assert_eq!(a.harness(), "opencode");
        assert!(!a.finish_stage("Plan A: run tests".into()));
        assert_eq!(
            (a.phase.as_str(), a.harness(), a.round),
            ("executing", "zcode", 1)
        );
        assert!(!b.finish_stage("Plan B".into()));
        assert!(!a.finish_stage("{\"agent_deck_verdict\":\"approved\"}".into()));
        assert_eq!(a.phase, "reviewing");
        assert!(!a.finish_stage(
            "Fix failing tests\n{\"agent_deck_verdict\":\"changes_requested\"}".into()
        ));
        assert_eq!((a.phase.as_str(), a.round), ("executing", 2));
        assert_eq!((b.phase.as_str(), b.round), ("executing", 1));
        assert!(!b.finish_stage("Implemented and tested B".into()));
        assert!(
            b.finish_stage("Verified actual diff\n{\"agent_deck_verdict\":\"approved\"}".into())
        );
        assert_eq!(b.status, "done");
        assert!(
            b.report
                .as_ref()
                .unwrap()
                .contains("Implemented and tested B")
        );
        assert!(!a.finish_stage("Still broken".into()));
        assert!(!a.finish_stage("Cannot verify".into()));
        assert_eq!(a.status, "needs_attention");
        assert!(a.patch_path.is_none());
        assert_eq!(b.status, "done");
        assert_eq!(a.history.len(), 5);
    }

    #[test]
    fn chain_checkpoints_roundtrip_and_old_nodes_keep_defaults() {
        let mut node = supervised("chain", "codex", "deck");
        node.finish_stage("Plan".into());
        let restored: Node = serde_json::from_str(&serde_json::to_string(&node).unwrap()).unwrap();
        assert_eq!(restored.phase, "executing");
        assert_eq!(restored.history[0].harness, "codex");
        let mut value = serde_json::to_value(&node).unwrap();
        for key in ["phase", "round", "history"] {
            value.as_object_mut().unwrap().remove(key);
        }
        value["spec"].as_object_mut().unwrap().remove("supervision");
        let legacy: Node = serde_json::from_value(value).unwrap();
        assert!(legacy.history.is_empty());
        assert!(legacy.spec.supervision.is_none());
    }

    struct Repository {
        root: PathBuf,
        data: PathBuf,
    }
    impl Repository {
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("deck-graph-test-{}", crate::pi_session_task_id()));
            let root = base.join("repo");
            let data = base.join("data");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::create_dir_all(&data).unwrap();
            git(&root, &["init"]).unwrap();
            git(&root, &["config", "user.email", "test@example.test"]).unwrap();
            git(&root, &["config", "user.name", "Test"]).unwrap();
            git(&root, &["config", "core.autocrlf", "false"]).unwrap();
            std::fs::write(root.join("a.txt"), "base\n").unwrap();
            git(&root, &["add", "--all"]).unwrap();
            git(&root, &["commit", "-m", "baseline"]).unwrap();
            Self { root, data }
        }
        fn run(&self, specs: Vec<NodeSpec>) -> GraphRun {
            GraphRun {
                id: "test".into(),
                source_task_id: "source".into(),
                context_source_task_id: "source".into(),
                state_version: 0,
                policy_version: 0,
                conversation_id: "source".into(),
                cwd: self.root.to_string_lossy().into_owned(),
                base_commit: git(&self.root, &["rev-parse", "HEAD"])
                    .unwrap()
                    .trim()
                    .into(),
                status: "done".into(),
                max_parallel: 2,
                timeout_secs: 900,
                integrated: false,
                error: None,
                nodes: specs
                    .into_iter()
                    .map(|spec| Node {
                        phase: "executing".into(),
                        round: 0,
                        history: Vec::new(),
                        spec,
                        status: "done".into(),
                        task_id: None,
                        worktree: None,
                        baseline_tree: None,
                        patch_path: None,
                        patch_hash: None,
                        report: None,
                        error: None,
                    })
                    .collect(),
            }
        }
        fn branch(&self, run: &mut GraphRun, i: usize) -> PathBuf {
            let (cwd, tree) =
                create_branch(run, i, &self.data.join("collaboration-worktrees")).unwrap();
            run.nodes[i].worktree = Some(cwd.clone());
            run.nodes[i].baseline_tree = Some(tree);
            PathBuf::from(cwd)
        }
        fn artifact(&self, run: &mut GraphRun, i: usize) {
            let (path, hash) = collect_artifact(
                &run.nodes[i],
                &self.data.join("collaboration-artifacts"),
                &run.id,
            )
            .unwrap();
            run.nodes[i].patch_path = Some(path);
            run.nodes[i].patch_hash = Some(hash);
        }
    }
    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.root.parent().unwrap());
        }
    }
    fn writable(id: &str, deps: &[&str]) -> NodeSpec {
        NodeSpec {
            read_only: false,
            ..spec(id, deps)
        }
    }
    #[test]
    fn dispatch_rechecks_cancellation_deadline_and_changed_constraints() {
        let f = Repository::new();
        let store = Store::in_memory().unwrap();
        store
            .create_task(
                "source",
                "codex",
                &f.root.to_string_lossy(),
                "test",
                None,
                None,
                None,
            )
            .unwrap();
        store.set_task_conversation("source", "source").unwrap();
        store.finish_task("source", "done", None);
        let mut run = f.run(vec![spec("a", &[])]);
        let cancelled = AtomicBool::new(false);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        assert!(dispatch_allowed(&store, &mut run, &cancelled, deadline).unwrap());
        cancelled.store(true, Ordering::SeqCst);
        assert!(!dispatch_allowed(&store, &mut run, &cancelled, deadline).unwrap());
        cancelled.store(false, Ordering::SeqCst);
        assert!(
            !dispatch_allowed(&store, &mut run, &cancelled, tokio::time::Instant::now()).unwrap()
        );
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(run.error.as_deref().unwrap().contains("总时限"));
        cancelled.store(false, Ordering::SeqCst);
        store
            .update_shared_state("source", 0, "new goal", "")
            .unwrap();
        assert!(!dispatch_allowed(&store, &mut run, &cancelled, deadline).unwrap());
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(run.error.as_deref().unwrap().contains("约束"));
        cancelled.store(false, Ordering::SeqCst);
        run.state_version = 1;
        run.policy_version = store.context_policy("source").unwrap().version + 1;
        assert!(!dispatch_allowed(&store, &mut run, &cancelled, deadline).unwrap());
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(run.error.as_deref().unwrap().contains("共享策略"));
    }

    #[test]
    fn dependent_branches_apply_ancestors_once_and_integrate_new_files() {
        let f = Repository::new();
        let mut run = f.run(vec![
            writable("first", &[]),
            writable("second", &["first"]),
            writable("third", &["first", "second"]),
        ]);
        let a = f.branch(&mut run, 0);
        std::fs::write(a.join("a.txt"), "first\n").unwrap();
        f.artifact(&mut run, 0);
        let b = f.branch(&mut run, 1);
        assert_eq!(std::fs::read_to_string(b.join("a.txt")).unwrap(), "first\n");
        std::fs::write(b.join("a.txt"), "second\n").unwrap();
        std::fs::write(b.join("new.txt"), "new\n").unwrap();
        f.artifact(&mut run, 1);
        let c = f.branch(&mut run, 2);
        assert_eq!(
            std::fs::read_to_string(c.join("a.txt")).unwrap(),
            "second\n"
        );
        f.artifact(&mut run, 2);
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "base\n"
        );
        integrate(&run, &f.data).unwrap();
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "second\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join("new.txt")).unwrap(),
            "new\n"
        );
    }
    #[test]
    fn accepted_rework_keeps_one_worktree_and_passes_only_final_changes_to_dependents() {
        let f = Repository::new();
        let mut run = f.run(vec![writable("api", &[]), spec("verify", &["api"])]);
        run.nodes[0] = Node {
            spec: NodeSpec {
                read_only: false,
                ..supervised("api", "opencode", "zcode").spec
            },
            ..supervised("api", "opencode", "zcode")
        };
        let cwd = f.branch(&mut run, 0);
        assert!(!run.nodes[0].finish_stage("Plan: implement and verify".into()));
        std::fs::write(cwd.join("a.txt"), "attempt one\n").unwrap();
        assert!(!run.nodes[0].finish_stage("Initial implementation".into()));
        assert!(!run.nodes[0].finish_stage("Missing error handling".into()));
        assert_eq!(run.nodes[0].status, "pending");
        assert!(run.nodes[0].patch_path.is_none());
        std::fs::write(cwd.join("a.txt"), "accepted implementation\n").unwrap();
        assert!(!run.nodes[0].finish_stage("Error handling added".into()));
        assert!(run.nodes[0].finish_stage("{\"agent_deck_verdict\":\"approved\"}".into()));
        f.artifact(&mut run, 0);
        let dependent = f.branch(&mut run, 1);
        assert_eq!(
            std::fs::read_to_string(dependent.join("a.txt")).unwrap(),
            "accepted implementation\n"
        );
        f.artifact(&mut run, 1);
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "base\n"
        );
        integrate(&run, &f.data).unwrap();
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "accepted implementation\n"
        );
    }
    #[test]
    fn conflicts_leave_source_unchanged_and_keep_artifacts() {
        let f = Repository::new();
        let mut run = f.run(vec![writable("a", &[]), writable("b", &[])]);
        for i in 0..2 {
            let branch = f.branch(&mut run, i);
            std::fs::write(branch.join("a.txt"), format!("worker-{i}\n")).unwrap();
            f.artifact(&mut run, i);
        }
        assert!(integrate(&run, &f.data).is_err());
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "base\n"
        );
        assert!(Path::new(run.nodes[0].patch_path.as_ref().unwrap()).is_file());
    }
    #[test]
    fn readonly_modifications_and_mutated_artifacts_are_rejected() {
        let f = Repository::new();
        let mut run = f.run(vec![spec("readonly", &[])]);
        let branch = f.branch(&mut run, 0);
        std::fs::write(branch.join("a.txt"), "unauthorized\n").unwrap();
        assert!(collect_artifact(&run.nodes[0], &f.data, &run.id).is_err());
        run.nodes[0].spec.read_only = false;
        f.artifact(&mut run, 0);
        std::fs::write(run.nodes[0].patch_path.as_ref().unwrap(), "tampered").unwrap();
        assert!(verified_patch(&run.nodes[0]).is_err());
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "base\n"
        );
    }
    #[test]
    fn dirty_source_blocks_integration_without_reverting_user_changes() {
        let f = Repository::new();
        let mut run = f.run(vec![writable("a", &[])]);
        let branch = f.branch(&mut run, 0);
        std::fs::write(branch.join("a.txt"), "worker\n").unwrap();
        f.artifact(&mut run, 0);
        std::fs::write(f.root.join("a.txt"), "user\n").unwrap();
        assert!(integrate(&run, &f.data).is_err());
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "user\n"
        );
    }
    #[test]
    fn discard_validates_all_paths_before_removing_any_worktree() {
        let f = Repository::new();
        let mut run = f.run(vec![writable("a", &[])]);
        let branch = f.branch(&mut run, 0);
        std::fs::write(branch.join("a.txt"), "worker\n").unwrap();
        f.artifact(&mut run, 0);
        let patch = run.nodes[0].patch_path.clone().unwrap();
        run.nodes[0].patch_path = Some(f.root.join("a.txt").to_string_lossy().into_owned());
        assert!(discard(&run, &f.data).is_err());
        assert!(branch.is_dir());
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "base\n"
        );
        run.nodes[0].patch_path = Some(patch.clone());
        discard(&run, &f.data).unwrap();
        assert!(!branch.exists());
        assert!(!Path::new(&patch).exists());
        assert!(f.root.join("a.txt").exists());
    }
}
