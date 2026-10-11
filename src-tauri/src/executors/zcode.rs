//! ZCode CLI 适配器（`zcode -p <prompt> --json`）。
//!
//! ZCode 无头输出格式未公开文档化，解析器刻意做成防御式：
//! 同时兼容 `kind:` 与 Claude 式 `type:` 两种判别字段，任意深度提取
//! session_id，未识别的行回退为 Raw。真实输出抓取后可进一步精调。

use serde_json::Value;

use super::{AgentEvent, error_kind, event_kind, field_str, is_error};

const TOOL_ID_KEYS: &[&str] = &["tool_use_id", "tool_call_id", "call_id", "id"];

pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return vec![AgentEvent::Raw {
            line: line.to_string(),
        }];
    };

    let mut events = Vec::new();
    if let Some(session_id) = extract_session_id(&value) {
        events.push(AgentEvent::SessionId { id: session_id });
    }
    process_value(&mut events, &value);
    events
}

fn process_value(events: &mut Vec<AgentEvent>, obj: &Value) {
    let Some(kind) = event_kind(obj) else {
        events.push(AgentEvent::Raw {
            line: truncate_json(obj),
        });
        return;
    };

    let inner = obj.get("message").unwrap_or(obj);
    let content = inner.get("content").or_else(|| obj.get("content"));

    match kind {
        "user_message" | "user" | "message" | "assistant" | "assistant_message" => {
            let role = field_str(inner, &["role"])
                .or_else(|| field_str(obj, &["role"]))
                .unwrap_or(if kind.starts_with("user") {
                    "user"
                } else {
                    "assistant"
                });
            match role {
                "user" => collect_block_events(events, content, |events, text| {
                    events.push(AgentEvent::UserMessage {
                        text,
                        hidden: false,
                    });
                }),
                "assistant" => collect_block_events(events, content, |events, text| {
                    events.push(AgentEvent::AssistantMessage { text });
                }),
                _ => events.push(AgentEvent::Status {
                    text: content
                        .and_then(value_to_text)
                        .unwrap_or_else(|| truncate_json(obj)),
                }),
            }
        }
        "tool_use" | "tool_call" => {
            let tool = field_str(obj, &["tool_name", "name", "tool"])
                .or_else(|| field_str(inner, &["tool_name", "name", "tool"]))
                .unwrap_or("tool");
            events.push(AgentEvent::ToolUse {
                tool: tool.to_string(),
                detail: summarize_args(obj),
            });
        }
        "tool_result" | "tool_call_result" | "task_output" => {
            let ok = !is_error(obj);
            let detail = field_str(obj, &["output", "result", "content", "text"])
                .unwrap_or_default()
                .to_string();
            let tool = field_str(obj, TOOL_ID_KEYS).unwrap_or("tool").to_string();
            events.push(AgentEvent::ToolResult { tool, ok, detail });
        }
        // opencode --format json 的增量消息：message.part / message.part.updated
        k if k.contains("message.part") => {
            let part = obj.get("part").unwrap_or(&Value::Null);
            if let Some(text) = part
                .get("text")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
            {
                events.push(AgentEvent::AssistantMessage {
                    text: text.to_string(),
                });
            }
        }
        "thinking" => {
            if let Some(text) = obj
                .get("thinking")
                .or_else(|| obj.get("text"))
                .and_then(value_to_text)
            {
                events.push(AgentEvent::Thinking { text });
            }
        }
        "init" | "session_startup" | "started" | "turn" => {
            if let Some(model) = field_str(obj, &["model", "model_id"]) {
                events.push(AgentEvent::Status {
                    text: format!("model: {model}"),
                });
            }
        }
        "complete" | "result" | "done" | "turn_complete" => {
            // ok 字段优先；未写 ok 时，只要带 error 字段就算失败
            let has_error = obj.get("error").is_some();
            let ok = obj.get("ok").and_then(Value::as_bool).unwrap_or(!has_error) && !is_error(obj);
            if ok {
                events.push(AgentEvent::Complete { ok: true });
            } else {
                let message = error_message(obj).unwrap_or_else(|| "执行失败".to_string());
                events.push(AgentEvent::Error {
                    kind: error_kind(&message).to_string(),
                    message,
                });
            }
        }
        "error" => {
            let message = field_str(obj, &["message", "error"])
                .unwrap_or("Unknown error")
                .to_string();
            events.push(AgentEvent::Error {
                kind: error_kind(&message).to_string(),
                message,
            });
        }
        // 流式增量等高频事件太吵，跳过
        "deltas" | "stream_event" | "delta" | "ping" => {}
        other => {
            let _ = other;
            events.push(AgentEvent::Raw {
                line: truncate_json(obj),
            });
        }
    }
}

