use crate::store::Store;
use serde::Serialize;
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};
use tauri::State;

fn root(store: &Store, task_id: &str) -> Result<PathBuf, String> {
    let task = store.get_task(task_id)?.ok_or("任务不存在")?;
    PathBuf::from(task.worktree_dir.unwrap_or(task.cwd))
        .canonicalize()
        .map_err(|e| e.to_string())
}

fn scoped(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let path = root
        .join(requested)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("路径超出任务工作区".into());
    }
    Ok(path)
}

#[derive(Serialize)]
pub struct DirectoryEntry {
    name: String,
    path: String,
    directory: bool,
    symlink: bool,
}
#[derive(Serialize)]
pub struct DirectoryPage {
    entries: Vec<DirectoryEntry>,
    next: Option<usize>,
}

fn directory(root: &Path, requested: &str, offset: usize) -> Result<DirectoryPage, String> {
    let path = scoped(root, requested)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let directory = if kind.is_symlink() {
            entry_path.is_dir()
        } else {
            kind.is_dir()
        };
        entries.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry_path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            directory,
            symlink: kind.is_symlink(),
        });
    }
    entries.sort_by_cached_key(|entry| {
        (
            !entry.directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    let next = (offset.saturating_add(500) < entries.len()).then_some(offset.saturating_add(500));
    Ok(DirectoryPage {
        entries: entries.into_iter().skip(offset).take(500).collect(),
        next,
    })
}

#[tauri::command]
pub async fn list_task_directory(
    store: State<'_, Store>,
    task_id: String,
    path: String,
    offset: Option<usize>,
) -> Result<DirectoryPage, String> {
    let root = root(&store, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || directory(&root, &path, offset.unwrap_or(0)))
        .await
        .map_err(|e| e.to_string())?
}

struct LineIndex {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    checkpoints: Vec<u64>,
    count: usize,
    utf16: Option<bool>,
}
static INDICES: OnceLock<Mutex<Vec<Arc<LineIndex>>>> = OnceLock::new();

fn index(path: &Path) -> Result<Arc<LineIndex>, String> {
    let meta = path.metadata().map_err(|e| e.to_string())?;
    let cache = INDICES.get_or_init(Default::default);
    if let Some(found) = cache
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|item| {
            item.path == path && item.size == meta.len() && item.modified == meta.modified().ok()
        })
        .cloned()
    {
        return Ok(found);
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = [0; 65536];
    let mut checkpoints = vec![0];
    let mut count = 1usize;
    let mut position = 0u64;
    let mut utf16 = None;
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if position == 0 {
            if buffer[..n].starts_with(&[0xff, 0xfe]) {
                utf16 = Some(true);
            } else if buffer[..n].starts_with(&[0xfe, 0xff]) {
                utf16 = Some(false);
            }
        }
        for (i, byte) in buffer[..n].iter().enumerate() {
            let newline = match utf16 {
                Some(little) => {
                    i % 2 == 0
                        && i + 1 < n
                        && if little {
                            *byte == 10 && buffer[i + 1] == 0
                        } else {
                            *byte == 0 && buffer[i + 1] == 10
                        }
                }
                None => *byte == b'\n',
            };
            if newline {
                count += 1;
                if (count - 1) % 512 == 0 {
                    checkpoints.push(position + i as u64 + if utf16.is_some() { 2 } else { 1 });
                }
            }
        }
        position += n as u64;
    }
    let after = path.metadata().map_err(|e| e.to_string())?;
    if after.len() != meta.len() || after.modified().ok() != meta.modified().ok() {
        return Err("文件在建立索引时发生变化，请刷新重试".into());
    }
    let result = Arc::new(LineIndex {
        path: path.into(),
        size: meta.len(),
        modified: meta.modified().ok(),
        checkpoints,
        count,
        utf16,
    });
    let mut cache = cache.lock().map_err(|e| e.to_string())?;
    cache.retain(|item| item.path != path);
    if cache.len() >= 4 {
        cache.remove(0);
    }
    cache.push(result.clone());
    Ok(result)
}

#[derive(Serialize)]
pub struct TextWindow {
    start: usize,
    total: usize,
    lines: Vec<String>,
}

// Consume the entire physical line, but retain at most 16 KiB for its display.
fn bounded_line(reader: &mut impl BufRead, utf16: Option<bool>) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|e| e.to_string())?;
        if available.is_empty() {
            break;
        }
        let end = match utf16 {
            Some(little) => available
                .chunks_exact(2)
                .position(|unit| {
                    if little {
                        unit == [10, 0]
                    } else {
                        unit == [0, 10]
                    }
                })
                .map(|i| (i + 1) * 2),
            None => available.iter().position(|b| *b == b'\n').map(|i| i + 1),
        };
        let take = end.unwrap_or(available.len());
        let retain = take.min(16384usize.saturating_sub(result.len()));
        result.extend_from_slice(&available[..retain]);
        reader.consume(take);
        if end.is_some() {
            break;
        }
    }
    Ok(result)
}

