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
pub struct TaskRow {
    pub id: String,
    pub harness: String,
    pub cwd: String,
    pub prompt: String,
    pub mode: Option<String>,
    pub session_id: Option<String>,
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
             );",
        )
        .map_err(|e| e.to_string())?;
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

    pub fn create_task(
        &self,
        id: &str,
        harness: &str,
        cwd: &str,
        prompt: &str,
        mode: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        conn.execute(
            "INSERT INTO tasks (id, harness, cwd, prompt, mode, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, harness, cwd, prompt, mode, Self::now_millis()],
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
        conn.execute(
            "INSERT INTO task_events (task_id, seq, event)
             SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2 FROM task_events WHERE task_id = ?1",
            params![task_id, event_json],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_tasks(&self, limit: i64) -> Result<Vec<TaskRow>, String> {
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, harness, cwd, prompt, mode, session_id, status, exit_code,
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
                    session_id: row.get(5)?,
                    status: row.get(6)?,
                    exit_code: row.get(7)?,
                    created_at: row.get(8)?,
                    finished_at: row.get(9)?,
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
                "SELECT id, harness, cwd, prompt, mode, session_id, status, exit_code,
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
                session_id: row.get(5)?,
                status: row.get(6)?,
                exit_code: row.get(7)?,
                created_at: row.get(8)?,
                finished_at: row.get(9)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())
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
            .create_task("t1", "zcode", "E:\\demo", "修 bug", Some("yolo"))
            .unwrap();

        let row = store.get_task("t1").unwrap().unwrap();
        assert_eq!(row.status, "running");
        assert_eq!(row.harness, "zcode");

        store.set_session_id("t1", "sess_9").unwrap();
        store.finish_task("t1", "done", Some(0));

        let row = store.get_task("t1").unwrap().unwrap();
        assert_eq!(row.session_id.as_deref(), Some("sess_9"));
        assert_eq!(row.status, "done");
        assert_eq!(row.exit_code, Some(0));

        let list = store.list_tasks(10).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn events_are_appended_in_order() {
        let store = Store::in_memory().unwrap();
        store.create_task("t1", "codex", ".", "hi", None).unwrap();
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
    fn unknown_task_returns_none() {
        let store = Store::in_memory().unwrap();
        assert!(store.get_task("nope").unwrap().is_none());
    }
}