/// content 可能是纯文本，也可能是 Claude 式的块数组；
/// 块里的 tool_use / tool_result 走各自的处理路径。
fn collect_block_events<F>(events: &mut Vec<AgentEvent>, content: Option<&Value>, mut push_text: F)
where
    F: FnMut(&mut Vec<AgentEvent>, String),
{
    match content {
        Some(Value::String(text)) => {
            if !text.trim().is_empty() {
                push_text(events, text.clone());
            }
        }
        Some(Value::Array(blocks)) => {
            let mut text_buf = String::new();
            for block in blocks {
                match event_kind(block).unwrap_or_default() {
                    "text" => {
                        if let Some(t) = field_str(block, &["text"]) {
                            if !text_buf.is_empty() {
                                text_buf.push('\n');
                            }
                            text_buf.push_str(t);
                        }
                    }
                    "tool_use" | "tool_call" => {
                        let tool =
                            field_str(block, &["tool_name", "name", "tool"]).unwrap_or("tool");
                        events.push(AgentEvent::ToolUse {
                            tool: tool.to_string(),
                            detail: summarize_args(block),
                        });
                    }
                    "tool_result" | "tool_call_result" => {
                        events.push(AgentEvent::ToolResult {
                            tool: field_str(block, TOOL_ID_KEYS).unwrap_or("tool").to_string(),
                            ok: !is_error(block),
                            detail: field_str(block, &["output", "result", "content"])
                                .unwrap_or_default()
                                .to_string(),
                        });
                    }
                    _ => {}
                }
            }
            if !text_buf.is_empty() {
                push_text(events, text_buf);
            }
        }
        Some(_) => {
            if let Some(text) = content.and_then(value_to_text) {
                if !text.trim().is_empty() {
                    push_text(events, text);
                }
            }
        }
        None => {}
    }
}

fn error_message(obj: &Value) -> Option<String> {
    obj.get("error")
        .map(|e| {
            field_str(e, &["message", "error", "name"])
                .map(str::to_string)
                .unwrap_or_else(|| e.to_string())
        })
        .or_else(|| field_str(obj, &["error", "message"]).map(str::to_string))
}

fn value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let mut out = String::new();
            for block in blocks {
                if event_kind(block) == Some("text")
                    && let Some(t) = field_str(block, &["text"])
                {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            if out.is_empty() { None } else { Some(out) }
        }
        Value::Object(_) => Some(serde_json::to_string_pretty(value).ok()?),
        _ => None,
    }
}

fn summarize_args(obj: &Value) -> String {
    let args = obj
        .get("parameters")
        .or_else(|| obj.get("input"))
        .or_else(|| obj.get("arguments"))
        .or_else(|| obj.get("args"));
    match args {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| {
                let v = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let v = if v.len() > 80 {
                    format!("{}…", &v[..80])
                } else {
                    v
                };
                format!("{k}: {v}")
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
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

/// 任意深度搜索会话 ID：优先 session_id/sessionId/sessionID 字段，
/// 其次 sess_/ses_ 前缀的字符串值（zcode 与 opencode 各用其一）。
pub(crate) fn extract_session_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["session_id", "sessionId", "sessionID", "thread_id"] {
                if let Some(Value::String(s)) = map.get(key) {
                    return Some(s.clone());
                }
            }
            map.values().find_map(extract_session_id)
        }
        Value::Array(items) => items.iter().find_map(extract_session_id),
        Value::String(s) if s.starts_with("sess_") || s.starts_with("ses_") => Some(s.clone()),
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
            events("plain text output"),
            vec![AgentEvent::Raw {
                line: "plain text output".into()
            }]
        );
    }

    #[test]
    fn session_id_direct_field() {
        let evs = events(r#"{"kind":"complete","session_id":"sess_abc"}"#);
        assert!(evs.contains(&AgentEvent::SessionId {
            id: "sess_abc".into()
        }));
    }

    #[test]
    fn session_id_nested_and_prefix_string() {
        let evs = events(r#"{"result":{"trace":["sess_nested"]}}"#);
        assert!(evs.contains(&AgentEvent::SessionId {
            id: "sess_nested".into()
        }));
    }

    #[test]
    fn assistant_message_via_type_discriminator() {
        let evs = events(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好"}]}}"#,
        );
        assert!(evs.contains(&AgentEvent::AssistantMessage {
            text: "你好".into()
        }));
    }

    #[test]
    fn tool_use_and_result() {
        let evs = events(r#"{"kind":"tool_use","name":"Bash","input":{"command":"ls"}}"#);
        assert!(matches!(
            &evs[..],
            [AgentEvent::ToolUse { tool, .. }] if tool == "Bash"
        ));

        let evs = events(r#"{"kind":"tool_result","id":"t1","is_error":false,"output":"done"}"#);
        assert!(matches!(
            &evs[..],
            [AgentEvent::ToolResult { ok: true, detail, .. }] if detail == "done"
        ));
    }

    #[test]
    fn auth_error_classified() {
        let evs = events(r#"{"kind":"error","message":"Invalid token. (request id: xxx)"}"#);
        assert!(matches!(
            &evs[..],
            [AgentEvent::Error { kind, .. }] if kind == "auth"
        ));
    }

    #[test]
    fn complete_success_and_failure() {
        let evs = events(r#"{"kind":"complete","ok":true}"#);
        assert!(evs.contains(&AgentEvent::Complete { ok: true }));

        let evs = events(r#"{"kind":"result","error":{"message":"boom"}}"#);
        assert!(matches!(
            &evs[..],
            [AgentEvent::Error { kind, message }] if kind == "other" && message == "boom"
        ));
    }

    #[test]
    fn streaming_deltas_skipped() {
        assert!(events(r#"{"kind":"deltas","text":"a"}"#).is_empty());
        assert!(events(r#"{"type":"stream_event"}"#).is_empty());
    }
}
