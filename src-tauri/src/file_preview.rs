//! On-demand, bounded file inspection. Never read media into an IPC payload.
use crate::store::Store;
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tauri::{Manager, State};

const PAGE: usize = 256 * 1024;
const PACKAGE_LIMIT: u64 = 32 * 1024 * 1024;
const XML_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct FilePreview {
    path: String,
    kind: String,
    size: u64,
    content: String,
    next_offset: Option<u64>,
    encoding: String,
    notice: Option<String>,
}

fn resolve(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let requested = Path::new(requested);
    let path = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let path = path
        .canonicalize()
        .map_err(|e| format!("无法读取文件：{e}"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("只能预览该任务工作区内的文件".into());
    }
    Ok(path)
}

fn media_kind(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" => "image",
        "pdf" => "pdf",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" | "aac" | "opus" => "audio",
        "mp4" | "webm" | "mov" | "m4v" | "ogv" => "video",
        _ => return None,
    })
}

fn xml_text(xml: &str) -> Result<String, String> {
    use quick_xml::{Reader, events::Event};
    let mut reader = Reader::from_str(xml);
    let mut output = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(t)) => output.push_str(&t.unescape().map_err(|e| e.to_string())?),
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"p" | b"row" | b"table-row" => output.push('\n'),
                b"tc" | b"c" | b"table-cell" => output.push('\t'),
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("文档解析失败：{e}")),
            _ => {}
        }
    }
    Ok(output)
}

fn spreadsheet_text(xml: &str, shared: &[String], strings: bool) -> Result<Vec<String>, String> {
    use quick_xml::{Reader, events::Event};
    let mut reader = Reader::from_str(xml);
    let mut results = Vec::new();
    let mut value = String::new();
    let mut shared_cell = false;
    let mut capture = false;
    let mut output_bytes = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"si" if strings => value.clear(),
                b"c" if !strings => {
                    value.clear();
                    shared_cell = e
                        .attributes()
                        .flatten()
                        .any(|a| a.key.as_ref() == b"t" && a.value.as_ref() == b"s");
                    let cell = e
                        .attributes()
                        .flatten()
                        .find(|a| a.key.as_ref() == b"r")
                        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
                        .unwrap_or_default();
                    results.push(format!("{cell}\t"));
                }
                b"t" | b"v" => capture = true,
                _ => {}
            },
            Ok(Event::Text(t)) if capture => {
                value.push_str(&t.unescape().map_err(|e| e.to_string())?)
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" | b"v" => capture = false,
                b"si" if strings => {
                    let value: String = value.chars().take(4096).collect();
                    output_bytes += value.len();
                    results.push(value);
                }
                b"c" if !strings => {
                    let resolved = if shared_cell {
                        value
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| shared.get(i))
                            .map(|s| s.as_str())
                            .unwrap_or("[共享文本未加载]")
                    } else {
                        &value
                    };
                    if let Some(cell) = results.last_mut() {
                        cell.extend(resolved.chars().take(4096));
                        output_bytes += cell.len();
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("表格解析失败：{e}")),
            _ => {}
        }
        if results.len() >= 10000 || output_bytes >= PAGE {
            break;
        }
    }
    Ok(results)
}

