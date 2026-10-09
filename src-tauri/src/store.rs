//! 持久化层：SQLite 存任务与事件流，支撑历史查看与会话续接。
//!
//! Connection 不是 Sync，用 Mutex 包一层；所有方法都是同步的，
//! 由调用方（tauri command / runner）自行决定是否放进异步上下文。

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
    /// running | done | failed | cancelled
    pub status: String,
    pub exit_code: Option<i64>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Clone for Store {
    fn clone(&self) -> Self {
        Self {
            conn: self.conn.clone(),
        }
    }
}

impl Store {
    /// 克隆一个共享同一连接的句柄（供异步任务持有）。
    pub fn clone_handle(&self) -> Store {
        self.clone()
    }

    /// 打开（或创建）数据库并确保表结构存在。
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
                 created_at     INTEGER NOT NULL
             );",
        )
        .map_err(|e| e.to_string())?;
        // 既有数据库补列（重复执行报 duplicate column，忽略即可）
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN base_branch TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN base_commit TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN worktree_dir TEXT", []);
        let _ = conn.execute("ALTER TABLE tasks ADD COLUMN project_id TEXT", []);
        let _ = conn.execute("ALTER TABLE model_profiles ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE model_profiles ADD COLUMN protocol TEXT", []);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn now_millis() -> i64 {
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

    pub fn set_session_id(&self, task_id: &str, session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "UPDATE tasks SET session_id = ?2 WHERE id = ?1",
            params![task_id, session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 结束任务：status = done | failed | cancelled。
    pub fn finish_task(&self, task_id: &str, status: &str, exit_code: Option<i64>) {
        let Ok(conn) = self.conn.lock() else { return };
        let _ = conn.execute(
            "UPDATE tasks SET status = ?2, exit_code = ?3, finished_at = ?4 WHERE id = ?1",
            params![task_id, status, exit_code, Self::now_millis()],
        );
    }

    pub fn append_event(&self, task_id: &str, event_json: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        // 热路径（每条事件一次）：prepare_cached 避免逐条重复编译 SQL
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO task_events (task_id, seq, event)
                 SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2 FROM task_events WHERE task_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.execute(params![task_id, event_json])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_tasks(&self, limit: i64) -> Result<Vec<TaskRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, harness, cwd, prompt, mode, model, project_id, base_branch, worktree_dir, session_id, status, exit_code,
                        created_at, finished_at
                 FROM tasks ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
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
                    status: row.get(10)?,
                    exit_code: row.get(11)?,
                    created_at: row.get(12)?,
                    finished_at: row.get(13)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, harness, cwd, prompt, mode, model, project_id, base_branch, worktree_dir, session_id, status, exit_code,
                        created_at, finished_at
                 FROM tasks WHERE id = ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_row(params![task_id], |row| {
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
                status: row.get(10)?,
                exit_code: row.get(11)?,
                created_at: row.get(12)?,
                finished_at: row.get(13)?,
            })
        })
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
                "SELECT id, profile_id, model, context_window, created_at
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
                    created_at: row.get(4)?,
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
            "INSERT INTO profile_models (id, profile_id, model, context_window, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, profile_id, model, context_window, Self::now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(ProfileModelRow {
            id,
            profile_id: profile_id.into(),
            model: model.into(),
            context_window,
            created_at: Self::now_millis(),
        })
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
            .add_profile_model("p1", "deepseek-chat", Some(65536))
            .unwrap();
        let m2 = store
            .add_profile_model("p1", "deepseek-v4-pro", None)
            .unwrap();
        let rows = store.list_profile_models("p1").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].model, "deepseek-chat");
        assert_eq!(rows[0].context_window, Some(65536));

        store.delete_profile_model(&m2.id).unwrap();
        assert_eq!(store.list_profile_models("p1").unwrap().len(), 1);

        store.clear_profile_models("p1").unwrap();
        assert!(store.list_profile_models("p1").unwrap().is_empty());

        // 级联：删档案连带清模型列表
        store.add_profile_model("p1", "m", None).unwrap();
        store.delete_model_profile("p1").unwrap();
        assert!(store.list_profile_models("p1").unwrap().is_empty());
        assert_eq!(m1.profile_id, "p1");
    }

    #[test]
    fn unknown_task_returns_none() {
        let store = Store::in_memory().unwrap();
        assert!(store.get_task("nope").unwrap().is_none());
    }
}
