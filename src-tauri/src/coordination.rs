//! Durable public context metadata and conservative local execution ownership.
use crate::store::Store;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

pub(crate) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id, created_at, id);
         CREATE INDEX IF NOT EXISTS tasks_native_session ON tasks(harness, session_id);
         CREATE TABLE IF NOT EXISTS runtime_bindings (
             conversation_id TEXT NOT NULL, harness TEXT NOT NULL, cwd TEXT NOT NULL,
             session_id TEXT NOT NULL, task_id TEXT NOT NULL, cursor_task_id TEXT,
             status TEXT NOT NULL, updated_at INTEGER NOT NULL,
             PRIMARY KEY(conversation_id, harness, cwd));
         CREATE TABLE IF NOT EXISTS context_deliveries (
             task_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
             strategy TEXT NOT NULL, source_ids TEXT NOT NULL, resume_task_id TEXT,
             status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER);
         CREATE TABLE IF NOT EXISTS conversation_state (
             conversation_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
             goal TEXT NOT NULL, notes TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS recovery_blocks (
              task_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS context_policies (
              conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS graph_runs (
              id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS execution_overrides (
               run_id TEXT NOT NULL, target TEXT NOT NULL, version INTEGER NOT NULL,
               config TEXT NOT NULL, PRIMARY KEY(run_id,target));
         WITH ranked AS (
             SELECT id,ROW_NUMBER() OVER(PARTITION BY conversation_id ORDER BY created_at,id) AS seq
             FROM tasks WHERE conversation_id IS NOT NULL)
         UPDATE tasks SET conversation_seq=(SELECT seq FROM ranked WHERE ranked.id=tasks.id)
             WHERE conversation_id IS NOT NULL AND conversation_seq IS NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS tasks_conversation_sequence ON tasks(conversation_id,conversation_seq);",
    )
    .map_err(|e| e.to_string())
}

// Hold an exclusive lock on a separate SQLite file for the entire app lifetime.
pub(crate) struct InstanceGuard {
    _connection: Mutex<Connection>,
}
impl InstanceGuard {
    pub(crate) fn acquire(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS instance_owner (id INTEGER PRIMARY KEY);
             BEGIN EXCLUSIVE;",
            )
            .map_err(|_| "AgentDeck 已有实例使用此数据目录，请先关闭另一个实例".to_string())?;
        Ok(Self {
            _connection: Mutex::new(connection),
        })
    }
}

pub(crate) fn directory_key(cwd: &str) -> Result<String, String> {
    let path = std::fs::canonicalize(cwd).map_err(|e| format!("工作目录不可用：{e}"))?;
    let key = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        Ok(key.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(key)
    }
}

pub(crate) struct WorkspaceLease {
    key: String,
    owner: String,
    registry: Arc<Mutex<HashMap<String, String>>>,
}
impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            if registry.get(&self.key) == Some(&self.owner) {
                registry.remove(&self.key);
            }
        }
    }
}