fn package_preview(path: &Path, ext: &str) -> Result<(String, String, Option<String>), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > PACKAGE_LIMIT {
        return Ok((
            "unsupported".into(),
            String::new(),
            Some("文档超过 32 MiB，请使用外部应用打开".into()),
        ));
    }
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("无法读取压缩文档：{e}"))?;
    let mut output = String::new();
    let mut budget = XML_LIMIT;
    let mut truncated = zip.len() > 1000;
    let mut names = Vec::new();
    for i in 0..zip.len().min(1000) {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        names.push((entry.name().to_string(), entry.size()));
    }
    // Natural numeric ordering for slide1, slide2, ... slide10.
    names.sort_by_key(|(name, _)| {
        let digits: String = name.chars().filter(|c| c.is_ascii_digit()).collect();
        (
            name.split('/').next().unwrap_or("").to_string(),
            digits.parse::<u64>().unwrap_or(0),
            name.clone(),
        )
    });
    if ext == "zip" {
        for (name, size) in names {
            output.push_str(&format!("{name}\t{size} B\n"));
            if output.len() > PAGE {
                truncated = true;
                truncate_text(&mut output, PAGE);
                break;
            }
        }
        return Ok((
            "archive".into(),
            output,
            truncated.then(|| "目录预览最多 1000 项 / 256 KiB，未解压文件".into()),
        ));
    }
    let mut shared = Vec::new();
    // Resolve shared strings before reading worksheet cells.
    if matches!(ext, "xlsx" | "xlsm") {
        names.sort_by_key(|(name, _)| (name != "xl/sharedStrings.xml", name.clone()));
    }
    for (name, _) in names {
        let wanted = match ext {
            "docx" => name == "word/document.xml",
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            "odt" | "odp" | "ods" => name == "content.xml",
            // Spreadsheet indices require resolving shared strings, handled below.
            "xlsx" | "xlsm" => {
                name == "xl/sharedStrings.xml"
                    || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
            }
            _ => false,
        };
        if !wanted {
            continue;
        }
        if budget == 0 {
            truncated = true;
            break;
        }
        let mut entry = zip.by_name(&name).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        (&mut entry)
            .take(budget + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > budget {
            truncated = true;
            break;
        }
        budget -= bytes.len() as u64;
        let xml = String::from_utf8_lossy(&bytes);
        if name == "xl/sharedStrings.xml" {
            shared = spreadsheet_text(&xml, &[], true)?;
        } else {
            output.push_str(&format!("\n── {name} ──\n"));
            if matches!(ext, "xlsx" | "xlsm") {
                output.push_str(&spreadsheet_text(&xml, &shared, false)?.join("\n"));
            } else {
                output.push_str(&xml_text(&xml)?);
            }
            if output.len() > PAGE {
                truncate_text(&mut output, PAGE);
                truncated = true;
                break;
            }
        }
    }
    let notice = if matches!(ext, "xlsx" | "xlsm") {
        Some("轻量预览：按工作表显示单元格地址与缓存值，不计算公式或还原样式。每节最多 10000 项 / 256 KiB，每项最多 4096 字；超出部分不展示。".into())
    } else if truncated {
        Some("文档内容达到预览上限，仅展示部分内容；完整内容请使用外部应用打开".into())
    } else {
        Some("轻量内容预览，不还原分页、图片与排版".into())
    };
    Ok((
        "document".into(),
        output,
        if truncated {
            Some("文档达到预览上限（2 MiB 解压 / 256 KiB 输出），内容不完整".into())
        } else {
            notice
        },
    ))
}

