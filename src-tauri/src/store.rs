//! 持久化层：SQLite 存任务与事件流，支撑历史查看与会话续接。
//!
//! Connection 不是 Sync，用 Mutex 包一层；所有方法都是同步的，
//! 由调用方（tauri command / runner）自行决定是否放进异步上下文。

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ModelProfile {
    pub id: String,
    pub provider: String,
    pub label: Option<String>,
    pub api_key: String,
    pub base_url: Option<String>,
    /// 请求的模型 ID（OpenAI 兼容中转必需；空 = 通道默认）
    pub model: Option<String>,
    /// 上游协议：chat = Chat Completions（默认），responses = Responses API
    pub protocol: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
}

/// 供应商档案下的单个模型（中转服务式模型列表条目）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProfileModelRow {
    pub id: String,
    pub profile_id: String,
    pub model: String,
    pub context_window: Option<i64>,
    /// 最大输出 token（空 = 通道默认 8192）
    pub max_tokens: Option<i64>,
    /// 计费倍率（sub2api 模型广场 / new-api pricing 快照；空 = 未知）
    pub rate_multiplier: Option<f64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskRow {
    pub id: String,
    pub harness: String,
    pub cwd: String,
    pub prompt: String,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub base_branch: Option<String>,
    pub worktree_dir: Option<String>,
    /// 会话根任务 id：接力/续接轮次继承，跨 harness 归同一会话（空 = 旧数据，按 session 分组）
    pub conversation_id: Option<String>,
    pub conversation_seq: Option<i64>,
    pub execution_config: Option<serde_json::Value>,
    /// 附件绝对路径（JSON 数组；仅落档展示与重试，调用时逐家 CLI 转旗标）
    pub attachments: Option<String>,
    /// 轮次基线 manifest（任务开始时目录快照 JSON；产出面板按它判定本轮改动）
    pub baseline: Option<String>,
    /// running | done | failed | cancelled
    pub status: String,
    pub exit_code: Option<i64>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get(0)?,
        harness: row.get(1)?,
        cwd: row.get(2)?,
        prompt: row.get(3)?,
        mode: row.get(4)?,
        model: row.get(5)?,
        project_id: row.get(6)?,
        base_branch: row.get(7)?,
        worktree_dir: row.get(8)?,
        session_id: row.get(9)?,
        conversation_id: row.get(10)?,
        attachments: row.get(11)?,
        baseline: row.get(12)?,
        status: row.get(13)?,
        exit_code: row.get(14)?,
        created_at: row.get(15)?,
        finished_at: row.get(16)?,
        conversation_seq: row.get(17)?,
        execution_config: row
            .get::<_, Option<String>>(18)?
            .and_then(|raw| serde_json::from_str(&raw).ok()),
    })
}

pub struct Store {
    pub(crate) conn: Arc<Mutex<Connection>>,
    conversation_launches: Arc<Mutex<HashSet<String>>>,
    pub(crate) workspace_owners: Arc<Mutex<std::collections::HashMap<String, String>>>,
}

pub(crate) struct ConversationLaunch {
    id: String,
    launches: Arc<Mutex<HashSet<String>>>,
}

impl Drop for ConversationLaunch {
    fn drop(&mut self) {
        if let Ok(mut launches) = self.launches.lock() {
            launches.remove(&self.id);
        }
    }
}

impl Clone for Store {
    fn clone(&self) -> Self {
        Self {
            conn: self.conn.clone(),
            conversation_launches: self.conversation_launches.clone(),
            workspace_owners: self.workspace_owners.clone(),
        }
    }
}

impl Store {
    /// 克隆一个共享同一连接的句柄（供异步任务持有）。
    pub fn clone_handle(&self) -> Store {
        self.clone()
    }

    pub(crate) fn claim_branch_launch(&self, task_id: &str) -> Result<ConversationLaunch, String> {
        let id = self.ensure_conversation(task_id)?;
        let mut launches = self
            .conversation_launches
            .lock()
            .map_err(|_| "conversation registry poisoned")?;
        if !launches.insert(id.clone()) {
            return Err("会话正在派发或删除，请等待当前操作结束".into());
        }
        let guard = ConversationLaunch {
            id: id.clone(),
            launches: self.conversation_launches.clone(),
        };
        drop(launches);
        if self.get_task(&id)?.is_none() {
            return Err("会话根任务已删除，不能派发隔离任务".into());
        }
        Ok(guard)
    }

