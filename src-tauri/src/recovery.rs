//! Durable process identity and read-only workspace checks. Never kill or rewind on recovery.
use crate::{TaskRegistry, store::Store};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, process::Command};
use sysinfo::{Pid, System};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProcessIdentity {
    pid: u32,
    started: u64,
}

#[derive(Serialize)]
pub(crate) struct RecoveryCheck {
    pub safe: bool,
    pub can_confirm: bool,
    pub active_processes: Vec<String>,
    pub workspace_changed: bool,
    pub workspace_path: String,
    pub summary: String,
}

fn snapshot() -> System {
    use sysinfo::{ProcessRefreshKind, RefreshKind};
    System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    )
}

fn matches(identity: &ProcessIdentity, system: &System) -> bool {
    system.process(Pid::from_u32(identity.pid))
        .is_some_and(|process| process.start_time() == identity.started)
}

fn save(store: &Store, task_id: &str, identities: &[ProcessIdentity]) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|_| "store poisoned")?;
    conn.execute("INSERT INTO task_processes(task_id,data)
        SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM tasks WHERE id=?1)
        ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
        params![task_id, serde_json::to_string(identities).map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn load(store: &Store, task_id: &str) -> Result<Option<Vec<ProcessIdentity>>, String> {
    let conn = store.conn.lock().map_err(|_| "store poisoned")?;
    let data: Option<String> = conn.query_row(
        "SELECT data FROM task_processes WHERE task_id=?1", params![task_id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    data.map(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string())).transpose()
}

/// Capture descendants while the command-group is alive, including native adapter services.
pub(crate) fn track(store: &Store, task_id: &str, pid: Option<u32>) {
    let Some(pid) = pid else { return };
    let store = store.clone_handle();
    let task_id = task_id.to_string();
    tauri::async_runtime::spawn(async move {
        let mut identities: Vec<ProcessIdentity> = Vec::new();
        loop {
            let s = store.clone_handle();
            let id = task_id.clone();
            let captured = tauri::async_runtime::spawn_blocking(move || {
                let system = snapshot();
                if identities.is_empty() {
                    if let Some(process) = system.process(Pid::from_u32(pid)) {
                        identities.push(ProcessIdentity { pid, started: process.start_time() });
                    }
                }
                let mut owners: HashSet<u32> = identities.iter()
                    .filter(|identity| matches(identity, &system)).map(|identity| identity.pid).collect();
                loop {
                    let before = owners.len();
                    for (child_pid, child) in system.processes() {
                        if child.parent().is_some_and(|parent| owners.contains(&parent.as_u32()))
                            && owners.insert(child_pid.as_u32()) {
                            identities.push(ProcessIdentity { pid: child_pid.as_u32(), started: child.start_time() });
                        }
                    }
                    if before == owners.len() { break; }
                }
                if !identities.is_empty() {
                    if let Err(error) = save(&s, &id, &identities) {
                        eprintln!("Process ownership persistence: {error}");
                    }
                }
                identities
            }).await;
            match captured {
                Ok(value) => identities = value,
                Err(error) => {
                    eprintln!("Process ownership inspection: {error}");
                    break;
                }
            }
            if store.get_task(&task_id).ok().flatten().is_none_or(|task| task.status != "running") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

fn git(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd).env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.output().map_err(|e| format!("无法检查 Git 工作区：{e}"))
}

fn workspace(cwd: &str) -> Result<(bool, bool), String> {
    std::fs::read_dir(cwd).map_err(|e| format!("工作目录不可访问：{e}"))?;
    let output = git(cwd, &["status", "--porcelain", "--untracked-files=normal"])?;
    if !output.status.success() {
        // Plain folders are supported. Other Git failures must never look like a clean repository.
        let error = String::from_utf8_lossy(&output.stderr);
        let has_metadata = std::path::Path::new(cwd).ancestors().any(|path| path.join(".git").exists());
        if !has_metadata && error.contains("not a git repository (or any of the parent directories)") {
            return Ok((false, false));
        }
        return Err(format!("Git 检查失败（{}）：{}", output.status, error.trim()));
    }
    Ok(workspace_status(&String::from_utf8_lossy(&output.stdout)))
}

fn workspace_status(status: &str) -> (bool, bool) {
    let conflict = status.lines().any(|line|
        matches!(line.get(..2), Some("UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD")));
    (!status.is_empty(), conflict)
}

pub(crate) fn inspect(store: &Store, registry: &TaskRegistry, task_id: &str) -> Result<RecoveryCheck, String> {
    let task = store.get_task(task_id)?.ok_or("任务不存在")?;
    let mut active_processes = Vec::new();
    if registry.0.lock().map_err(|_| "task registry poisoned")?.contains_key(task_id)
        || task.status == "running" {
        active_processes.push(format!("{} 执行者仍在运行", task.harness));
    }
    let identities = load(store, task_id)?;
    if let Some(identities) = &identities {
        let system = snapshot();
        for identity in identities {
            if matches(identity, &system) {
                active_processes.push(format!("{} · PID {}", task.harness, identity.pid));
            }
        }
    }
    let checked = workspace(&task.cwd);
    let (workspace_changed, conflict) = checked.as_ref().copied().unwrap_or((false, false));
    let can_confirm = active_processes.is_empty() && !conflict && checked.is_ok();
    let safe = can_confirm && identities.is_some();
    let summary = if !active_processes.is_empty() {
        format!("发现仍在运行的执行进程：{}。进程结束后会自动重新检查。", active_processes.join("、"))
    } else if let Err(error) = checked {
        error
    } else if conflict {
        "发现尚未解决的 Git 合并冲突。请先处理冲突，已有文件和成果均已保留。".into()
    } else if identities.is_none() {
        "此旧任务没有进程身份记录，无法自动确认旧执行者是否退出。确认后可继续，工作区改动会保留。".into()
    } else if workspace_changed {
        "旧执行者已退出，已有工作区改动将保留，可以继续。".into()
    } else {
        "旧执行者已退出，工作区检查通过，可以继续。".into()
    };
    Ok(RecoveryCheck { safe, can_confirm, active_processes, workspace_changed, workspace_path: task.cwd, summary })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_edits_are_preserved_but_unmerged_files_block() {
        assert_eq!(workspace_status(" M code.ts\n?? result.png\n"), (true, false));
        assert_eq!(workspace_status("UU code.ts\n"), (true, true));
        assert_eq!(workspace_status(""), (false, false));
    }
    #[test]
    fn pid_reuse_is_not_ownership() {
        let system = snapshot();
        let pid = std::process::id();
        let started = system.process(Pid::from_u32(pid)).unwrap().start_time();
        assert!(matches(&ProcessIdentity { pid, started }, &system));
        assert!(!matches(&ProcessIdentity { pid, started: started + 1 }, &system));
    }

    #[test]
    fn recovery_checks_durable_processes_and_preserves_workspace_edits() {
        let folder = tempfile::tempdir().unwrap();
        let cwd = folder.path().to_str().unwrap();
        assert!(git(cwd, &["init"]).unwrap().status.success());
        std::fs::write(folder.path().join("result.txt"), "keep this result").unwrap();
        let store = Store::in_memory().unwrap();
        store.create_task("recover", "opencode", cwd, "test", None, None, None).unwrap();
        store.conn.lock().unwrap().execute("UPDATE tasks SET status='interrupted' WHERE id='recover'", []).unwrap();
        let registry = TaskRegistry::default();
        let legacy = inspect(&store, &registry, "recover").unwrap();
        assert!(!legacy.safe && legacy.can_confirm && legacy.workspace_changed);
        let system = snapshot();
        let pid = std::process::id();
        let started = system.process(Pid::from_u32(pid)).unwrap().start_time();
        save(&store, "recover", &[ProcessIdentity { pid, started }]).unwrap();
        let active = inspect(&store, &registry, "recover").unwrap();
        assert!(!active.safe && !active.can_confirm && !active.active_processes.is_empty());
        save(&store, "recover", &[ProcessIdentity { pid, started: started + 1 }]).unwrap();
        let exited = inspect(&store, &registry, "recover").unwrap();
        assert!(exited.safe && exited.workspace_changed);
        assert_eq!(std::fs::read_to_string(folder.path().join("result.txt")).unwrap(), "keep this result");
        store.conn.lock().unwrap().execute("UPDATE tasks SET status='running' WHERE id='recover'", []).unwrap();
        assert!(!inspect(&store, &registry, "recover").unwrap().can_confirm);
    }

    #[test]
    fn inaccessible_or_corrupt_git_workspace_never_looks_clean() {
        let folder = tempfile::tempdir().unwrap();
        assert!(workspace(folder.path().to_str().unwrap()).is_ok());
        std::fs::write(folder.path().join(".git"), "gitdir: missing-repository").unwrap();
        assert!(workspace(folder.path().to_str().unwrap()).is_err());
        assert!(workspace(folder.path().join("missing").to_str().unwrap()).is_err());
    }
}