fn truncate_text(text: &mut String, max: usize) {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

#[cfg(test)]
fn inspect(path: &Path, offset: u64) -> Result<FilePreview, String> {
    inspect_limit(path, offset, PAGE)
}

fn inspect_limit(path: &Path, offset: u64, limit: usize) -> Result<FilePreview, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let limit = if limit > PAGE && size > limit as u64 {
        8192
    } else {
        limit
    };
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut preview = FilePreview {
        path: path.to_string_lossy().into_owned(),
        kind: "text".into(),
        size,
        content: String::new(),
        next_offset: None,
        encoding: String::new(),
        notice: None,
    };
    if let Some(kind) = media_kind(&ext) {
        preview.kind = kind.into();
        return Ok(preview);
    }
    if matches!(
        ext.as_str(),
        "zip" | "docx" | "pptx" | "xlsx" | "xlsm" | "odt" | "ods" | "odp"
    ) {
        (preview.kind, preview.content, preview.notice) = package_preview(path, &ext)?;
        return Ok(preview);
    }
    let mut head = [0; 4];
    let head_len = file.read(&mut head).map_err(|e| e.to_string())?;
    let utf16 = head_len >= 2 && (head[..2] == [0xff, 0xfe] || head[..2] == [0xfe, 0xff]);
    if offset > size || (utf16 && offset % 2 != 0) {
        return Err("无效的文件分页位置".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(limit);
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if !utf16 && bytes.contains(&0) {
        preview.kind = "binary".into();
        preview.notice = Some("二进制文件，展示前 4096 字节；可使用外部应用打开".into());
        for (i, chunk) in bytes
            .iter()
            .take(4096)
            .copied()
            .collect::<Vec<_>>()
            .chunks(16)
            .enumerate()
        {
            preview.content.push_str(&format!("{:08x}  ", i * 16));
            for byte in chunk {
                preview.content.push_str(&format!("{byte:02x} "));
            }
            preview.content.push('\n');
        }
        return Ok(preview);
    }
    if utf16 {
        if offset + (bytes.len() as u64) < size && bytes.len() >= 2 {
            let last = &bytes[bytes.len() - 2..];
            let unit = if head[..2] == [0xff, 0xfe] {
                u16::from_le_bytes([last[0], last[1]])
            } else {
                u16::from_be_bytes([last[0], last[1]])
            };
            if (0xd800..=0xdbff).contains(&unit) {
                bytes.truncate(bytes.len() - 2);
            }
        }
        let encoding = if head[..2] == [0xff, 0xfe] {
            encoding_rs::UTF_16LE
        } else {
            encoding_rs::UTF_16BE
        };
        preview.content = encoding.decode(&bytes).0.into_owned();
        preview.encoding = encoding.name().into();
    } else {
        // Keep an incomplete UTF-8 character for the next page.
        if let Err(e) = std::str::from_utf8(&bytes) {
            if e.error_len().is_none() && offset + (bytes.len() as u64) < size {
                bytes.truncate(e.valid_up_to());
            }
        }
        match std::str::from_utf8(&bytes) {
            Ok(text) => {
                preview.content = text.trim_start_matches('\u{feff}').into();
                preview.encoding = "UTF-8".into();
            }
            Err(_) => {
                preview.content = encoding_rs::GBK.decode(&bytes).0.into_owned();
                preview.encoding = "GB18030/GBK（自动识别）".into();
                preview.notice =
                    Some("非 UTF-8 文件，已尝试中文编码；若显示异常请用外部应用打开".into());
            }
        }
    }
    let end = offset + bytes.len() as u64;
    if end < size {
        preview.next_offset = Some(end);
    }
    if ext == "md" || ext == "markdown" {
        preview.kind = "markdown".into();
    }
    Ok(preview)
}

#[tauri::command]
pub async fn preview_task_file(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    task_id: String,
    path: String,
    offset: Option<u64>,
) -> Result<FilePreview, String> {
    let row = store.get_task(&task_id)?.ok_or("任务不存在")?;
    let root = row.worktree_dir.unwrap_or(row.cwd);
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve(Path::new(&root), &path)?;
        // Normal files open as a complete document. Larger files use indexed windows.
        let preview = inspect_limit(&path, offset.unwrap_or(0), 4 * 1024 * 1024)?;
        if media_kind(
            path.extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
        )
        .is_some()
        {
            app.asset_protocol_scope()
                .allow_file(&path)
                .map_err(|e| e.to_string())?;
        }
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct FilePatch {
    text: String,
    truncated: bool,
}

#[tauri::command]
pub async fn get_task_file_patch(
    store: State<'_, Store>,
    task_id: String,
    path: String,
) -> Result<FilePatch, String> {
    let row = store.get_task(&task_id)?.ok_or("任务不存在")?;
    let root = row.worktree_dir.unwrap_or(row.cwd);
    tauri::async_runtime::spawn_blocking(move || file_patch(Path::new(&root), &path))
        .await
        .map_err(|e| e.to_string())?
}

fn file_patch(root: &Path, path: &str) -> Result<FilePatch, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("文件路径不能包含上级目录".into());
    }
    let candidate = root.join(path);
    // Deleted files still need a canonical, in-workspace parent.
    let safe = if candidate.exists() {
        resolve(&root, path)?
    } else {
        let mut ancestor = candidate.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("无效的文件路径")?;
        }
        let canonical = ancestor.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&root) || !candidate.starts_with(&root) {
            return Err("文件超出工作区".into());
        }
        canonical.join(
            candidate
                .strip_prefix(ancestor)
                .map_err(|e| e.to_string())?,
        )
    };
    let rel = safe.strip_prefix(&root).map_err(|e| e.to_string())?;
    if safe
        .metadata()
        .map(|m| m.len() > PACKAGE_LIMIT)
        .unwrap_or(false)
    {
        return Err("文件超过 32 MiB，逐行比较请使用外部应用".into());
    }
    let tracked = crate::turn_git_ok(
        &root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--",
            &rel.to_string_lossy(),
        ],
    )
    .map(|s| !s.trim().is_empty())
    .unwrap_or(false);
    let mut command = std::process::Command::new("git");
    command.current_dir(&root).arg("--literal-pathspecs");
    if tracked {
        command
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--unified=3",
                "--",
            ])
            .arg(rel);
    } else {
        command
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-index",
                "--",
                "/dev/null",
            ])
            .arg(rel);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or("无法读取 Git 输出")?
        .take((PAGE + 1) as u64)
        .read_to_end(&mut bytes);
    let truncated = bytes.len() > PAGE;
    if truncated || read.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    read.map_err(|e| e.to_string())?;
    if !truncated && !status.success() && status.code() != Some(1) {
        return Err("无法生成 Git 补丁；请确认目录是有效的 Git 工作区".into());
    }
    bytes.truncate(PAGE);
    Ok(FilePatch {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_outside_and_directories() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(resolve(root.path(), &outside.path().to_string_lossy()).is_err());
        assert!(resolve(root.path(), "..").is_err());
    }
    #[test]
    fn extracts_office_text_and_resolves_shared_cells() {
        assert_eq!(
            xml_text("<w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p>").unwrap(),
            "A & B\n"
        );
        let shared = spreadsheet_text(
            "<sst><si><t>名称</t></si><si><r><t>hello</t></r><r><t> world</t></r></si></sst>",
            &[],
            true,
        )
        .unwrap();
        assert_eq!(shared, vec!["名称", "hello world"]);
        let cells = spreadsheet_text(
            "<row><c r=\"A1\" t=\"s\"><v>1</v></c><c r=\"B1\"><v>42</v></c></row>",
            &shared,
            false,
        )
        .unwrap();
        assert_eq!(cells, vec!["A1\thello world", "B1\t42"]);
    }
    #[test]
    fn zip_listing_does_not_extract_entries() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        zip.start_file(
            "../../outside.txt",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap();
        let result = inspect(&path, 0).unwrap();
        assert_eq!(result.kind, "archive");
        assert!(result.content.contains("../../outside.txt"));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn patches_new_and_deleted_files_including_removed_parent_directories() {
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .current_dir(root.path())
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        git(&["init"]);
        std::fs::create_dir(root.path().join("nested")).unwrap();
        let path = root.path().join("nested/old.txt");
        std::fs::write(&path, "old value\n").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "baseline",
        ]);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root.path().join("nested")).unwrap();
        let deleted = file_patch(root.path(), "nested/old.txt").unwrap();
        assert!(deleted.text.contains("-old value"));
        std::fs::write(root.path().join("new.txt"), "new value\n").unwrap();
        let added = file_patch(root.path(), "new.txt").unwrap();
        assert!(added.text.contains("+new value"));
        assert!(!added.truncated);
        assert!(file_patch(root.path(), "../outside.txt").is_err());
    }
    #[test]
    fn pages_utf8_without_splitting_characters() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.txt");
        let text = format!("{}你好", "a".repeat(PAGE - 1));
        std::fs::write(&path, &text).unwrap();
        let first = inspect(&path, 0).unwrap();
        assert_eq!(first.content.len(), PAGE - 1);
        let second = inspect(&path, first.next_offset.unwrap()).unwrap();
        assert_eq!(format!("{}{}", first.content, second.content), text);
        assert!(second.next_offset.is_none());
    }
    #[test]
    fn binary_and_utf16_are_bounded_and_readable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("data.bin");
        std::fs::write(&path, vec![0; PAGE * 2]).unwrap();
        assert_eq!(inspect(&path, 0).unwrap().kind, "binary");
        std::fs::write(&path, [0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]).unwrap();
        assert_eq!(inspect(&path, 0).unwrap().content, "你好");
    }
}
