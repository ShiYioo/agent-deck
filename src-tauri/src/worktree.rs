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
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let out = command
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

/// 目录所在仓库的根（不在仓库内时返回原目录）。
/// `cwd` 落在子目录里时，项目归属仍应算到仓库根——对齐 ZCode 的
/// `findWorktreeRoot`：从 cwd 向上找到 `.git` 再判定项目。
pub fn project_root(dir: &Path) -> PathBuf {
    run_git_in(dir, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim().to_string()))
        .unwrap_or_else(|_| dir.to_path_buf())
}

/// 受管 worktree 的根：用户可配置（设置里的「Worktree 根目录」），留空用默认
/// `~/AgentDeck/worktrees`。
pub fn root(configured: Option<&str>) -> PathBuf {
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => dirs::home_dir()
            .map(|h| h.join("AgentDeck").join("worktrees"))
            .unwrap_or_else(|| PathBuf::from(".agentdeck-worktrees")),
    }
}

/// worktree 目录：<root>/<repo 名>/<task id>
pub fn dir_for(root: &Path, main_dir: &Path, task_id: &str) -> PathBuf {
    let repo_root = project_root(main_dir);
    let name = repo_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    root.join(name).join(task_id)
}

/// 列出受管 worktree：<root>/<repo 名>/<task id>。
/// 返回 (目录, task id, 目录 mtime)——mtime 用于按"最近使用"淘汰。
pub fn managed(root: &Path) -> Vec<(PathBuf, String, std::time::SystemTime)> {
    let mut out = Vec::new();
    let Ok(repos) = std::fs::read_dir(root) else {
        return out;
    };
    for repo in repos.flatten() {
        if !repo.path().is_dir() {
            continue;
        }
        let Ok(items) = std::fs::read_dir(repo.path()) else {
            continue;
        };
        for item in items.flatten() {
            let path = item.path();
            if !path.is_dir() {
                continue;
            }
            let mtime = item
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            out.push((
                path,
                item.file_name().to_string_lossy().to_string(),
                mtime,
            ));
        }
    }
    out
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
pub fn create(main_dir: &Path, task_id: &str, root: &Path) -> Result<WorktreePaths, String> {
    assert_clean(main_dir)?;
    let base_commit = run_git_in(main_dir, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let branch = branch_for(task_id);
    let dir = dir_for(root, main_dir, task_id);
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
/// `dir` 为已记录的目录（权威）；未知时按 root 推导。
pub fn remove(
    main_dir: &Path,
    task_id: &str,
    root: &Path,
    dir: Option<&Path>,
) -> Result<(), String> {
    let target = dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| dir_for(root, main_dir, task_id));
    remove_inner(main_dir, &target, task_id, true)
}

/// 自动清理用：只移除目录与登记，**保留分支**——目录才是磁盘成本，
/// 分支留着重启后仍能用 `git worktree add <分支>` 复原或直接合并（对齐 Codex 的可恢复语义）。
pub fn prune_dir(main_dir: &Path, dir: &Path, task_id: &str) -> Result<(), String> {
    remove_inner(main_dir, dir, task_id, false)
}

fn remove_inner(
    main_dir: &Path,
    dir: &Path,
    task_id: &str,
    delete_branch: bool,
) -> Result<(), String> {
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
                std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
            }
        }
    }
    // .git/worktrees/<name> 元数据残留清理（抄 VK force_cleanup_worktree_metadata）
    cleanup_worktree_metadata(main_dir, dir);
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

    /// 每个用例独立的受管根目录（不污染默认的 ~/AgentDeck/worktrees）
    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdeck-wtroot-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn root_uses_configuration_and_falls_back_to_default() {
        assert_eq!(root(Some("D:/wt")).join("x"), PathBuf::from("D:/wt").join("x"));
        assert!(root(Some("   ")).ends_with(Path::new("AgentDeck").join("worktrees")));
        assert!(root(None).ends_with(Path::new("AgentDeck").join("worktrees")));
    }

    /// 自动清理只删目录、保留分支：目录是磁盘成本，分支保证可复原/可合并
    #[test]
    fn managed_lists_entries_and_prune_keeps_the_branch() {
        let repo = temp_repo("managed");
        let wt_root = temp_root("managed");
        let paths = create(&repo, "t-prune", &wt_root).unwrap();

        let entries = managed(&wt_root);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].1, "t-prune");
        assert_eq!(entries[0].0, paths.dir);

        prune_dir(&repo, &paths.dir, "t-prune").unwrap();
        assert!(!paths.dir.exists());
        assert!(
            run_git_in(&repo, &["rev-parse", "--verify", &paths.branch]).is_ok(),
            "清理必须保留分支以便复原"
        );
    }

    #[test]
    fn is_git_repo_detects() {
        let repo = temp_repo("detect");
        assert!(is_git_repo(&repo));
        let non = std::env::temp_dir().join("agentdeck-non-git-probe");
        std::fs::create_dir_all(&non).unwrap();
        assert!(!is_git_repo(&non));
    }

    /// 子目录里派任务时，项目根要向上落到仓库根（默认原地工作后，项目归属靠它判定）
    #[test]
    fn project_root_resolves_upward_from_a_subdirectory() {
        let repo = temp_repo("root");
        let nested = repo.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        let root = project_root(&nested);
        assert_eq!(root.file_name(), repo.file_name(), "root: {}", root.display());
        assert_ne!(root, nested);

        // 非仓库目录：原样返回
        let plain = std::env::temp_dir().join("agentdeck-non-git-root-probe");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(project_root(&plain), plain);
    }

    #[test]
    fn create_refuses_dirty_main_dir() {
        let repo = temp_repo("dirty");
        std::fs::write(repo.join("dirty.txt"), "uncommitted").unwrap();
        let err = create(&repo, "t-dirty", &temp_root("dirty")).unwrap_err();
        assert!(err.contains("未提交"), "err: {err}");
    }

    #[test]
    fn create_works_and_isolates() {
        let repo = temp_repo("create");
        let paths = create(&repo, "t1", &temp_root("create")).unwrap();

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
        let wt_root = temp_root("merge");
        let paths = create(&repo, "t2", &wt_root).unwrap();

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
        remove(&repo, "t2", &wt_root, Some(&paths.dir)).unwrap();
        assert!(!paths.dir.exists());
        assert!(run_git_in(&repo, &["rev-parse", "--verify", &paths.branch]).is_err());
    }
}
