//! Versioned, non-Git workflow outputs. Only declared relative files cross stages.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceKind {
    #[default]
    Git,
    Artifacts,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    #[serde(default)]
    pub workspace: WorkspaceKind,
    #[serde(default)]
    pub model_hint: Option<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub acceptance: bool,
}

pub type Manifest = BTreeMap<String, String>;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn relative(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("成果必须是工作目录内的相对文件路径，不允许绝对路径或 ..".into());
    }
    // Backslashes are separators on Windows, but must not bypass validation on Unix.
    if path.to_string_lossy().contains([':', '\\']) {
        return Err("成果路径使用 / 分隔的相对路径".into());
    }
    if path
        .components()
        .any(|part| part.as_os_str().to_string_lossy().ends_with(['.', ' ']))
    {
        return Err("成果路径的各段不能以点或空格结尾".into());
    }
    Ok(path.to_path_buf())
}

fn safe_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = relative(name)?;
    let mut path = root.to_path_buf();
    for part in relative.components() {
        path.push(part);
        if path.exists()
            && std::fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
        {
            return Err(format!("成果路径包含符号链接：{name}"));
        }
        if root.exists()
            && path.exists()
            && !std::fs::canonicalize(&path)
                .map_err(|e| e.to_string())?
                .starts_with(std::fs::canonicalize(root).map_err(|e| e.to_string())?)
        {
            return Err("成果路径超出隔离目录".into());
        }
    }
    Ok(path)
}

/// Bounded streaming hashes: never load whole artifacts into the UI or memory.
fn file_hash(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn snapshot(root: &Path) -> Result<Manifest, String> {
    fn visit(root: &Path, dir: &Path, out: &mut Manifest, bytes: &mut u64) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err("成果目录中不允许符号链接".into());
            }
            if meta.is_dir() {
                visit(root, &entry.path(), out, bytes)?;
            } else if meta.is_file() {
                *bytes += meta.len();
                if out.len() >= 4096 || *bytes > 256 * 1024 * 1024 {
                    return Err("成果超过单节点 4096 文件 / 256 MiB 额度".into());
                }
                let name = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                relative(&name)?;
                out.insert(name, file_hash(&entry.path())?);
            } else {
                return Err("成果必须是普通文件".into());
            }
        }
        Ok(())
    }
    let mut out = Manifest::new();
    visit(root, root, &mut out, &mut 0)?;
    Ok(out)
}

pub fn version(root: &Path) -> Result<String, String> {
    Ok(hash(
        serde_json::to_string(&snapshot(root)?)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    ))
}

pub fn freeze(cwd: &Path, outputs: &[String], dir: &Path) -> Result<(String, String), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut manifest = Manifest::new();
    let mut bytes = 0u64;
    for name in outputs {
        let source = safe_file(cwd, name)?;
        if !source.is_file() {
            return Err(format!("声明的成果未提交：{name}"));
        }
        bytes += std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
        if outputs.len() > 4096 || bytes > 256 * 1024 * 1024 {
            return Err("成果超过 4096 文件 / 256 MiB 额度".into());
        }
        let destination = safe_file(&dir.join("files"), name)?;
        std::fs::create_dir_all(destination.parent().ok_or("成果路径无效")?)
            .map_err(|e| e.to_string())?;
        std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
        manifest.insert(name.clone(), file_hash(&destination)?);
    }
    let text = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    let path = dir.join("manifest.json");
    std::fs::write(&path, &text).map_err(|e| e.to_string())?;
    Ok((path.to_string_lossy().into(), hash(text.as_bytes())))
}

pub fn read_manifest(path: &Path, expected: &str) -> Result<Manifest, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if hash(&bytes) != expected {
        return Err("成果清单已变化，哈希校验失败".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn materialize(path: &Path, expected: &str, cwd: &Path) -> Result<Manifest, String> {
    materialize_selected(path, expected, cwd, None)
}

pub fn materialize_selected(
    path: &Path,
    expected: &str,
    cwd: &Path,
    selected: Option<&[String]>,
) -> Result<Manifest, String> {
    let manifest = read_manifest(path, expected)?;
    let files = path.parent().ok_or("成果目录无效")?.join("files");
    for (name, expected) in &manifest {
        if selected.is_some_and(|names| !names.contains(name)) {
            continue;
        }
        let source = safe_file(&files, name)?;
        if file_hash(&source)? != *expected {
            return Err(format!("成果内容已变化：{name}"));
        }
        let target = safe_file(cwd, name)?;
        std::fs::create_dir_all(target.parent().ok_or("输入路径无效")?)
            .map_err(|e| e.to_string())?;
        std::fs::copy(source, target).map_err(|e| e.to_string())?;
    }
    if selected.is_some_and(|names| names.iter().any(|name| !manifest.contains_key(name))) {
        return Err("声明的源输入不在冻结成果清单中".into());
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outputs_are_versioned_and_tampering_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("novel.md"), "第一版").unwrap();
        let (path, digest) =
            freeze(&source, &["novel.md".into()], &root.path().join("v1")).unwrap();
        materialize(Path::new(&path), &digest, &target).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("novel.md")).unwrap(),
            "第一版"
        );
        std::fs::write(root.path().join("v1/files/novel.md"), "被修改").unwrap();
        assert!(materialize(Path::new(&path), &digest, &target).is_err());
    }
    #[test]
    fn unsafe_paths_and_missing_outputs_fail() {
        for name in ["../outside", "/absolute", "C:/x", "a\\..\\x", ""] {
            assert!(relative(name).is_err(), "{name}");
        }
        let root = tempfile::tempdir().unwrap();
        assert!(
            freeze(
                root.path(),
                &["missing.md".into()],
                &root.path().join("out")
            )
            .is_err()
        );
    }
}