    /// 打开（或创建）数据库并确保表结构存在。
    pub(crate) fn conversation_mutating(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .conversation_launches
            .lock()
            .map_err(|_| "conversation registry poisoned")?
            .contains(id))
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::with_connection(conn)
    }

    /// 测试用：内存数据库。
    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        Self::with_connection(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn with_connection(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS tasks (
                 id          TEXT PRIMARY KEY,
                 harness     TEXT NOT NULL,
                 cwd         TEXT NOT NULL,
                 prompt      TEXT NOT NULL,
                 mode        TEXT,
                 model       TEXT,
                 session_id  TEXT,
                 status      TEXT NOT NULL DEFAULT 'running',
                 exit_code   INTEGER,
                 created_at  INTEGER NOT NULL,
                 finished_at INTEGER
             );
              CREATE TABLE IF NOT EXISTS task_events (
                 task_id TEXT NOT NULL,
                 seq     INTEGER NOT NULL,
                 event   TEXT NOT NULL,
                 PRIMARY KEY (task_id, seq)
              );
              CREATE TABLE IF NOT EXISTS collaborations (
                  id TEXT PRIMARY KEY,
                  data TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
              );
             CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS memories (
                 id         TEXT PRIMARY KEY,
                 cwd        TEXT NOT NULL,
                 content    TEXT NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS projects (
                 id         TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 dir        TEXT NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS model_profiles (
                 id         TEXT PRIMARY KEY,
                 provider   TEXT NOT NULL,
                 label      TEXT,
                 api_key    TEXT NOT NULL,
                 base_url   TEXT,
                 model      TEXT,
                 protocol   TEXT,
                 enabled    INTEGER NOT NULL DEFAULT 1,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS profile_models (
                 id             TEXT PRIMARY KEY,
                 profile_id     TEXT NOT NULL,
                 model          TEXT NOT NULL,
                 context_window INTEGER,
                 max_tokens     INTEGER,
                 rate_multiplier REAL,
                 created_at     INTEGER NOT NULL
             );",
        )
        .map_err(|e| e.to_string())?;
        // 既有数据库补列（重复执行报 duplicate column，忽略即可）
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN base_branch TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN base_commit TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN worktree_dir TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN conversation_id TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN conversation_seq INTEGER", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN execution_config TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN baseline TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN attachments TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN project_id TEXT", []);
        let _ = conn.execute("ALTER TABLE model_profiles ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE model_profiles ADD COLUMN protocol TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE profile_models ADD COLUMN rate_multiplier REAL",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE profile_models ADD COLUMN max_tokens INTEGER",
            [],
        );
        crate::coordination::initialize(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            conversation_launches: Arc::new(Mutex::new(HashSet::new())),
            workspace_owners: Arc::new(Mutex::new(std::collections::HashMap::new())),
        })
    }

    pub(crate) fn now_millis() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &self,
        id: &str,
        harness: &str,
        cwd: &str,
        prompt: &str,
        mode: Option<&str>,
        model: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT INTO tasks (id, harness, cwd, prompt, mode, model, project_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                harness,
                cwd,
                prompt,
                mode,
                model,
                project_id,
                Self::now_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 标记任务所属会话（根任务 id）；接力/续接轮次继承根会话。
    pub fn set_task_conversation(
        &self,
        task_id: &str,
        conversation_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET conversation_seq = CASE
                WHEN conversation_id IS ?2 AND conversation_seq IS NOT NULL THEN conversation_seq
                ELSE COALESCE((SELECT MAX(conversation_seq) FROM tasks WHERE conversation_id=?2),0)+1 END,
                conversation_id = ?2 WHERE id = ?1",
            params![task_id, conversation_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM runtime_bindings WHERE task_id=?1 AND conversation_id!=?2",
            params![task_id, conversation_id],
        )
        .map_err(|e| e.to_string())?;
        crate::coordination::refresh_binding(&conn, task_id)?;
        Ok(())
    }

    pub(crate) fn ensure_conversation(&self, task_id: &str) -> Result<String, String> {
        let row = self.get_task(task_id)?.ok_or("会话不存在")?;
        if let Some(id) = row.conversation_id.filter(|id| !id.is_empty()) {
            return Ok(id);
        }
        let mut turns = self.session_tasks(task_id)?;
        turns.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        let id = turns.first().ok_or("会话没有任务")?.id.clone();
        let mut conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (index, turn) in turns.into_iter().enumerate() {
            tx.execute(
                "UPDATE tasks SET conversation_id = ?2, conversation_seq=?3 WHERE id = ?1 AND conversation_id IS NULL",
                params![turn.id, id, index as i64 + 1],
            ).map_err(|e| e.to_string())?;
            crate::coordination::refresh_binding(&tx, &turn.id)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    // Hold an owned reservation across process startup; never hold a MutexGuard across await.
    pub(crate) fn claim_conversation(&self, id: &str) -> Result<ConversationLaunch, String> {
        let guard = self.claim_conversation_mutation(id)?;
        let running = self
            .conn
            .lock()
            .map_err(|_| "store poisoned")?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE conversation_id=?1 AND status='running')",
                params![id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?;
        if running {
            return Err("当前会话已有执行者运行中，请等待结束或停止后再接力".into());
        }
        Ok(guard)
    }

    pub(crate) fn claim_conversation_mutation(
        &self,
        id: &str,
    ) -> Result<ConversationLaunch, String> {
        let mut launches = self
            .conversation_launches
            .lock()
            .map_err(|_| "conversation registry poisoned")?;
        if launches.contains(id) {
            return Err("当前会话正在启动或变更，请稍后重试".into());
        }
        launches.insert(id.to_string());
        Ok(ConversationLaunch {
            id: id.to_string(),
            launches: self.conversation_launches.clone(),
        })
    }

    /// 落档附件路径列表（JSON 数组）。
    /// 轮次基线：任务开始时的目录快照（manifest），产出面板按它判定本轮改动。
    pub fn set_task_baseline(&self, task_id: &str, baseline: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET baseline = ?2 WHERE id = ?1",
            params![task_id, baseline],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_task_attachments(&self, task_id: &str, attachments: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET attachments = ?2 WHERE id = ?1",
            params![task_id, attachments],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_session_id(&self, task_id: &str, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET session_id = ?2 WHERE id = ?1",
            params![task_id, session_id],
        )
        .map_err(|e| e.to_string())?;
        crate::coordination::refresh_binding(&conn, task_id)?;
        Ok(())
    }

    /// 结束任务：status = done | failed | cancelled。
    pub fn finish_task(&self, task_id: &str, status: &str, exit_code: Option<i64>) {
        let Ok(conn) = self.conn.lock() else { return };
        let _ = conn.execute(
            "UPDATE tasks SET status = ?2, exit_code = ?3, finished_at = ?4 WHERE id = ?1",
            params![task_id, status, exit_code, Self::now_millis()],
        );
        let _ = crate::coordination::refresh_binding(&conn, task_id);
        let _ = conn.execute(
            "UPDATE context_deliveries SET status = ?2, finished_at = ?3 WHERE task_id = ?1",
            params![task_id, status, Self::now_millis()],
        );
    }

    pub fn append_event(&self, task_id: &str, event_json: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        // 入库统一携带 ingest 时间戳（ms）：思考/轮次耗时的数据源。
        // 事件自带 ts（pi timestamp）则保留；解析失败原样入库。
        let stamped = serde_json::from_str::<serde_json::Value>(event_json)
            .map(|mut v| {
                if v.get("ts").is_none() {
                    if let Ok(obj) = v.as_object_mut().ok_or(()) {
                        obj.insert("ts".into(), serde_json::json!(Self::now_millis()));
                    }
                }
                v.to_string()
            })
            .unwrap_or_else(|_| event_json.to_string());
        // 热路径（每条事件一次）：prepare_cached 避免逐条重复编译 SQL
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO task_events (task_id, seq, event)
                 SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2 FROM task_events WHERE task_id = ?1
                 HAVING EXISTS (SELECT 1 FROM tasks WHERE id = ?1)",
            )
            .map_err(|e| e.to_string())?;
        stmt.execute(params![task_id, stamped])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_collaboration(&self, id: &str, data: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT INTO collaborations (id, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            params![id, data, Self::now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_collaboration(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.query_row(
            "SELECT data FROM collaborations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn list_collaborations(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare("SELECT data FROM collaborations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn list_tasks(&self, limit: i64) -> Result<Vec<TaskRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, harness, cwd, prompt, mode, model, project_id, base_branch, worktree_dir, session_id, conversation_id, attachments, baseline, status, exit_code,
                        created_at, finished_at, conversation_seq, execution_config
                 FROM tasks ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], task_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, harness, cwd, prompt, mode, model, project_id, base_branch, worktree_dir, session_id, conversation_id, attachments, baseline, status, exit_code,
                        created_at, finished_at, conversation_seq, execution_config
                 FROM tasks WHERE id = ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_row(params![task_id], task_from_row)
            .optional()
            .map_err(|e| e.to_string())
    }

    // ── 设置（键值对，如 API key） ──────────────────────────────

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    // ── 模型配置档案（多供应商，用户启停） ─────────────────────

    pub fn list_model_profiles(&self, enabled_only: bool) -> Result<Vec<ModelProfile>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let sql = if enabled_only {
            "SELECT id, provider, label, api_key, base_url, model, protocol, enabled, created_at
             FROM model_profiles WHERE enabled = 1 ORDER BY created_at ASC"
        } else {
            "SELECT id, provider, label, api_key, base_url, model, protocol, enabled, created_at
             FROM model_profiles ORDER BY created_at ASC"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ModelProfile {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    label: row.get(2)?,
                    api_key: row.get(3)?,
                    base_url: row.get(4)?,
                    model: row.get(5)?,
                    protocol: row.get(6)?,
                    enabled: row.get::<_, i64>(7)? != 0,
                    created_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    // ── worktree 登记（任务分支/base/directory） ────────────────

    pub fn set_task_worktree(
        &self,
        task_id: &str,
        branch: &str,
        base_commit: &str,
        dir: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET session_id = session_id, base_branch = ?2, base_commit = ?3, worktree_dir = ?4 WHERE id = ?1",
            params![task_id, branch, base_commit, dir],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── 项目实体（Codex 式：名称 + 源文件夹，任务挂靠） ─────────

    pub fn create_project(&self, id: &str, name: &str, dir: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT INTO projects (id, name, dir, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, dir, Self::now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare("SELECT id, name, dir, created_at FROM projects ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    dir: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// 删除任务及其全部事件（会话记录一并清除，不可恢复）。
    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        self.delete_tasks(&[id.to_owned()])
    }

    pub fn session_tasks(&self, task_id: &str) -> Result<Vec<TaskRow>, String> {
        let row = self
            .get_task(task_id)?
            .ok_or_else(|| format!("unknown task: {task_id}"))?;
        let cid = row.conversation_id.as_deref().filter(|id| !id.is_empty());
        let session = row.session_id.as_deref().filter(|id| !id.is_empty());
        if cid.is_none() && session.is_none() {
            return Ok(vec![row]);
        }
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let filter = if cid.is_some() {
            "conversation_id=?1"
        } else {
            "harness=?2 AND session_id=?1"
        };
        let sql = format!("SELECT id,harness,cwd,prompt,mode,model,project_id,base_branch,worktree_dir,
            session_id,conversation_id,attachments,baseline,status,exit_code,created_at,finished_at,conversation_seq,execution_config
            FROM tasks WHERE {filter} ORDER BY created_at DESC,id DESC");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = if let Some(id) = cid {
            stmt.query_map(params![id], task_from_row)
        } else {
            stmt.query_map(params![session, row.harness], task_from_row)
        }
        .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn delete_tasks(&self, ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            let blocked = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM recovery_blocks WHERE task_id=?1)",
                    params![id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())?;
            if blocked {
                return Err(
                    "该任务需要恢复确认：先到任务详情勾选「已确认旧执行者结束，并核对工作区改动」"
                        .into(),
                );
            }
            tx.execute("DELETE FROM task_events WHERE task_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            let changed = tx
                .execute("DELETE FROM tasks WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err(format!("任务不存在：{id}"));
            }
            crate::coordination::remove_task_metadata(&tx, id)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET project_id = NULL WHERE project_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn find_project_by_dir(&self, dir: &str) -> Result<Option<ProjectRow>, String> {
        let norm = |s: &str| s.replace("\\", "/");
        let all = self.list_projects()?;
        Ok(all.into_iter().find(|p| norm(&p.dir) == norm(dir)))
    }

    // ── 项目记忆（deck 任务完成后自动抽取，同项目召回） ──────

    /// 记忆写入路径：自动抽取已按运行契约暂缓（docs/RUNTIME.md），
    /// 保留方法与注入链路，恢复抽取时直接接线。
    #[allow(dead_code)]
    pub fn add_memory(&self, cwd: &str, content: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let id = format!(
            "mem-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        conn.execute(
            "INSERT INTO memories (id, cwd, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, cwd, content, Self::now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_memories(&self, cwd: &str, limit: i64) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT content FROM memories WHERE cwd = ?1
                 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![cwd, limit], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_model_profile(&self, id: &str) -> Result<Option<ModelProfile>, String> {
        self.list_model_profiles(false)
            .map(|all| all.into_iter().find(|p| p.id == id))
    }

    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_model_profile(
        &self,
        id: &str,
        provider: &str,
        label: Option<&str>,
        api_key: &str,
        base_url: Option<&str>,
        model: Option<&str>,
        protocol: Option<&str>,
        enabled: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT INTO model_profiles (id, provider, label, api_key, base_url, model, protocol, enabled, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                provider,
                label,
                api_key,
                base_url,
                model,
                protocol,
                enabled as i64,
                Self::now_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_model_profile_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE model_profiles SET enabled = ?2 WHERE id = ?1",
            params![id, enabled as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 编辑档案：provider/label/api_key/base_url 整体覆盖（enabled 不动，由开关单独管）。
    #[allow(clippy::too_many_arguments)]
    pub fn update_model_profile(
        &self,
        id: &str,
        provider: &str,
        label: Option<&str>,
        api_key: &str,
        base_url: Option<&str>,
        model: Option<&str>,
        protocol: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let changed = conn
            .execute(
                "UPDATE model_profiles
                 SET provider = ?2, label = ?3, api_key = ?4, base_url = ?5, model = ?6, protocol = ?7
                 WHERE id = ?1",
                params![id, provider, label, api_key, base_url, model, protocol],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("档案不存在：{id}"));
        }
        Ok(())
    }

    pub fn delete_model_profile(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute("DELETE FROM model_profiles WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM profile_models WHERE profile_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── 供应商的模型列表（参考中转服务配置：一供多模） ──────

    pub fn list_profile_models(&self, profile_id: &str) -> Result<Vec<ProfileModelRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, model, context_window, max_tokens, rate_multiplier, created_at
                 FROM profile_models WHERE profile_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![profile_id], |row| {
                Ok(ProfileModelRow {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    model: row.get(2)?,
                    context_window: row.get(3)?,
                    max_tokens: row.get(4)?,
                    rate_multiplier: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn add_profile_model(
        &self,
        profile_id: &str,
        model: &str,
        context_window: Option<i64>,
        max_tokens: Option<i64>,
    ) -> Result<ProfileModelRow, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let id = format!(
            "pm-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        conn.execute(
            "INSERT INTO profile_models (id, profile_id, model, context_window, max_tokens, rate_multiplier, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            params![id, profile_id, model, context_window, max_tokens, Self::now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(ProfileModelRow {
            id,
            profile_id: profile_id.into(),
            model: model.into(),
            context_window,
            max_tokens,
            rate_multiplier: None,
            created_at: Self::now_millis(),
        })
    }

    /// 编辑模型行：名称/上下文/最大输出整体覆盖；行不存在报错。
    pub fn update_profile_model(
        &self,
        id: &str,
        model: &str,
        context_window: Option<i64>,
        max_tokens: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let changed = conn
            .execute(
                "UPDATE profile_models
                 SET model = ?2, context_window = ?3, max_tokens = ?4
                 WHERE id = ?1",
                params![id, model, context_window, max_tokens],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("模型行不存在：{id}"));
        }
        Ok(())
    }

    /// 覆盖某模型行的倍率（获取倍率落库用）；模型行不存在返回 false。
    pub fn set_profile_model_rate(
        &self,
        profile_id: &str,
        model: &str,
        rate: f64,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let changed = conn
            .execute(
                "UPDATE profile_models SET rate_multiplier = ?3
                 WHERE profile_id = ?1 AND model = ?2",
                params![profile_id, model, rate],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    pub fn delete_profile_model(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute("DELETE FROM profile_models WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_profile_models(&self, profile_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "DELETE FROM profile_models WHERE profile_id = ?1",
            params![profile_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 事件计数（主要供测试与调试）。
    #[cfg(test)]
    pub fn get_event_count(&self, task_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    }

    /// 分页读取事件（event 列是 AgentEvent 的 JSON）。
    pub fn get_events(
        &self,
        task_id: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT event FROM task_events WHERE task_id = ?1 AND seq > ?2
                 ORDER BY seq ASC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![task_id, offset, limit], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_finish_and_list_task() {
        let store = Store::in_memory().unwrap();
        store
            .create_task(
                "t1",
                "zcode",
                "E:\\demo",
                "修 bug",
                Some("yolo"),
                Some("glm-4.7"),
                None,
            )
            .unwrap();

        let row = store.get_task("t1").unwrap().unwrap();
        assert_eq!(row.status, "running");
        assert_eq!(row.harness, "zcode");

        store.set_session_id("t1", "sess_9").unwrap();
        store.finish_task("t1", "done", Some(0));

        let row = store.get_task("t1").unwrap().unwrap();
        assert_eq!(row.session_id.as_deref(), Some("sess_9"));
        assert_eq!(row.model.as_deref(), Some("glm-4.7"));
        assert_eq!(row.base_branch.as_deref(), None);
        assert_eq!(row.worktree_dir.as_deref(), None);
        assert_eq!(row.status, "done");
        assert_eq!(row.exit_code, Some(0));

        let list = store.list_tasks(10).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn events_are_appended_in_order() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("t1", "codex", ".", "hi", None, None, None)
            .unwrap();
        for i in 0..5 {
            store.append_event("t1", &format!("e{i}")).unwrap();
        }
        assert_eq!(store.get_event_count("t1").unwrap(), 5);

        let page1 = store.get_events("t1", 0, 3).unwrap();
        let page2 = store.get_events("t1", 3, 3).unwrap();
        assert_eq!(page1, vec!["e0", "e1", "e2"]);
        assert_eq!(page2, vec!["e3", "e4"]);
    }

    #[test]
    fn memories_scoped_by_cwd_and_limited() {
        let store = Store::in_memory().unwrap();
        store.add_memory(r"E:\proj", "用 vitest 做测试").unwrap();
        store.add_memory(r"E:\proj", "数据库是 SQLite").unwrap();
        store.add_memory(r"E:\other", "别的项目记忆").unwrap();

        let got = store.list_memories(r"E:\proj", 10).unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|m| !m.contains("别的项目")));

        let limited = store.list_memories(r"E:\proj", 1).unwrap();
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn model_profiles_crud_and_enabled_filter() {
        let store = Store::in_memory().unwrap();
        store
            .add_model_profile("p1", "glm", Some("主力"), "key-glm", None, None, None, true)
            .unwrap();
        store
            .add_model_profile(
                "p2",
                "gpt",
                None,
                "key-gpt",
                Some("https://x"),
                Some("gpt-5.1"),
                Some("responses"),
                true,
            )
            .unwrap();

        let p2 = store.get_model_profile("p2").unwrap().unwrap();
        assert_eq!(p2.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(p2.protocol.as_deref(), Some("responses"));

        assert_eq!(store.list_model_profiles(false).unwrap().len(), 2);
        assert_eq!(store.list_model_profiles(true).unwrap().len(), 2);

        store.set_model_profile_enabled("p2", false).unwrap();
        let enabled = store.list_model_profiles(true).unwrap();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, "p1");

        store.delete_model_profile("p1").unwrap();
        assert_eq!(store.list_model_profiles(false).unwrap().len(), 1);
    }

    #[test]
    fn update_model_profile_overwrites_and_keeps_enabled() {
        let store = Store::in_memory().unwrap();
        store
            .add_model_profile("p1", "glm", Some("旧名"), "old-key", None, None, None, true)
            .unwrap();
        store.set_model_profile_enabled("p1", false).unwrap();

        store
            .update_model_profile(
                "p1",
                "gpt",
                Some("新名"),
                "new-key",
                Some("https://api.x"),
                Some("gpt-5.1"),
                Some("chat"),
            )
            .unwrap();
        let p = store.get_model_profile("p1").unwrap().unwrap();
        assert_eq!(p.provider, "gpt");
        assert_eq!(p.label.as_deref(), Some("新名"));
        assert_eq!(p.api_key, "new-key");
        assert_eq!(p.base_url.as_deref(), Some("https://api.x"));
        assert_eq!(p.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(p.protocol.as_deref(), Some("chat"));
        assert!(!p.enabled, "编辑不应改动启用状态");

        assert!(
            store
                .update_model_profile("ghost", "glm", None, "k", None, None, None)
                .is_err()
        );
    }

    #[test]
    fn profile_models_crud_and_cascade_delete() {
        let store = Store::in_memory().unwrap();
        store
            .add_model_profile(
                "p1",
                "custom",
                Some("中转"),
                "k",
                Some("https://api.x/v1"),
                None,
                None,
                true,
            )
            .unwrap();

        let m1 = store
            .add_profile_model("p1", "deepseek-chat", Some(65536), Some(8192))
            .unwrap();
        let m2 = store
            .add_profile_model("p1", "deepseek-v4-pro", None, None)
            .unwrap();
        let rows = store.list_profile_models("p1").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].model, "deepseek-chat");
        assert_eq!(rows[0].context_window, Some(65536));
        assert_eq!(rows[0].max_tokens, Some(8192));

        store.delete_profile_model(&m2.id).unwrap();
        assert_eq!(store.list_profile_models("p1").unwrap().len(), 1);

        store.clear_profile_models("p1").unwrap();
        assert!(store.list_profile_models("p1").unwrap().is_empty());

        // 倍率：写行 + 按名覆盖 + 未知名返回 false
        store
            .add_profile_model("p1", "deepseek-chat", None, None)
            .unwrap();
        assert!(
            store
                .set_profile_model_rate("p1", "deepseek-chat", 0.5)
                .unwrap()
        );
        let rows = store.list_profile_models("p1").unwrap();
        assert_eq!(rows[0].rate_multiplier, Some(0.5));
        assert!(
            !store
                .set_profile_model_rate("p1", "ghost-model", 1.0)
                .unwrap()
        );

        // 级联：删档案连带清模型列表
        store.delete_model_profile("p1").unwrap();
        assert!(store.list_profile_models("p1").unwrap().is_empty());
        assert_eq!(m1.profile_id, "p1");
    }

    #[test]
    fn delete_task_removes_row_and_events() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("t9", "deck", ".", "你好", None, None, None)
            .unwrap();
        store
            .append_event("t9", r#"{"type":"user_message","text":"你好"}"#)
            .unwrap();
        assert!(store.get_task("t9").unwrap().is_some());
        assert_eq!(store.get_event_count("t9").unwrap(), 1);

        store.delete_task("t9").unwrap();
        assert!(store.get_task("t9").unwrap().is_none());
        assert_eq!(store.get_event_count("t9").unwrap(), 0);
        assert!(store.delete_task("t9").is_err());
    }

    #[test]
    fn unknown_task_returns_none() {
        let store = Store::in_memory().unwrap();
        assert!(store.get_task("nope").unwrap().is_none());
    }

    #[test]
    fn session_deletion_removes_all_turns_but_keeps_other_sessions_and_harnesses() {
        let store = Store::in_memory().unwrap();
        for (id, harness, session) in [
            ("first", "deck", Some("shared.jsonl")),
            ("second", "deck", Some("shared.jsonl")),
            ("other", "codex", Some("shared.jsonl")),
            ("separate", "deck", Some("other.jsonl")),
            ("no-session", "deck", None),
            ("empty-session", "deck", Some("")),
        ] {
            store
                .create_task(id, harness, ".", id, None, None, None)
                .unwrap();
            if let Some(session) = session {
                store.set_session_id(id, session).unwrap();
            }
            store.append_event(id, "{}").unwrap();
        }
        assert_eq!(store.session_tasks("no-session").unwrap().len(), 1);
        assert_eq!(store.session_tasks("empty-session").unwrap().len(), 1);
        let ids = store
            .session_tasks("second")
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 2);
        store.delete_tasks(&ids).unwrap();
        for id in ["first", "second"] {
            assert!(store.get_task(id).unwrap().is_none());
            assert_eq!(store.get_event_count(id).unwrap(), 0);
        }
        assert_eq!(store.list_tasks(i64::MAX).unwrap().len(), 4);
    }

    #[test]
    fn bulk_deletion_rolls_back_when_any_task_is_missing() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("first", "deck", ".", "first", None, None, None)
            .unwrap();
        store.append_event("first", "{}").unwrap();
        assert!(
            store
                .delete_tasks(&["first".into(), "missing".into()])
                .is_err()
        );
        assert!(store.get_task("first").unwrap().is_some());
        assert_eq!(store.get_event_count("first").unwrap(), 1);
    }
}
