//! opencode 事件解析（`opencode run --format json` 的 JSONL 事件流）。
//!
//! 事件 schema 抄自 VK `opencode/types.rs`（opencode SDK 真实事件）：
//! - `message.updated`：角色与模型信息（providerID/modelID）
//! - `message.part.updated`：part 枚举 text / reasoning /
//!   tool{callID, state: pending|running|completed|error}
//! - `message.part.delta`：流式增量（跳过，渲染最终文本）
//! - `permission.asked` / `todo.updated` / `session.status` / `session.error`
//!
//! 兼容两种形态：SSE 信封 {type, properties:{...}} 与 run 平铺（字段在顶层）。

use serde_json::Value;

use super::{AgentEvent, error_kind};

pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return vec![AgentEvent::Raw {
            line: line.to_string(),
        }];
    };

    // 信封形态：properties 内才是事件体
    let (etype, body) = match value.get("properties") {
        Some(p) if p.is_object() => (
            value.get("type").and_then(Value::as_str).unwrap_or(""),
            value.get("properties").unwrap(),
        ),
        _ => (
            value.get("type").and_then(Value::as_str).unwrap_or(""),
            &value,
        ),
    };

    let mut events = Vec::new();

    // 会话 ID：顶层或事件体（支撑 --resume 续接）
    let sid = value
        .get("sessionID")
        .and_then(Value::as_str)
        .or_else(|| body.get("sessionID").and_then(Value::as_str));
    if let Some(sid) = sid {
        events.push(AgentEvent::SessionId {
            id: sid.to_string(),
        });
    }

    match etype {
        "message.updated" => {
            let info = body.get("info").unwrap_or(&Value::Null);
            let role = info.get("role").and_then(Value::as_str).unwrap_or("");
            // 模型信息：assistant 消息附带 providerID/modelID
            let model = info
                .get("model")
                .map(|m| {
                    format!(
                        "{}/{}",
                        m.get("providerID").and_then(Value::as_str).unwrap_or("?"),
                        m.get("modelID").and_then(Value::as_str).unwrap_or("?")
                    )
                })
                .or_else(|| {
                    let p = info.get("providerID").and_then(Value::as_str)?;
                    let m = info.get("modelID").and_then(Value::as_str)?;
                    Some(format!("{p}/{m}"))
                });
            match role {
                "assistant" => {
                    if let Some(model) = model {
                        events.push(AgentEvent::Status {
                            text: format!("model: {model}"),
                        });
                    }
                }
                "user" => {
                    // 用户消息回显无正文，跳过
                }
                _ => {}
            }
        }
        // run 平铺事件（opencode run --format json 实测）：
        // {type: text|reasoning|tool_use, part: {...}}——part 结构与 SSE 版一致
        "message.part.updated" | "text" | "reasoning" | "tool_use" => {
            let part = body.get("part").unwrap_or(&Value::Null);
            let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
            match part_type {
                "text" => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            events.push(AgentEvent::AssistantMessage {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                "reasoning" => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            events.push(AgentEvent::Thinking {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                "tool" => {
                    let tool = part
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let state = part.get("state").unwrap_or(&Value::Null);
                    let status = state.get("status").and_then(Value::as_str).unwrap_or("");
                    match status {
                        "pending" | "running" => {
                            // bash 命令透明：展示命令本身而非 JSON/标题
                            let detail = if tool == "bash" {
                                state
                                    .pointer("/input/command")
                                    .and_then(Value::as_str)
                                    .map(|s| truncate(s, 800))
                                    .unwrap_or_else(|| "bash".into())
                            } else {
                                state
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .map(str::to_string)
                                    .unwrap_or_else(|| {
                                        truncate(
                                            &state
                                                .get("input")
                                                .map(Value::to_string)
                                                .unwrap_or_default(),
                                            160,
                                        )
                                    })
                            };
                            events.push(AgentEvent::ToolUse { tool, detail });
                        }
                        "completed" => {
                            let title =
                                state.get("title").and_then(Value::as_str).unwrap_or("完成");
                            let output = state
                                .get("output")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            events.push(AgentEvent::ToolUse {
                                tool: tool.clone(),
                                detail: title.to_string(),
                            });
                            events.push(AgentEvent::ToolResult {
                                tool,
                                ok: true,
                                detail: truncate(output, 400),
                            });
                        }
                        "error" => {
                            let err = state
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("执行出错");
                            events.push(AgentEvent::ToolResult {
                                tool,
                                ok: false,
                                detail: truncate(err, 300),
                            });
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        // 流式增量：最终文本由 message.part.updated 渲染
        "message.part.delta" | "message.part.removed" => {}
        "permission.asked" => {
            let permission = body
                .get("permission")
                .and_then(Value::as_str)
                .unwrap_or("?");
            events.push(AgentEvent::Status {
                text: format!("等待权限：{permission}"),
            });
        }
        "todo.updated" => {
            let n = body
                .get("todos")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            events.push(AgentEvent::Status {
                text: format!("todo 更新：{n} 项"),
            });
        }
        "session.error" | "error" => {
            let err = body.get("error").unwrap_or(body);
            let message = err
                .pointer("/data/message")
                .or_else(|| err.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    err.get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("未知错误")
                        .to_string()
                });
            events.push(AgentEvent::Error {
                kind: error_kind(&message).to_string(),
                message,
            });
        }
        // session.started / session.idle / step.* 等无需渲染
        _ => {}
    }

    events
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(line: &str) -> Vec<AgentEvent> {
        parse_line(line)
    }

    #[test]
    fn text_part_yields_assistant_message_and_session() {
        let evs = events(
            r#"{"type":"message.part.updated","sessionID":"ses_x","part":{"type":"text","messageID":"m1","text":"你好"}}"#,
        );
        assert!(evs.contains(&AgentEvent::SessionId { id: "ses_x".into() }));
        assert!(evs.contains(&AgentEvent::AssistantMessage {
            text: "你好".into()
        }));
    }

    /// `opencode run --format json` 的实测平铺事件（run 模式与 SDK SSE 形态不同名）
    #[test]
    fn flat_run_events_parse_like_sse_parts() {
        let text = events(
            r#"{"type":"text","timestamp":1791700517934,"sessionID":"ses_x","part":{"id":"prt_1","messageID":"m1","sessionID":"ses_x","type":"text","text":"好的","time":{"start":1,"end":2}}}"#,
        );
        assert!(text.contains(&AgentEvent::SessionId { id: "ses_x".into() }));
        assert!(text.contains(&AgentEvent::AssistantMessage {
            text: "好的".into()
        }));

        let tool = events(
            r#"{"type":"tool_use","sessionID":"ses_x","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"ls"},"output":"file1","title":"ls"}}}"#,
        );
        assert!(
            tool.iter()
                .any(|e| matches!(e, AgentEvent::ToolResult { ok: true, .. }))
        );

        let reasoning =
            events(r#"{"type":"reasoning","part":{"type":"reasoning","text":"想一想"}}"#);
        assert!(reasoning.contains(&AgentEvent::Thinking {
            text: "想一想".into()
        }));

        // 上游错误 + 退出码 0：必须产出 Error 而非静默 done
        let error = events(
            r#"{"type":"error","sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"boom ref: err_1"}}}"#,
        );
        assert!(error.iter().any(
            |e| matches!(e, AgentEvent::Error { message, .. } if message == "boom ref: err_1")
        ));
    }

    #[test]
    fn tool_part_lifecycle() {
        let running = events(
            r#"{"type":"message.part.updated","part":{"type":"tool","callID":"c1","tool":"bash","state":{"status":"running","input":{"command":"ls"},"title":"ls"}}}"#,
        );
        assert!(matches!(
            &running[..],
            [AgentEvent::ToolUse { tool, detail }] if tool == "bash" && detail == "ls"
        ));

        let done = events(
            r#"{"type":"message.part.updated","part":{"type":"tool","callID":"c1","tool":"bash","state":{"status":"completed","output":"file1","title":"ls"}}}"#,
        );
        assert!(
            done.iter()
                .any(|e| matches!(e, AgentEvent::ToolResult { ok: true, .. }))
        );
    }

    #[test]
    fn reasoning_part_yields_thinking() {
        let evs = events(
            r#"{"type":"message.part.updated","part":{"type":"reasoning","messageID":"m","text":"先想一下"}}"#,
        );
        assert!(evs.contains(&AgentEvent::Thinking {
            text: "先想一下".into()
        }));
    }

    #[test]
    fn message_updated_reports_model() {
        let evs = events(
            r#"{"type":"message.updated","info":{"id":"m1","role":"assistant","model":{"providerID":"zai","modelID":"glm-4.7"}}}"#,
        );
        assert!(evs.contains(&AgentEvent::Status {
            text: "model: zai/glm-4.7".into()
        }));
    }

    #[test]
    fn error_event_with_real_shape() {
        let evs = events(
            r#"{"type":"error","timestamp":1791287372308,"sessionID":"ses_e","error":{"name":"APIError","data":{"message":"Invalid token."}}}"#,
        );
        assert!(evs.contains(&AgentEvent::SessionId { id: "ses_e".into() }));
        assert!(matches!(
            &evs[..],
            [_, AgentEvent::Error { kind, message }] if kind == "auth" && message == "Invalid token."
        ));
    }

    #[test]
    fn sse_envelope_with_properties_supported() {
        let evs = events(
            r#"{"type":"message.part.updated","properties":{"part":{"type":"text","messageID":"m","text":"SSE 文本"}}}"#,
        );
        assert!(evs.contains(&AgentEvent::AssistantMessage {
            text: "SSE 文本".into()
        }));
    }

    #[test]
    fn non_json_falls_back_to_raw() {
        assert_eq!(
            events("plain"),
            vec![AgentEvent::Raw {
                line: "plain".into()
            }]
        );
    }
}
