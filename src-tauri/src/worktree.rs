//! Git worktree 隔离（设计参照 VK worktree-manager）：
//! 派任务时从主目录创建独立 worktree + 分支，任务改动被分支边界圈住；
//! 完成后可合并回主目录或放弃，互不踩踏。
//!
//! 全部走 git CLI（不引 git2 重依赖），错误带上下文文本。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug)]
pub struct WorktreePaths {
    /// worktree 所在目录（任务的 cwd）
    pub dir: PathBuf,
    /// 任务分支名
    pub branch: String,
    /// 创建时基于的提交（diff/合并的基准）
    pub base_commit: String,
}

fn run_git_in(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法执行 git：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "git {} 失败：{}",
            args.first().unwrap_or(&"?"),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 目录是否在 git 仓库内
pub fn is_git_repo(dir: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 任务分支名（带 task id 保证唯一）
pub fn branch_for(task_id: &str) -> String {
    format!("agentdeck/{}", task_id)
}

/// worktree 目录：~/AgentDeck/worktrees/<repo 名>/<task id>
pub fn dir_for(main_dir: &Path, task_id: &str) -> PathBuf {
    let repo_root = run_git_in(main_dir, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim().to_string()))
        .unwrap_or_else(|_| main_dir.to_path_buf());
    let name = repo_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    dirs::home_dir()
        .map(|h| {
            h.join("AgentDeck")
                .join("worktrees")
                .join(name)
                .join(task_id)
        })
        .unwrap_or_else(|| main_dir.join(".agentdeck-worktrees").join(task_id))
}

/// 主目录必须干净（有未提交改动时，隔离边界会漏掉用户自己的改动）
fn assert_clean(main_dir: &Path) -> Result<(), String> {
    let status = run_git_in(main_dir, &["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err(
            "主目录有未提交的改动——先 commit 或 stash，否则任务改动无法与你的工作隔离".into(),
        );
    }
    Ok(())
}

/// 创建 worktree + 任务分支。返回任务 cwd、分支名、base commit。
pub fn create(main_dir: &Path, task_id: &str) -> Result<WorktreePaths, String> {
    assert_clean(main_dir)?;
    let base_commit = run_git_in(main_dir, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let branch = branch_for(task_id);
    let dir = dir_for(main_dir, task_id);
    if dir.exists() {
        return Err(format!("worktree 目录已存在：{}", dir.display()));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    run_git_in(
        main_dir,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &dir.to_string_lossy(),
            "HEAD",
        ],
    )?;

    Ok(WorktreePaths {
        dir,
        branch,
        base_commit,
    })
}

/// 把任务分支合并回主目录（普通 merge；冲突时 Err 由 UI 提示手动处理）。
pub fn merge(main_dir: &Path, branch: &str) -> Result<String, String> {
    run_git_in(main_dir, &["rev-parse", "--verify", branch])?;
    run_git_in(main_dir, &["merge", "--no-edit", branch])
}

/// 任务完成后清理：移除 worktree、删除任务分支（-D 允许丢弃未合并）。
pub fn remove(main_dir: &Path, task_id: &str, delete_branch: bool) -> Result<(), String> {
    let dir = dir_for(main_dir, task_id);
    if dir.exists() {
        // 任务可能留下未提交产物，强制移除；用户已手删目录时 git 报错，
        // 此时 prune 清登记后再物理删除（若有残留）
        if run_git_in(
            main_dir,
            &["worktree", "remove", "--force", &dir.to_string_lossy()],
        )
        .is_err()
        {
            let _ = run_git_in(main_dir, &["worktree", "prune"]);
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
        }
    }
    // .git/worktrees/<name> 元数据残留清理（抄 VK force_cleanup_worktree_metadata）
    cleanup_worktree_metadata(main_dir, &dir);
    if delete_branch {
        let branch = branch_for(task_id);
        let _ = run_git_in(main_dir, &["branch", "-D", &branch]);
    }
    Ok(())
}

/// 清理 .git/worktrees/<name> 残留元数据（用户手删目录后 git worktree list 仍显示）
fn cleanup_worktree_metadata(main_dir: &Path, worktree_dir: &Path) {
    let Ok(repo_root) = run_git_in(main_dir, &["rev-parse", "--git-common-dir"]) else {
        return;
    };
    let wt_meta = PathBuf::from(repo_root.trim()).join("worktrees");
    if !wt_meta.is_dir() {
        return;
    }
    let wt_norm = worktree_dir.to_string_lossy().to_lowercase();
    if let Ok(entries) = std::fs::read_dir(&wt_meta) {
        for entry in entries.flatten() {
            let gitdir_file = entry.path().join("gitdir");
            if let Ok(content) = std::fs::read_to_string(&gitdir_file) {
                let reg = PathBuf::from(content.trim())
                    .to_string_lossy()
                    .to_lowercase();
                if reg.starts_with(&wt_norm) || wt_norm.starts_with(&reg) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// 启动时批量清理 git 元数据（用户手动删目录后的残留登记）。
pub fn prune_stale(main_dir: &Path) {
    let _ = run_git_in(main_dir, &["worktree", "prune"]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdeck-wt-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        run_git_in(&dir, &["init", "-q", "-b", "main"]).unwrap();
        run_git_in(&dir, &["config", "user.email", "test@local"]).unwrap();
        run_git_in(&dir, &["config", "user.name", "test"]).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        run_git_in(&dir, &["add", "."]).unwrap();
        run_git_in(&dir, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    #[test]
    fn is_git_repo_detects() {
        let repo = temp_repo("detect");
        assert!(is_git_repo(&repo));
        let non = std::env::temp_dir().join("agentdeck-non-git-probe");
        std::fs::create_dir_all(&non).unwrap();
        assert!(!is_git_repo(&non));
    }

    #[test]
    fn create_refuses_dirty_main_dir() {
        let repo = temp_repo("dirty");
        std::fs::write(repo.join("dirty.txt"), "uncommitted").unwrap();
        let err = create(&repo, "t-dirty").unwrap_err();
        assert!(err.contains("未提交"), "err: {err}");
    }

    #[test]
    fn create_works_and_isolates() {
        let repo = temp_repo("create");
        let paths = create(&repo, "t1").unwrap();

        assert!(paths.dir.join("a.txt").exists());
        let branch_out = run_git_in(&paths.dir, &["branch", "--show-current"]).unwrap();
        assert_eq!(branch_out.trim(), "agentdeck/t1");
        assert_eq!(
            paths.base_commit,
            run_git_in(&repo, &["rev-parse", "HEAD"]).unwrap().trim()
        );

        // worktree 里改文件：主目录不受影响
        std::fs::write(paths.dir.join("a.txt"), "changed by agent").unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join("a.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn merge_and_remove_roundtrip() {
        let repo = temp_repo("merge");
        let paths = create(&repo, "t2").unwrap();

        // 任务在 worktree 里改文件并提交
        std::fs::write(paths.dir.join("a.txt"), "agent work").unwrap();
        run_git_in(&paths.dir, &["add", "."]).unwrap();
        run_git_in(&paths.dir, &["commit", "-q", "-m", "agent change"]).unwrap();

        // 主目录在分支创建后前进一个提交（模拟真实并行）
        std::fs::write(repo.join("base.txt"), "main moved").unwrap();
        run_git_in(&repo, &["add", "."]).unwrap();
        run_git_in(&repo, &["commit", "-q", "-m", "main change"]).unwrap();

        // 合并：无冲突 → 主目录拿到 agent 的改动
        merge(&repo, &paths.branch).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join("a.txt")).unwrap(),
            "agent work"
        );

        // 清理：worktree 与分支都消失
        remove(&repo, "t2", true).unwrap();
        assert!(!paths.dir.exists());
        assert!(run_git_in(&repo, &["rev-parse", "--verify", &paths.branch]).is_err());
    }
}
