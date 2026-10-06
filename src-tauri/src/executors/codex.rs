//! Codex CLI 适配器（`codex exec --json`）。
//!
//! `--json` 输出 JSONL 事件流（thread/turn/item 系列）。解析器同样保持
//! 防御式：未知 item 类型回退为 Raw，官方事件结构变化时不至于中断。

use serde_json::Value;

use super::{AgentEvent, error_kind, field_str, is_error};

pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return vec![AgentEvent::Raw {
            line: line.to_string(),
        }];
    };

    let mut events = Vec::new();
    if let Some(id) = extract_session_id(&value) {
        events.push(AgentEvent::SessionId { id });
    }
    process_value(&mut events, &value);
    events
}

fn process_value(events: &mut Vec<AgentEvent>, obj: &Value) {
    let Some(kind) = obj.get("type").and_then(Value::as_str) else {
        events.push(AgentEvent::Raw {
            line: truncate_json(obj),
        });
        return;
    };

    match kind {
        "thread.started" | "session.started" => {
            if let Some(id) = field_str(obj, &["thread_id", "session_id", "id"]) {
                events.push(AgentEvent::SessionId { id: id.to_string() });
            }
        }
        "item.started" | "item.updated" => {
            // 开始事件暂时不渲染，等 item.completed 带结果再展示
        }
        "item.completed" => process_item(events, obj.get("item")),
        "item.failed" => {
            let message = field_str(obj, &["message", "error"])
                .unwrap_or("item failed")
                .to_string();
            events.push(AgentEvent::Error {
                kind: error_kind(&message).to_string(),
                message,
            });
        }
        "turn.completed" | "task_complete" => {
            events.push(AgentEvent::Complete { ok: true });
        }
        "turn.failed" | "error" => {
            let message = field_str(obj, &["message", "error"])
                .unwrap_or("Unknown error")
                .to_string();
            events.push(AgentEvent::Error {
                kind: error_kind(&message).to_string(),
                message,
            });
        }
        _ => events.push(AgentEvent::Raw {
            line: truncate_json(obj),
        }),
    }
}

fn process_item(events: &mut Vec<AgentEvent>, item: Option<&Value>) {
    let Some(item) = item else { return };
    let Some(item_type) = item.get("type").and_then(Value::as_str) else {
        events.push(AgentEvent::Raw {
            line: truncate_json(item),
        });
        return;
    };

    match item_type {
        "agent_message" => {
            if let Some(text) = field_str(item, &["text", "content"]) {
                events.push(AgentEvent::AssistantMessage {
                    text: text.to_string(),
                });
            }
        }
        "reasoning" => {
            let text = item
                .get("summary")
                .and_then(summary_to_text)
                .or_else(|| field_str(item, &["text", "content"]).map(str::to_string));
            if let Some(text) = text {
                events.push(AgentEvent::Thinking { text });
            }
        }
        "command_execution" => {
            let command = field_str(item, &["command"]).unwrap_or("shell").to_string();
            let exit_code = item.get("exit_code").and_then(Value::as_i64);
            let output = field_str(item, &["output", "aggregated_output"])
                .unwrap_or_default()
                .to_string();
            let detail = if output.is_empty() {
                command.clone()
            } else {
                format!("$ {command}\n{output}")
            };
            events.push(AgentEvent::ToolUse {
                tool: "shell".into(),
                detail: command,
            });
            events.push(AgentEvent::ToolResult {
                tool: "shell".into(),
                ok: exit_code.map(|c| c == 0).unwrap_or(!is_error(item)),
                detail,
            });
        }
        "file_change" => {
            let detail = item
                .get("changes")
                .map(|c| c.to_string())
                .or_else(|| field_str(item, &["path"]).map(str::to_string))
                .unwrap_or_default();
            events.push(AgentEvent::ToolUse {
                tool: "files".into(),
                detail,
            });
        }
        "web_search" => {
            events.push(AgentEvent::ToolUse {
                tool: "web_search".into(),
                detail: field_str(item, &["query", "url"])
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        other => {
            let _ = other;
            events.push(AgentEvent::Raw {
                line: truncate_json(item),
            });
        }
    }
}

fn summary_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                if let Some(t) = field_str(item, &["text"]) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            if out.is_empty() { None } else { Some(out) }
        }
        _ => None,
    }
}

fn truncate_json(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_default();
    if raw.len() > 500 {
        format!("{}…", &raw[..500])
    } else {
        raw
    }
}

/// codex 会话 ID：thread_id / session_id 字段，或任意以 sess_/thread_ 开头的字符串。
pub(crate) fn extract_session_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["thread_id", "session_id", "sessionId"] {
                if let Some(Value::String(s)) = map.get(key) {
                    return Some(s.clone());
                }
            }
            map.values().find_map(extract_session_id)
        }
        Value::Array(items) => items.iter().find_map(extract_session_id),
        Value::String(s) if s.starts_with("sess_") || s.starts_with("thread_") => Some(s.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(line: &str) -> Vec<AgentEvent> {
        parse_line(line)
    }

    #[test]
    fn non_json_line_falls_back_to_raw() {
        assert_eq!(
            events("not json"),
            vec![AgentEvent::Raw {
                line: "not json".into()
            }]
        );
    }

    #[test]
    fn thread_started_yields_session_id() {
        let evs = events(r#"{"type":"thread.started","thread_id":"th_123"}"#);
        assert!(evs.contains(&AgentEvent::SessionId {
            id: "th_123".into()
        }));
    }

    #[test]
    fn agent_message_item() {
        let evs =
            events(r#"{"type":"item.completed","item":{"type":"agent_message","text":"完成了"}}"#);
        assert!(evs.contains(&AgentEvent::AssistantMessage {
            text: "完成了".into()
        }));
    }

    #[test]
    fn command_execution_yields_tool_pair() {
        let evs = events(
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"cargo test","exit_code":0,"output":"ok"}}"#,
        );
        assert!(evs.iter().any(|e| matches!(
            e,
            AgentEvent::ToolUse { tool, .. } if tool == "shell"
        )));
        assert!(
            evs.iter()
                .any(|e| matches!(e, AgentEvent::ToolResult { ok: true, .. }))
        );
    }

    #[test]
    fn turn_completed_and_failed() {
        let evs = events(r#"{"type":"turn.completed","usage":{}}"#);
        assert!(evs.contains(&AgentEvent::Complete { ok: true }));

        let evs = events(r#"{"type":"turn.failed","message":"boom"}"#);
        assert!(matches!(
            &evs[..],
            [AgentEvent::Error { kind, message }] if kind == "other" && message == "boom"
        ));
    }

    #[test]
    fn error_event_auth_classification() {
        let evs = events(r#"{"type":"error","message":"Unauthorized (401)"}"#);
        assert!(matches!(
            &evs[..],
            [AgentEvent::Error { kind, .. }] if kind == "auth"
        ));
    }
}