pub(crate) fn refresh_binding(conn: &Connection, task_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO runtime_bindings(conversation_id,harness,cwd,session_id,task_id,cursor_task_id,status,updated_at)
         SELECT conversation_id,harness,cwd,session_id,id,CASE WHEN status = 'done' THEN id END,status,created_at
         FROM tasks WHERE id = ?1 AND conversation_id IS NOT NULL AND session_id IS NOT NULL AND session_id != ''
         ON CONFLICT(conversation_id,harness,cwd) DO UPDATE SET
           session_id=excluded.session_id, task_id=excluded.task_id, cursor_task_id=excluded.cursor_task_id,
           status=excluded.status, updated_at=excluded.updated_at
         WHERE COALESCE((SELECT conversation_seq FROM tasks WHERE id=excluded.task_id),0)
           >= COALESCE((SELECT conversation_seq FROM tasks WHERE id=runtime_bindings.task_id),0)",
        params![task_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn remove_task_metadata(conn: &Connection, task_id: &str) -> Result<(), String> {
    for sql in [
        "DELETE FROM context_deliveries WHERE task_id = ?1",
        "DELETE FROM recovery_blocks WHERE task_id = ?1",
        "DELETE FROM graph_runs WHERE json_extract(data,'$.source_task_id')=?1 OR EXISTS
             (SELECT 1 FROM json_each(data,'$.nodes') WHERE json_extract(value,'$.task_id')=?1)",
        "DELETE FROM runtime_bindings WHERE task_id = ?1",
        "DELETE FROM collaborations WHERE json_extract(data,'$.source_task_id')=?1 OR EXISTS
            (SELECT 1 FROM json_each(data,'$.task_ids') WHERE value=?1)",
    ] {
        conn.execute(sql, params![task_id])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "DELETE FROM conversation_state WHERE conversation_id NOT IN
        (SELECT conversation_id FROM tasks WHERE conversation_id IS NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM context_policies WHERE conversation_id NOT IN
        (SELECT conversation_id FROM tasks WHERE conversation_id IS NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM execution_overrides WHERE run_id NOT IN
        (SELECT id FROM graph_runs UNION SELECT id FROM collaborations)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings WHERE key LIKE 'execution:%' AND key NOT LIKE 'execution:default:%'
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE key LIKE 'execution:' || conversation_id || ':%')", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct RuntimeBinding {
    pub harness: String,
    pub cwd: String,
    pub session_id: String,
    pub task_id: String,
    pub cursor_task_id: Option<String>,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedState {
    pub version: i64,
    pub goal: String,
    pub notes: String,
}
#[derive(Serialize)]
pub struct ContextHit {
    pub task_id: String,
    pub harness: String,
    pub seq: i64,
    pub event: Value,
}
#[derive(Serialize)]
pub struct ContextPage {
    pub items: Vec<ContextHit>,
    pub next_offset: Option<i64>,
}
#[derive(Serialize)]
pub struct ConversationInfo {
    pub conversation_id: String,
    pub bindings: Vec<RuntimeBinding>,
    pub state: SharedState,
    pub recovery_task_ids: Vec<String>,
    pub deliveries: Vec<Value>,
}

pub(crate) struct LaunchOutcome {
    store: Store,
    id: String,
    dispatched: bool,
}
impl LaunchOutcome {
    pub(crate) fn new(store: &Store, id: &str) -> Self {
        Self {
            store: store.clone_handle(),
            id: id.into(),
            dispatched: false,
        }
    }
    pub(crate) fn dispatched(&mut self) {
        self.dispatched = true;
    }
}
impl Drop for LaunchOutcome {
    fn drop(&mut self) {
        if !self.dispatched {
            let _ = self.store.append_event(&self.id, &json!({
                "type":"error","kind":"launch","message":"任务启动未完成，请检查启动错误后重试。"
            }).to_string());
            self.store.finish_task(&self.id, "failed", None);
        }
    }
}

impl Store {
    pub(crate) fn claim_workspace(&self, cwd: &str, owner: &str) -> Result<WorkspaceLease, String> {
        let key = directory_key(cwd)?;
        let mut registry = self
            .workspace_owners
            .lock()
            .map_err(|_| "workspace registry poisoned")?;
        if registry.contains_key(&key) {
            return Err("该工作目录已有执行或协作占用，请等待结束".into());
        }
        let directories = {
            let conn = self.conn.lock().map_err(|_| "store poisoned")?;
            let mut stmt = conn
                .prepare("SELECT cwd FROM tasks WHERE status='running'")
                .map_err(|e| e.to_string())?;
            stmt.query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if directories
            .iter()
            .any(|cwd| directory_key(cwd).ok().as_deref() == Some(&key))
        {
            return Err("该工作目录已有执行者运行中".into());
        }
        self.check_recovery(cwd)?;
        registry.insert(key.clone(), owner.into());
        Ok(WorkspaceLease {
            key,
            owner: owner.into(),
            registry: self.workspace_owners.clone(),
        })
    }

    pub(crate) fn authorize_workflow(&self, cwd: &str, owner: &str) -> Result<(), String> {
        let key = directory_key(cwd)?;
        let registry = self
            .workspace_owners
            .lock()
            .map_err(|_| "workspace registry poisoned")?;
        if registry.get(&key).map(String::as_str) != Some(owner) {
            return Err("协作执行租约已失效".into());
        }
        self.check_recovery(cwd)
    }

    fn check_recovery(&self, cwd: &str) -> Result<(), String> {
        let key = directory_key(cwd)?;
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare("SELECT cwd FROM recovery_blocks")
            .map_err(|e| e.to_string())?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for path in paths {
            if directory_key(&path.map_err(|e| e.to_string())?)
                .ok()
                .as_deref()
                == Some(&key)
            {
                return Err(
                    "上次运行异常中断——到任务详情勾选「已确认旧执行者结束，并核对工作区改动」即可解锁本目录".into(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn recover_interrupted(&self) -> Result<usize, String> {
        let mut conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let ids = {
            let mut stmt = tx
                .prepare("SELECT id FROM tasks WHERE status='running'")
                .map_err(|e| e.to_string())?;
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for id in &ids {
            tx.execute(
                "INSERT OR IGNORE INTO recovery_blocks SELECT id,cwd,?2 FROM tasks WHERE id=?1",
                params![id, Store::now_millis()],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE tasks SET status='failed',exit_code=NULL,finished_at=?2 WHERE id=?1",
                params![id, Store::now_millis()],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO task_events SELECT ?1,COALESCE(MAX(seq),0)+1,?2 FROM task_events WHERE task_id=?1",
                params![id, json!({"type":"error","kind":"interrupted","message":"上次运行异常中断；核对遗留进程与工作区后再继续。","ts":Store::now_millis()}).to_string()])
                .map_err(|e| e.to_string())?;
            refresh_binding(&tx, id)?;
        }
        tx.execute("UPDATE context_deliveries SET status='interrupted',finished_at=?1 WHERE status='pending'",
            params![Store::now_millis()]).map_err(|e| e.to_string())?;
        let runs = {
            let mut stmt = tx
                .prepare("SELECT id,data FROM collaborations WHERE json_valid(data) AND json_extract(data,'$.status')='running'")
                .map_err(|e| e.to_string())?;
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (id, data) in runs {
            let mut run: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            if run["status"] == "running" {
                run["status"] = json!("needs_attention");
                run["error"] = json!("应用重启中断了协作；请核对已有成果后重新安排，不自动重跑。");
                tx.execute(
                    "UPDATE collaborations SET data=?2 WHERE id=?1",
                    params![id, run.to_string()],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let graphs = {
            let mut stmt = tx
                .prepare(
                    "SELECT id,data FROM graph_runs WHERE json_extract(data,'$.status')='running'",
                )
                .map_err(|e| e.to_string())?;
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (id, raw) in graphs {
            let mut run: crate::orchestration::GraphRun =
                serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO recovery_blocks VALUES(?1,?2,?3)",
                params![run.source_task_id, run.cwd, Store::now_millis()],
            )
            .map_err(|e| e.to_string())?;
            run.status = "needs_attention".into();
            run.error = Some("应用重启中断了任务图；保留工作树和成果，不自动重跑".into());
            for node in &mut run.nodes {
                if matches!(node.status.as_str(), "pending" | "running") {
                    node.status = "interrupted".into();
                }
            }
            tx.execute(
                "UPDATE graph_runs SET data=?2 WHERE id=?1",
                params![id, serde_json::to_string(&run).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(ids.len())
    }

    pub(crate) fn confirm_recovery(&self, task_id: &str) -> Result<(), String> {
        let row = self.get_task(task_id)?.ok_or("任务不存在")?;
        if row.status == "running" {
            return Err("不能确认仍在运行的任务".into());
        }
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "DELETE FROM recovery_blocks WHERE task_id=?1",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn reset_binding(&self, task_id: &str, harness: &str) -> Result<(), String> {
        if harness != "deck" {
            crate::executors::Harness::parse(harness)?;
        }
        let id = self.ensure_conversation(task_id)?;
        let _launch = self.claim_conversation(&id)?;
        let row = self.get_task(task_id)?.ok_or("任务不存在")?;
        let _workspace = self.claim_workspace(&row.cwd, "reset-binding")?;
        let mut conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE tasks SET session_id=NULL WHERE conversation_id=?1 AND harness=?2",
            params![id, harness],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM runtime_bindings WHERE conversation_id=?1 AND harness=?2",
            params![id, harness],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub(crate) fn record_delivery(
        &self,
        task_id: &str,
        conversation_id: &str,
        event: &Value,
    ) -> Result<(), String> {
        let sync = &event["context_sync"];
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
             "INSERT INTO context_deliveries(task_id,conversation_id,strategy,source_ids,resume_task_id,status,created_at,finished_at)
              SELECT ?1,?2,?3,?4,?5,CASE WHEN status='running' THEN 'pending' ELSE status END,?6,finished_at
              FROM tasks WHERE id=?1",
            params![task_id,conversation_id,sync["strategy"].as_str().unwrap_or("replay"),
                sync["task_ids"].to_string(),sync["resume_task_id"].as_str(),Store::now_millis()]
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn shared_state(&self, conversation_id: &str) -> Result<SharedState, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.query_row(
            "SELECT version,goal,notes FROM conversation_state WHERE conversation_id=?1",
            params![conversation_id],
            |row| {
                Ok(SharedState {
                    version: row.get(0)?,
                    goal: row.get(1)?,
                    notes: row.get(2)?,
                })
            },
        )
        .optional()
        .map(|v| {
            v.unwrap_or(SharedState {
                version: 0,
                goal: String::new(),
                notes: String::new(),
            })
        })
        .map_err(|e| e.to_string())
    }

    pub(crate) fn update_shared_state(
        &self,
        conversation_id: &str,
        expected: i64,
        goal: &str,
        notes: &str,
    ) -> Result<SharedState, String> {
        if goal.len() + notes.len() > 32_000 {
            return Err("共享任务状态过长".into());
        }
        let mut conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let version = tx
            .query_row(
                "SELECT version FROM conversation_state WHERE conversation_id=?1",
                params![conversation_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if expected != version {
            return Err("共享任务状态已更新，请刷新后再保存".into());
        }
        tx.execute(
            "INSERT INTO conversation_state VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(conversation_id) DO UPDATE SET version=excluded.version,goal=excluded.goal,notes=excluded.notes,updated_at=excluded.updated_at",
            params![conversation_id,version+1,goal,notes,Store::now_millis()]
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(SharedState {
            version: version + 1,
            goal: goal.into(),
            notes: notes.into(),
        })
    }

    pub(crate) fn conversation_info(&self, task_id: &str) -> Result<ConversationInfo, String> {
        let conversation_id = self.ensure_conversation(task_id)?;
        let state = self.shared_state(&conversation_id)?;
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT OR IGNORE INTO runtime_bindings
             SELECT conversation_id,harness,cwd,session_id,id,CASE WHEN status='done' THEN id END,status,created_at
             FROM tasks WHERE conversation_id=?1 AND session_id IS NOT NULL AND session_id!=''
             ORDER BY conversation_seq DESC,created_at DESC,id DESC",params![conversation_id]
        ).map_err(|e| e.to_string())?;
        let bindings = conn.prepare(
            "SELECT harness,cwd,session_id,task_id,cursor_task_id,status FROM runtime_bindings WHERE conversation_id=?1"
        ).map_err(|e| e.to_string())?.query_map(params![conversation_id], |r| Ok(RuntimeBinding {
            harness:r.get(0)?,cwd:r.get(1)?,session_id:r.get(2)?,task_id:r.get(3)?,cursor_task_id:r.get(4)?,status:r.get(5)?
        })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
        let recovery_task_ids = conn.prepare(
            "SELECT b.task_id FROM recovery_blocks b JOIN tasks t ON t.id=b.task_id WHERE t.conversation_id=?1"
        ).map_err(|e| e.to_string())?.query_map(params![conversation_id], |r| r.get(0))
            .map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
        let deliveries = conn.prepare(
            "SELECT task_id,strategy,source_ids,status FROM context_deliveries WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 30"
        ).map_err(|e| e.to_string())?.query_map(params![conversation_id], |r| Ok(json!({
            "task_id":r.get::<_,String>(0)?,"strategy":r.get::<_,String>(1)?,
            "source_ids":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?
        }))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
        Ok(ConversationInfo {
            conversation_id,
            bindings,
            state,
            recovery_task_ids,
            deliveries,
        })
    }

    pub(crate) fn context_page(
        &self,
        task_id: &str,
        query: &str,
        offset: i64,
        limit: i64,
    ) -> Result<ContextPage, String> {
        if query.len() > 512 || offset < 0 {
            return Err("历史查询参数无效".into());
        }
        let limit = limit.clamp(1, 50);
        let conversation_id = self.ensure_conversation(task_id)?;
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn.prepare(
            "SELECT t.id,t.harness,e.seq,e.event FROM task_events e JOIN tasks t ON t.id=e.task_id
             WHERE t.conversation_id=?1 AND (?2='' OR instr(lower(e.event),lower(?2))>0)
             ORDER BY t.conversation_seq,t.created_at,t.id,e.seq LIMIT ?3 OFFSET ?4"
        ).map_err(|e| e.to_string())?;
        let mut items = stmt
            .query_map(params![conversation_id, query, limit + 1, offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .map(|item| {
                let (task_id, harness, seq, event) = item.map_err(|e| e.to_string())?;
                Ok(ContextHit {
                    task_id,
                    harness,
                    seq,
                    event: serde_json::from_str(&event).map_err(|e| e.to_string())?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let next_offset = (items.len() > limit as usize).then_some(offset + limit);
        items.truncate(limit as usize);
        Ok(ContextPage { items, next_offset })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        store: Store,
        dir: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentdeck-coordination-{}",
                crate::pi_session_task_id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self {
                store: Store::in_memory().unwrap(),
                dir,
            }
        }
        fn task(&self, id: &str, harness: &str, status: &str) {
            self.store
                .create_task(
                    id,
                    harness,
                    self.dir.to_str().unwrap(),
                    id,
                    None,
                    None,
                    None,
                )
                .unwrap();
            self.store.set_task_conversation(id, "a").unwrap();
            self.store
                .set_session_id(id, &format!("{harness}-handle"))
                .unwrap();
            self.store.finish_task(id, status, None);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn instance_lock_excludes_other_connections_and_releases_on_drop() {
        let f = Fixture::new();
        let path = f.dir.join("instance.db");
        let first = InstanceGuard::acquire(&path).unwrap();
        assert!(InstanceGuard::acquire(&path).is_err());
        drop(first);
        assert!(InstanceGuard::acquire(&path).is_ok());
    }

    #[test]
    fn native_bindings_keep_per_harness_handles_and_successful_cursors() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        f.task("b", "codex", "done");
        f.task("c", "zcode", "failed");
        let info = f.store.conversation_info("b").unwrap();
        assert_eq!(info.bindings.len(), 2);
        let z = info.bindings.iter().find(|b| b.harness == "zcode").unwrap();
        assert_eq!(z.session_id, "zcode-handle");
        assert_eq!(z.task_id, "c");
        assert!(z.cursor_task_id.is_none());
        assert_eq!(
            info.bindings
                .iter()
                .find(|b| b.harness == "codex")
                .unwrap()
                .cursor_task_id
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn workflow_owns_directory_between_phases_and_aliases_do_not_bypass_it() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        let cwd = f.dir.to_str().unwrap();
        let lease = f.store.claim_workspace(cwd, "flow").unwrap();
        assert!(
            f.store
                .claim_workspace(f.dir.join(".").to_str().unwrap(), "manual")
                .is_err()
        );
        assert!(f.store.authorize_workflow(cwd, "flow").is_ok());
        assert!(f.store.authorize_workflow(cwd, "other").is_err());
        drop(lease);
        assert!(f.store.claim_workspace(cwd, "manual").is_ok());
        f.task("b", "codex", "running");
        assert!(f.store.claim_workspace(cwd, "manual").is_err());
    }

    #[test]
    fn interrupted_restart_is_idempotent_and_requires_explicit_workspace_confirmation() {
        let f = Fixture::new();
        f.task("a", "zcode", "running");
        f.store
            .save_collaboration("flow", &json!({"id":"flow","status":"running"}).to_string())
            .unwrap();
        f.store
            .record_delivery(
                "a",
                "a",
                &json!({"context_sync":{"strategy":"replay","task_ids":[]}}),
            )
            .unwrap();
        assert_eq!(f.store.recover_interrupted().unwrap(), 1);
        assert_eq!(f.store.recover_interrupted().unwrap(), 0);
        assert_eq!(f.store.get_task("a").unwrap().unwrap().status, "failed");
        assert_eq!(f.store.get_events("a", 0, 100).unwrap().len(), 1);
        let info = f.store.conversation_info("a").unwrap();
        assert_eq!(info.recovery_task_ids, vec!["a"]);
        assert_eq!(info.deliveries[0]["status"], "interrupted");
        assert!(
            f.store
                .claim_workspace(f.dir.to_str().unwrap(), "manual")
                .is_err()
        );
        assert!(
            f.store
                .get_collaboration("flow")
                .unwrap()
                .unwrap()
                .contains("needs_attention")
        );
        assert!(f.store.delete_task("a").is_err());
        assert!(f.store.get_task("a").unwrap().is_some());
        f.store.confirm_recovery("a").unwrap();
        assert!(
            f.store
                .claim_workspace(f.dir.to_str().unwrap(), "manual")
                .is_ok()
        );
    }

    #[test]
    fn shared_state_uses_compare_and_swap_and_rejects_stale_writers() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        assert_eq!(f.store.shared_state("a").unwrap().version, 0);
        let state = f
            .store
            .update_shared_state("a", 0, "检查支付", "不修改支付模块")
            .unwrap();
        assert_eq!(state.version, 1);
        assert!(f.store.update_shared_state("a", 0, "覆盖目标", "").is_err());
        assert_eq!(f.store.shared_state("a").unwrap().notes, "不修改支付模块");
        assert!(
            f.store
                .update_shared_state("a", 1, &"x".repeat(32_001), "")
                .is_err()
        );
    }

    #[test]
    fn context_search_is_paginated_literal_and_scoped_to_one_conversation() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        f.task("b", "codex", "done");
        f.task("other", "codex", "done");
        f.store.set_task_conversation("other", "other").unwrap();
        for id in ["a", "b", "other"] {
            f.store
                .append_event(
                    id,
                    &json!({"type":"user_message","text":"早期约束 100%_literal"}).to_string(),
                )
                .unwrap();
        }
        let first = f.store.context_page("a", "100%_", 0, 1).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].task_id, "a");
        let second = f
            .store
            .context_page("a", "100%_", first.next_offset.unwrap(), 1)
            .unwrap();
        assert_eq!(second.items[0].task_id, "b");
        assert!(second.next_offset.is_none());
        assert!(f.store.context_page("a", "", -1, 1).is_err());
    }

    #[test]
    fn deletion_cleans_metadata_and_late_events_cannot_resurrect_a_task() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        f.store.update_shared_state("a", 0, "目标", "").unwrap();
        f.store
            .record_delivery(
                "a",
                "a",
                &json!({"context_sync":{"strategy":"replay","task_ids":[]}}),
            )
            .unwrap();
        f.store.delete_task("a").unwrap();
        f.store
            .append_event(
                "a",
                &json!({"type":"assistant_message","text":"迟到事件"}).to_string(),
            )
            .unwrap();
        assert!(f.store.get_events("a", 0, 100).unwrap().is_empty());
        let conn = f.store.conn.lock().unwrap();
        for table in [
            "runtime_bindings",
            "context_deliveries",
            "conversation_state",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn branch_dispatch_and_deletion_exclude_each_other_across_store_handles() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        f.task("b", "codex", "running");
        let branch = f.store.claim_branch_launch("a").unwrap();
        let other = f.store.clone_handle();
        std::thread::spawn(move || {
            assert!(other.claim_conversation_mutation("a").is_err());
            assert!(other.claim_branch_launch("b").is_err());
        })
        .join()
        .unwrap();
        drop(branch);
        let deletion = f.store.claim_conversation_mutation("a").unwrap();
        let other = f.store.clone_handle();
        std::thread::spawn(move || {
            assert!(other.claim_branch_launch("b").is_err());
        })
        .join()
        .unwrap();
        f.store.delete_tasks(&["a".into(), "b".into()]).unwrap();
        drop(deletion);
        assert!(f.store.claim_branch_launch("a").is_err());
        assert!(f.store.claim_branch_launch("b").is_err());
    }

    #[test]
    fn failed_branch_reservation_releases_the_conversation_guard() {
        let f = Fixture::new();
        f.task("b", "codex", "done");
        assert!(f.store.claim_branch_launch("b").is_err());
        f.task("a", "zcode", "done");
        assert!(f.store.claim_branch_launch("b").is_ok());
    }

    #[test]
    fn launch_failures_never_leave_a_permanent_running_task() {
        let f = Fixture::new();
        f.task("a", "zcode", "running");
        drop(LaunchOutcome::new(&f.store, "a"));
        assert_eq!(f.store.get_task("a").unwrap().unwrap().status, "failed");
        f.task("b", "codex", "running");
        let mut outcome = LaunchOutcome::new(&f.store, "b");
        outcome.dispatched();
        drop(outcome);
        assert_eq!(f.store.get_task("b").unwrap().unwrap().status, "running");
    }

    #[test]
    fn resetting_a_binding_preserves_evidence_and_does_not_touch_other_harnesses() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        f.task("b", "codex", "done");
        f.store
            .append_event(
                "a",
                &json!({"type":"user_message","text":"保留完整原文"}).to_string(),
            )
            .unwrap();
        f.store.reset_binding("a", "zcode").unwrap();
        assert!(f.store.get_task("a").unwrap().unwrap().session_id.is_none());
        assert_eq!(
            f.store
                .get_task("b")
                .unwrap()
                .unwrap()
                .session_id
                .as_deref(),
            Some("codex-handle")
        );
        assert!(f.store.get_events("a", 0, 100).unwrap()[0].contains("保留完整原文"));
        f.task("c", "codex", "running");
        assert!(f.store.reset_binding("a", "zcode").is_err());
    }

    #[test]
    fn logical_sequence_survives_equal_timestamps_and_clock_changes() {
        let f = Fixture::new();
        f.task("a", "zcode", "done");
        f.task("z-later", "codex", "done");
        f.task("b-last", "zcode", "done");
        f.store
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE tasks SET created_at=1", [])
            .unwrap();
        let turns =
            crate::conversation::through_task(f.store.session_tasks("b-last").unwrap(), "z-later")
                .unwrap();
        assert_eq!(
            turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "z-later"]
        );
        let info = f.store.conversation_info("a").unwrap();
        assert_eq!(
            info.bindings
                .iter()
                .find(|b| b.harness == "zcode")
                .unwrap()
                .task_id,
            "b-last"
        );
    }

    #[test]
    fn existing_conversations_receive_sequences_when_reopened() {
        let f = Fixture::new();
        let path = f.dir.join("legacy.db");
        let store = Store::open(&path).unwrap();
        for id in ["a", "b"] {
            store
                .create_task(id, "codex", f.dir.to_str().unwrap(), id, None, None, None)
                .unwrap();
            store.set_task_conversation(id, "a").unwrap();
        }
        store
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE tasks SET conversation_seq=NULL", [])
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.get_task("a").unwrap().unwrap().conversation_seq,
            Some(1)
        );
        assert_eq!(
            store.get_task("b").unwrap().unwrap().conversation_seq,
            Some(2)
        );
    }
}
