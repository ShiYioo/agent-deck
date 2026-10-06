//! AgentDeck Bridge：随应用分发的 MCP server，让 Codex/ZCode 互相委派任务。
//!
//! 职责：
//! 1. 把内嵌的 bridge.mjs 写到应用数据目录（内容变化时自动更新）
//! 2. 把 bridge 注入/移除 出 ZCode（JSON）与 Codex（TOML）的 MCP 配置
//!
//! 注入纪律：只增删自己的条目，绝不触碰其他内容；TOML 采用文本块操作，
//! 不做整体序列化，避免破坏用户配置里的注释与排版。

use std::path::{Path, PathBuf};

/// 内嵌的 bridge 源码（单一事实来源，随二进制分发）
pub const BRIDGE_SOURCE: &str = include_str!("../bridge/bridge.mjs");
const BRIDGE_FILE: &str = "agent-deck-bridge.mjs";
const ZCODE_MARKER: &str = "agent-deck-bridge";
const CODEX_MARKER: &str = "[mcp_servers.agent-deck-bridge]";

/// bridge.mjs 落盘：内容与内存中源码一致（不存在或已过期则重写）。
pub fn ensure_bridge_file(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join("bridge");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(BRIDGE_FILE);
    let stale = std::fs::read_to_string(&path)
        .map(|existing| existing != BRIDGE_SOURCE)
        .unwrap_or(true);
    if stale {
        std::fs::write(&path, BRIDGE_SOURCE).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn bridge_entry(path: &Path) -> String {
    // 统一用正斜杠：Windows 下 node/TOML 都接受，且避免转义问题
    path.to_string_lossy().replace('\\', "/")
}

fn entry_from_block(block: &str) -> Option<String> {
    block
        .lines()
        .find_map(|l| l.trim().strip_prefix("args = "))
        // args = ["C:/bridge.mjs"] → C:/bridge.mjs
        .map(|s| {
            s.trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .trim_matches('"')
                .to_string()
        })
}

// ── ZCode：JSON 配置（mcp.servers.{name}） ─────────────────────

fn zcode_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".zcode").join("cli").join("config.json"))
}

pub fn zcode_status() -> Result<Option<String>, String> {
    zcode_status_at(&zcode_config_path().ok_or("找不到 home 目录")?)
}

pub fn zcode_inject(bridge_path: &Path) -> Result<String, String> {
    zcode_inject_at(&zcode_config_path().ok_or("找不到 home 目录")?, bridge_path)
}

pub fn zcode_remove() -> Result<bool, String> {
    zcode_remove_at(&zcode_config_path().ok_or("找不到 home 目录")?)
}

fn zcode_status_at(path: &Path) -> Result<Option<String>, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("ZCode 配置解析失败：{e}"))?;
    Ok(value
        .pointer("/mcp/servers/agent-deck-bridge/args/0")
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

fn zcode_inject_at(path: &Path, bridge_path: &Path) -> Result<String, String> {
    if zcode_status_at(path)?.is_some_and(|args| args == bridge_entry(bridge_path)) {
        return Ok("unchanged".into());
    }
    let text = std::fs::read_to_string(path).unwrap_or_else(|_| "{}".into());
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("ZCode 配置解析失败：{e}"))?;

    let servers = value
        .get("mcp")
        .and_then(|m| m.get("servers"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let mut servers = match servers {
        serde_json::Value::Object(map) => map,
        _ => return Err("ZCode 配置的 mcp.servers 不是对象".into()),
    };
    servers.insert(
        ZCODE_MARKER.to_string(),
        serde_json::json!({
            "command": "node",
            "args": [bridge_entry(bridge_path)]
        }),
    );

    let root = match value {
        serde_json::Value::Object(mut map) => {
            let mcp = map.entry("mcp").or_insert_with(|| serde_json::json!({}));
            if !mcp.is_object() {
                return Err("ZCode 配置的 mcp 不是对象".into());
            }
            mcp.as_object_mut()
                .unwrap()
                .insert("servers".into(), serde_json::Value::Object(servers));
            serde_json::Value::Object(map)
        }
        _ => return Err("ZCode 配置根不是对象".into()),
    };

    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(path, out + "\n").map_err(|e| e.to_string())?;
    Ok("written".into())
}

fn zcode_remove_at(path: &Path) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let removed = value
        .get_mut("mcp")
        .and_then(|m| m.get_mut("servers"))
        .and_then(|s| s.as_object_mut())
        .and_then(|s| s.remove(ZCODE_MARKER))
        .is_some();
    if removed {
        let out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(path, out + "\n").map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

// ── Codex：TOML 配置（文本块操作，保留注释与排版） ─────────────

fn codex_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("config.toml"))
}

fn codex_block(bridge_path: &Path) -> String {
    format!(
        "{CODEX_MARKER}\nenabled = true\ncommand = \"node\"\nargs = [\"{}\"]\n",
        bridge_entry(bridge_path)
    )
}

/// TOML 文本中 bridge 块的范围：marker 起点到下一个 section 前的正文末尾。
fn codex_block_span(text: &str) -> Option<(usize, usize)> {
    let start = text.find(CODEX_MARKER)?;
    let rest = &text[start + CODEX_MARKER.len()..];
    let end = rest
        .find("\n[")
        .map(|i| start + CODEX_MARKER.len() + i + 1) // 含换行，保留下一个 section
        .unwrap_or(text.len());
    Some((start, end))
}

pub fn codex_status() -> Result<Option<String>, String> {
    codex_status_at(&codex_config_path().ok_or("找不到 home 目录")?)
}

pub fn codex_inject(bridge_path: &Path) -> Result<String, String> {
    codex_inject_at(&codex_config_path().ok_or("找不到 home 目录")?, bridge_path)
}

pub fn codex_remove() -> Result<bool, String> {
    codex_remove_at(&codex_config_path().ok_or("找不到 home 目录")?)
}

fn codex_status_at(path: &Path) -> Result<Option<String>, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    Ok(codex_block_span(&text).and_then(|(s, e)| entry_from_block(&text[s..e])))
}

