//! 会话交接：把一个任务的会话记录压缩成接力 prompt，
//! 交给另一个 harness 继续执行。
//!
//! 压缩由 deck 运行时（pi）完成：AI 生成结构化交接简报，
//! 本模块只负责事件流 → 纯文本记录、组装与尾部原文锚。

const ENTRY_TRUNCATE: usize = 240;

fn trunc(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

fn field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

/// 从事件流构建会话记录段落（纯文本，LLM 友好）。
pub(crate) fn render_conversation(events: &[String]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in events {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "user_message" => {
                let text = field(&v, "text");
                if !text.is_empty() {
                    lines.push(format!("【用户】{}", trunc(&text, 1200)));
                }
            }
            "assistant_message" => {
                let text = field(&v, "text");
                if !text.is_empty() {
                    lines.push(format!("【助手】{}", text));
                }
            }
            "tool_use" => {
                lines.push(format!(
                    "  ├ 调用 {}: {}",
                    field(&v, "tool"),
                    trunc(&field(&v, "detail"), ENTRY_TRUNCATE)
                ));
            }
            "tool_result" => {
                let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(true);
                let mark = if ok { "✓" } else { "✗" };
                lines.push(format!(
                    "  └ {} {}",
                    mark,
                    trunc(&field(&v, "detail"), ENTRY_TRUNCATE)
                ));
            }
            "error" => {
                lines.push(format!("  ⚠ 错误：{}", field(&v, "message")));
            }
            // thinking/status/complete/raw：会话交接的噪音，跳过
            _ => {}
        }
    }
    lines.join("\n")
}

pub(crate) fn assistant_text(events: &[String]) -> String {
    let mut messages = Vec::new();
    for raw in events {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) == Some("assistant_message") {
            let text = field(&v, "text");
            if !text.is_empty() {
                messages.push(text);
            }
            continue;
        }
        let Some(message) = v.get("message").filter(|m| m.get("role").and_then(|x| x.as_str()) == Some("assistant")) else {
            continue;
        };
        let text = message.get("content").and_then(|c| c.as_array()).map(|items| {
            items.iter().filter(|c| c.get("type").and_then(|x| x.as_str()) == Some("text"))
                .filter_map(|c| c.get("text").and_then(|x| x.as_str()))
                .collect::<String>()
        }).unwrap_or_default();
        if !text.is_empty() {
            messages.push(text);
        }
    }
    messages.join("\n")
}

// ── AI 交接（pi 运行时压缩） ────────────────────────────────

/// AI 交接 prompt 组装：原始任务 + AI 简报 + 会话尾部原文 + 接手指令。
pub fn assemble_ai_handoff(
    harness: &str,
    model_note: &str,
    original_prompt: &str,
    summary: &str,
    convo_tail: &str,
) -> String {
    format!(
        "你接手一个此前由另一个助手（{harness}{model_note}）执行的任务。

         ===== 原始任务 =====
{original_prompt}

         ===== AI 交接简报（由独立模型从完整会话记录压缩生成）=====
{summary}

         ===== 最近会话原文（尾部）=====
{convo_tail}

         ===== 接手指令 =====
         1. 先用 git status / git diff 核对工作目录当前状态，确认哪些工作已完成；
         2. 不要重做已完成的部分，不要偏离原始任务目标；
         3. 从简报所述的中断处继续，完成剩余工作。
         现在开始，先核对状态再行动。"
    )
}

/// 会话原文的尾部截断（AI 简报之外的原文锚，防幻觉）
pub fn convo_tail(convo: &str, keep_chars: usize) -> String {
    let total = convo.chars().count();
    if total <= keep_chars {
        return convo.to_string();
    }
    let skip = total - keep_chars;
    let mut tail: String = convo.chars().skip(skip).collect();
    if let Some(pos) = tail.find('\n') {
        tail = tail[pos + 1..].to_string();
    }
    tail
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    #[test]
    fn ai_handoff_assembly_contains_all_sections() {
        let prompt = assemble_ai_handoff(
            "zcode",
            "（模型 glm-4.7）",
            "重构支付模块",
            "## 任务
重构支付模块
## 已完成
- 改了 payment.rs",
            "【助手】改完 payment.rs，还没跑测试",
        );
        assert!(prompt.contains("重构支付模块"));
        assert!(prompt.contains("AI 交接简报"));
        assert!(prompt.contains("payment.rs"));
        assert!(prompt.contains("git status"));
        assert!(prompt.contains("不要重做"));
    }

    #[test]
    fn convo_tail_keeps_suffix() {
        let convo = "a
"
        .repeat(100)
            + "最后的现场";
        let tail = convo_tail(&convo, 20);
        assert!(tail.ends_with("最后的现场"));
        assert!(tail.chars().count() <= 21);
    }

    #[test]
    fn render_conversation_captures_dialogue_and_tools() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("t3", "zcode", ".", "长任务", None, None, None)
            .unwrap();
        let long = "x".repeat(3000);
        for i in 0..15 {
            store
                .append_event(
                    "t3",
                    &serde_json::json!({ "type": "assistant_message", "text": format!("{long} #{i}") })
                        .to_string(),
                )
                .unwrap();
        }
        let events = store.get_events("t3", 0, i64::MAX).unwrap();
        let convo = render_conversation(&events);
        assert!(convo.contains("#0"), "早期消息应保留");
        assert!(convo.contains("#14"), "最新消息应保留");
        assert!(convo.contains("【助手】"));
        // 尾部锚应保留最新现场
        assert!(convo_tail(&convo, 3000).ends_with("#14"));
    }
}
