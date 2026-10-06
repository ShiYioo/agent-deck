//! Executor 抽象层：把各家的无头 CLI 统一成「拼参数 + 解析 JSONL」两个动作。
//!
//! 新增一个 harness = 新增一个模块，实现 `parse_line` 并在 `Harness`
//! 上补一个分支，前端无需改动。

pub mod codex;
pub mod zcode;

use serde::Serialize;
use serde_json::Value;

/// 受支持的 harness 清单。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Harness {
    Zcode,
    Codex,
}

impl Harness {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "zcode" => Ok(Self::Zcode),
            "codex" => Ok(Self::Codex),
            other => Err(format!("未知的 harness：{other}（当前支持 zcode、codex）")),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Zcode => "zcode",
            Self::Codex => "codex",
        }
    }

    pub fn program(&self) -> &'static str {
        match self {
            Self::Zcode => "zcode",
            Self::Codex => "codex",
        }
    }

    /// 组装无头命令参数（不含程序名本身）。
    ///
    /// - `mode` 仅 zcode 使用（plan/build/edit/yolo），默认 yolo
    /// - `resume` 传入会话 ID 时生成续接命令
    pub fn build_args(
        &self,
        mode: Option<&str>,
        prompt: &str,
        resume: Option<&str>,
    ) -> Vec<String> {
        match self {
            Self::Zcode => {
                let zmode = match mode {
                    Some("plan") => "plan",
                    Some("build") => "build",
                    Some("edit") => "edit",
                    _ => "yolo",
                };
                let mut args = vec!["--json".to_string(), "--mode".into(), zmode.into()];
                if let Some(sid) = resume {
                    args.push("--resume".into());
                    args.push(sid.to_string());
                }
                args.push("-p".into());
                args.push(prompt.to_string());
                args
            }
            Self::Codex => {
                let mut args = vec!["exec".to_string(), "--json".into()];
                args.push("--skip-git-repo-check".into());
                if let Some(sid) = resume {
                    // `codex exec resume <SESSION_ID> [PROMPT]`；--json 属于 exec 层
                    args.push("resume".into());
                    args.push(sid.to_string());
                }
                args.push(prompt.to_string());
                args
            }
        }
    }

    /// 解析一行 stdout/stderr 输出为统一事件。
    pub fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        match self {
            Self::Zcode => zcode::parse_line(line),
            Self::Codex => codex::parse_line(line),
        }
    }
}

/// 统一事件模型：所有 harness 的输出都被归一化成这些事件后推给前端。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 解析出会话 ID，可用于续接
    SessionId {
        id: String,
    },
    UserMessage {
        text: String,
    },
    AssistantMessage {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        tool: String,
        detail: String,
    },
    ToolResult {
        tool: String,
        ok: bool,
        detail: String,
    },
    Status {
        text: String,
    },
    Complete {
        ok: bool,
    },
    /// kind = "auth" 时前端显示登录引导
    Error {
        kind: String,
        message: String,
    },
    /// 无法归类的原始输出
    Raw {
        line: String,
    },
}

/// 事件判别字段：zcode 用 `kind`，Claude 式输出用 `type`，两者都认。
pub(crate) fn event_kind(value: &Value) -> Option<&str> {
    value
        .get("kind")
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str))
}

pub(crate) fn field_str<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
}

pub(crate) fn is_error(obj: &Value) -> bool {
    obj.get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || obj.get("isError").and_then(Value::as_bool).unwrap_or(false)
        || obj
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| s.eq_ignore_ascii_case("error"))
}

/// 错误归类：鉴权类失败标记为 auth，前端据此弹出登录引导。
pub(crate) fn error_kind(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("invalid token")
        || lower.contains("unauthorized")
        || lower.contains("not logged in")
        || lower.contains("login required")
        || lower.contains("authentication required")
        || lower.contains("auth required")
    {
        "auth"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_harness_names() {
        assert_eq!(Harness::parse("zcode").unwrap(), Harness::Zcode);
        assert_eq!(Harness::parse("CODEX").unwrap(), Harness::Codex);
        assert!(Harness::parse("claude").is_err());
    }

    #[test]
    fn zcode_args_initial_and_resume() {
        let args = Harness::Zcode.build_args(Some("build"), "重构 utils", None);
        assert_eq!(args, vec!["--json", "--mode", "build", "-p", "重构 utils"]);

        let args = Harness::Zcode.build_args(None, "继续", Some("sess_1"));
        assert!(args.windows(2).any(|w| w == ["--resume", "sess_1"]));
        assert!(args.contains(&"yolo".to_string()));
    }

    #[test]
    fn codex_args_initial_and_resume() {
        let args = Harness::Codex.build_args(None, "修复 bug", None);
        assert_eq!(
            args,
            vec!["exec", "--json", "--skip-git-repo-check", "修复 bug"]
        );

        let args = Harness::Codex.build_args(None, "继续", Some("abc123"));
        assert!(args.windows(2).any(|w| w == ["resume", "abc123"]));
    }
}