fn codex_inject_at(path: &Path, bridge_path: &Path) -> Result<String, String> {
    if codex_status_at(path)?.is_some_and(|args| args == bridge_entry(bridge_path)) {
        return Ok("unchanged".into());
    }
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let block = codex_block(bridge_path);

    let out = if let Some((start, end)) = codex_block_span(&text) {
        format!("{}{}{}", &text[..start], block.trim_end(), &text[end..])
    } else {
        let mut out = text;
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
        out.push_str(&block);
        out
    };
    std::fs::write(path, out).map_err(|e| e.to_string())?;
    Ok("written".into())
}

fn codex_remove_at(path: &Path) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    let Some((start, end)) = codex_block_span(&text) else {
        return Ok(false);
    };
    std::fs::write(path, format!("{}{}", &text[..start], &text[end..]))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agent-deck-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bridge_file_written_and_updated() {
        let dir = temp_dir("file");
        let path = ensure_bridge_file(&dir).unwrap();
        assert!(path.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), BRIDGE_SOURCE);
        assert_eq!(ensure_bridge_file(&dir).unwrap(), path);
    }

    #[test]
    fn zcode_inject_status_remove_roundtrip() {
        let dir = temp_dir("zcode");
        let config = dir.join("config.json");
        std::fs::write(
            &config,
            r#"{"mcp":{"servers":{"comfy":{"command":"comfy.exe"}}},"plugins":{}}"#,
        )
        .unwrap();
        let bridge = PathBuf::from("C:/bridge.mjs");

        assert_eq!(zcode_status_at(&config).unwrap(), None);
        assert_eq!(zcode_inject_at(&config, &bridge).unwrap(), "written");
        assert_eq!(
            zcode_status_at(&config).unwrap().as_deref(),
            Some("C:/bridge.mjs")
        );
        // 幂等
        assert_eq!(zcode_inject_at(&config, &bridge).unwrap(), "unchanged");

        // 其他条目原样保留
        let content = std::fs::read_to_string(&config).unwrap();
        assert!(content.contains("\"comfy\""));
        assert!(content.contains("\"plugins\""));

        assert!(zcode_remove_at(&config).unwrap());
        assert_eq!(zcode_status_at(&config).unwrap(), None);
        assert!(content_contains_key(&config, "comfy"));
    }

    #[test]
    fn codex_inject_status_remove_roundtrip() {
        let dir = temp_dir("codex");
        let config = dir.join("config.toml");
        std::fs::write(
            &config,
            "# 用户注释必须保留\nmodel = \"gpt-5\"\n\n[mcp_servers.existing]\ncommand = \"x\"\n",
        )
        .unwrap();
        let bridge = PathBuf::from("C:/bridge.mjs");

        assert_eq!(codex_status_at(&config).unwrap(), None);
        codex_inject_at(&config, &bridge).unwrap();

        let content = std::fs::read_to_string(&config).unwrap();
        assert!(content.contains("# 用户注释必须保留"));
        assert!(content.contains("[mcp_servers.existing]"));
        assert_eq!(
            codex_status_at(&config).unwrap().as_deref(),
            Some("C:/bridge.mjs")
        );

        // 更新：路径变更后整块刷新，相邻 section 不受影响
        codex_inject_at(&config, Path::new("D:/new.mjs")).unwrap();
        let content = std::fs::read_to_string(&config).unwrap();
        assert!(content.contains("D:/new.mjs"));
        assert!(!content.contains("C:/bridge.mjs"));
        assert!(content.contains("[mcp_servers.existing]"));
        assert!(content.contains("command = \"x\""));

        // 移除
        assert!(codex_remove_at(&config).unwrap());
        assert_eq!(codex_status_at(&config).unwrap(), None);
        let content = std::fs::read_to_string(&config).unwrap();
        assert!(content.contains("model = \"gpt-5\""));
        assert!(content.contains("[mcp_servers.existing]"));
        assert!(!content.contains("agent-deck-bridge"));
    }

    fn content_contains_key(path: &Path, needle: &str) -> bool {
        std::fs::read_to_string(path)
            .map(|s| s.contains(needle))
            .unwrap_or(false)
    }
}