fn window(path: &Path, start: usize) -> Result<TextWindow, String> {
    let index = index(path)?;
    let start = start.min(index.count.saturating_sub(1));
    let checkpoint = start / 512;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(index.checkpoints[checkpoint]))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    for _ in checkpoint * 512..start {
        bounded_line(&mut reader, index.utf16)?;
    }
    let mut lines = Vec::new();
    for _ in start..index.count.min(start + 160) {
        let bytes = bounded_line(&mut reader, index.utf16)?;
        let text = if let Some(little) = index.utf16 {
            (if little {
                encoding_rs::UTF_16LE
            } else {
                encoding_rs::UTF_16BE
            })
            .decode(&bytes)
            .0
            .trim_end_matches(['\r', '\n'])
            .to_string()
        } else {
            match std::str::from_utf8(&bytes) {
                Ok(text) => text.trim_end_matches(['\r', '\n']).to_string(),
                Err(_) => encoding_rs::GBK
                    .decode(&bytes)
                    .0
                    .trim_end_matches(['\r', '\n'])
                    .to_string(),
            }
        };
        lines.push(if bytes.len() >= 16384 {
            format!("{text} …［超长行预览］")
        } else {
            text
        });
    }
    let after = path.metadata().map_err(|e| e.to_string())?;
    if after.len() != index.size || after.modified().ok() != index.modified {
        return Err("文件已更新，请刷新".into());
    }
    Ok(TextWindow {
        start,
        total: index.count,
        lines,
    })
}

#[tauri::command]
pub async fn read_task_text_window(
    store: State<'_, Store>,
    task_id: String,
    path: String,
    start: usize,
) -> Result<TextWindow, String> {
    let root = root(&store, &task_id)?;
    tauri::async_runtime::spawn_blocking(move || window(&scoped(&root, &path)?, start))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tree_is_sorted_paged_and_scoped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        for i in 0..510 {
            std::fs::write(dir.path().join(format!("file-{i:03}.txt")), "").unwrap();
        }
        let root = dir.path().canonicalize().unwrap();
        let first = directory(&root, "", 0).unwrap();
        assert_eq!(first.entries.len(), 500);
        assert_eq!(first.entries[0].name, "src");
        let second = directory(&root, "", first.next.unwrap()).unwrap();
        assert_eq!(second.entries.len(), 11);
        assert!(second.next.is_none());
        assert!(directory(&root, "..", 0).is_err());
    }
    #[test]
    fn indexed_windows_reach_end_and_invalidate_after_edit() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            file.path(),
            (0..20000)
                .map(|i| format!("line {i}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let result = window(file.path(), 19800).unwrap();
        assert_eq!(result.start, 19800);
        assert_eq!(result.total, 20001);
        assert_eq!(result.lines[0], "line 19800");
        std::fs::write(file.path(), "new\n").unwrap();
        assert_eq!(window(file.path(), 0).unwrap().total, 2);
    }
    #[test]
    fn indexed_utf16_windows_preserve_line_numbers() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let text = (0..2000).map(|i| format!("你好 {i}\n")).collect::<String>();
        let mut bytes = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(file.path(), bytes).unwrap();
        let result = window(file.path(), 1600).unwrap();
        assert_eq!(result.total, 2001);
        assert_eq!(result.lines[0], "你好 1600");
    }
    #[test]
    fn sparse_index_handles_two_million_lines_without_retaining_contents() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let block = "content\n".repeat(10000);
        for _ in 0..200 {
            file.write_all(block.as_bytes()).unwrap();
        }
        let indexed = index(file.path()).unwrap();
        assert_eq!(indexed.count, 2_000_001);
        assert!(indexed.checkpoints.len() < 4000);
        let last = window(file.path(), 1_999_999).unwrap();
        assert_eq!(last.lines, vec!["content", ""]);
    }
}
