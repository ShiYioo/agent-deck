//! Bounded fingerprints for turn manifests and guarded, recoverable file undo.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const FILE_LIMIT: u64 = 8 * 1024 * 1024;

pub fn fingerprint(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > FILE_LIMIT {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?.take(FILE_LIMIT + 1);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut total = 0;
    loop {
        let n = file.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > FILE_LIMIT {
            return None;
        }
        hasher.update(&buffer[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn safe_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains(':') {
        return Err("无效文件路径".into());
    }
    let rel = Path::new(path);
    if rel.components().any(|c| !matches!(c, Component::Normal(_)))
        || path
            .replace('\\', "/")
            .split('/')
            .any(|s| s.eq_ignore_ascii_case(".git"))
    {
        return Err("撤销路径必须位于任务工作区内".into());
    }
    let mut candidate = root.to_path_buf();
    for part in rel.components() {
        candidate.push(part);
        if let Ok(meta) = std::fs::symlink_metadata(&candidate) {
            if meta.file_type().is_symlink()
                || meta.file_type().is_dir()
                    && !candidate
                        .canonicalize()
                        .map_err(|e| e.to_string())?
                        .starts_with(root)
            {
                return Err("不支持撤销链接或越界路径".into());
            }
        }
    }
    Ok(candidate)
}

/// Never infer a turn baseline from the current HEAD. Old/truncated manifests
/// remain readable but cannot authorize destructive restoration.
pub fn undo(
    root: &Path,
    path: &str,
    baseline: &Value,
    result: &Value,
    backups: &Path,
) -> Result<String, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = safe_path(&root, path)?;
    if baseline["truncated"] == true || result["truncated"] == true {
        return Err("本轮快照不完整，无法安全撤销；文件未修改".into());
    }
    let before = baseline["entries"]
        .as_object()
        .ok_or("缺少起始快照，无法安全撤销")?;
    let after = result["entries"]
        .as_object()
        .ok_or("缺少成果快照，无法安全撤销")?;
    let lookup = |entries: &serde_json::Map<String, Value>| {
        entries
            .get(path)
            .or_else(|| entries.get(&path.replace('/', "\\")))
            .cloned()
    };
    let old = lookup(before);
    let end = lookup(after);
    if old.is_none() && end.is_none() {
        return Err("该文件不属于本轮变更".into());
    }
    if old == end {
        return Err("该文件没有本轮变更".into());
    }
    if let Some(end) = &end {
        let expected = end
            .get(2)
            .and_then(Value::as_str)
            .ok_or("缺少成果内容指纹，无法安全撤销；文件未修改")?;
        if fingerprint(&target).as_deref() != Some(expected) {
            return Err("文件在本轮结束后已变化，撤销已阻止；请查看当前差异".into());
        }
    } else if std::fs::symlink_metadata(&target).is_ok() {
        return Err("已删除的文件被重新创建，撤销已阻止；请查看当前差异".into());
    }
    let head = baseline["head"]
        .as_str()
        .filter(|h| h.len() >= 40 && h.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("缺少可恢复的 Git 起始基线，无法安全撤销；文件未修改")?;
    let git_path = path.replace('\\', "/");
    let object = format!("{head}:{git_path}");
    let kind = crate::turn_git_ok(&root, &["cat-file", "-t", &object]);
    if let Some(old) = &old {
        let expected = old
            .get(2)
            .and_then(Value::as_str)
            .ok_or("缺少起始内容指纹，无法安全撤销")?;
        let size = crate::turn_git_ok(&root, &["cat-file", "-s", &object])
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|n| *n <= FILE_LIMIT)
            .ok_or("起始文件不在可恢复范围内；文件未修改")?;
        let blob =
            crate::turn_git(&root, &["cat-file", "blob", &object]).ok_or("读取起始内容失败")?;
        if !blob.status.success()
            || blob.stdout.len() as u64 != size
            || format!("{:x}", Sha256::digest(&blob.stdout)) != expected
            || kind.as_deref().map(str::trim) != Some("blob")
        {
            return Err("任务开始前已有未提交修改，Git 基线不等于起始内容；已阻止撤销".into());
        }
    } else if kind.is_some() {
        return Err("无法证明该文件是本轮新增，已阻止撤销".into());
    }
    let backup = backups.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
    if target.is_file() {
        std::fs::copy(&target, backup.join("content")).map_err(|e| e.to_string())?;
        if fingerprint(&target) != fingerprint(&backup.join("content"))
            || end.as_ref().and_then(|v| v.get(2)).and_then(Value::as_str)
                != fingerprint(&target).as_deref()
        {
            return Err("备份期间文件已变化，撤销已阻止".into());
        }
    }
    std::fs::write(
        backup.join("restore.json"),
        serde_json::to_vec(&serde_json::json!({
            "path": target, "was_missing": end.is_none(), "task_baseline": head
        }))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if old.is_some() {
        // Worktree only: preserve the user's staging area. Pin the original commit.
        let source = format!("--source={head}");
        let restored = crate::turn_git(
            &root,
            &[
                "--literal-pathspecs",
                "restore",
                &source,
                "--worktree",
                "--",
                &git_path,
            ],
        )
        .ok_or("无法执行 Git 恢复；原内容已备份")?;
        if !restored.status.success() {
            return Err(format!(
                "撤销失败（原内容已备份）：{}",
                String::from_utf8_lossy(&restored.stderr)
            ));
        }
    } else {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    Ok(backup.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "Review Test"],
            vec!["config", "user.email", "review@example.invalid"],
            vec!["config", "core.autocrlf", "false"],
        ] {
            assert!(crate::turn_git(dir.path(), &args).unwrap().status.success());
        }
        std::fs::write(dir.path().join("a.txt"), "original\n").unwrap();
        crate::turn_git(dir.path(), &["add", "a.txt"]).unwrap();
        assert!(
            crate::turn_git(dir.path(), &["commit", "-qm", "initial"])
                .unwrap()
                .status
                .success()
        );
        dir
    }

    #[test]
    fn restores_verified_change_and_keeps_recovery_copy_and_index() {
        let dir = repo();
        let baseline = crate::snapshot_dir_manifest(dir.path());
        std::fs::write(dir.path().join("a.txt"), "updated\n").unwrap();
        crate::turn_git(dir.path(), &["add", "a.txt"]).unwrap();
        let staged = crate::turn_git_ok(dir.path(), &["diff", "--cached"]).unwrap();
        let end = crate::snapshot_dir_manifest(dir.path());
        let backups = tempfile::tempdir().unwrap();
        let backup = undo(dir.path(), "a.txt", &baseline, &end, backups.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&backup).join("content")).unwrap(),
            "updated\n"
        );
        assert_eq!(
            crate::turn_git_ok(dir.path(), &["diff", "--cached"]).unwrap(),
            staged
        );
    }

    #[test]
    fn later_content_and_dirty_baseline_are_never_overwritten() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "user draft\n").unwrap();
        let dirty = crate::snapshot_dir_manifest(dir.path());
        std::fs::write(dir.path().join("a.txt"), "AI update\n").unwrap();
        let end = crate::snapshot_dir_manifest(dir.path());
        let backups = tempfile::tempdir().unwrap();
        assert!(
            undo(dir.path(), "a.txt", &dirty, &end, backups.path())
                .unwrap_err()
                .contains("起始内容")
        );
        std::fs::write(dir.path().join("a.txt"), "user edit\n").unwrap();
        assert!(
            undo(dir.path(), "a.txt", &dirty, &end, backups.path())
                .unwrap_err()
                .contains("已变化")
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "user edit\n"
        );
    }

    #[test]
    fn additions_deletions_legacy_and_path_escape() {
        let dir = repo();
        let baseline = crate::snapshot_dir_manifest(dir.path());
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        std::fs::remove_file(dir.path().join("a.txt")).unwrap();
        let end = crate::snapshot_dir_manifest(dir.path());
        let backups = tempfile::tempdir().unwrap();
        undo(dir.path(), "new.txt", &baseline, &end, backups.path()).unwrap();
        assert!(!dir.path().join("new.txt").exists());
        undo(dir.path(), "a.txt", &baseline, &end, backups.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "original\n"
        );
        assert!(undo(dir.path(), "../outside", &baseline, &end, backups.path()).is_err());
        let legacy = serde_json::json!({"entries":{"a.txt":[0,9]}});
        assert!(undo(dir.path(), "a.txt", &legacy, &end, backups.path()).is_err());
        let mut partial = baseline.clone();
        partial["truncated"] = Value::Bool(true);
        assert!(undo(dir.path(), "a.txt", &partial, &end, backups.path()).is_err());
    }

    #[test]
    fn equal_metadata_does_not_hide_changed_content_and_build_files_remain_reviewable() {
        let dir = repo();
        let baseline = crate::snapshot_dir_manifest(dir.path());
        std::fs::write(dir.path().join("a.txt"), "modified\n").unwrap();
        std::fs::create_dir(dir.path().join("dist")).unwrap();
        std::fs::write(dir.path().join("dist/index.js"), "generated\n").unwrap();
        let mut end = crate::snapshot_dir_manifest(dir.path());
        end["entries"]["a.txt"][0] = baseline["entries"]["a.txt"][0].clone();
        let changes = crate::classify_turn_changes(dir.path(), &baseline, Some(&end));
        assert!(changes.iter().any(|file| file.path == "a.txt"));
        assert!(
            changes
                .iter()
                .any(|file| file.path.replace('\\', "/") == "dist/index.js")
        );
    }
}
