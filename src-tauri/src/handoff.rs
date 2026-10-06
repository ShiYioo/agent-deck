//! 会话交接：把一个任务的会话记录压缩成接力 prompt，
//! 交给另一个 harness 继续执行。
//!
//! 压缩策略（token 预算内保信息密度）：
//! - 任务原话永远完整保留（意图不能失真）
//! - 助手消息全保留（决策与结论）
//! - 工具调用/结果截断（过程细节，够定位即可）
//! - thinking/status/raw 丢弃（噪音）
//! - 超预算时保头（前 4000 字符）掐尾，中间插入省略标记

use crate::store::Store;

/// 对话记录的字符预算（约 5-6k token，给目标模型留足工作空间）
const CONVO_BUDGET_CHARS: usize = 24_000;
const HEAD_KEEP: usize = 4_000;
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

/// 按预算截断对话：保头掐尾 + 省略标记。
fn fit_budget(convo: &str) -> String {
    let total = convo.chars().count();
    if total <= CONVO_BUDGET_CHARS {
        return convo.to_string();
    }
    let head: String = convo.chars().take(HEAD_KEEP).collect();
    let tail_keep = CONVO_BUDGET_CHARS - HEAD_KEEP;
    let skip = total - tail_keep;
    let mut tail: String = convo.chars().skip(skip).collect();
    if let Some(pos) = tail.find('\n') {
        tail = tail[pos + 1..].to_string();
    }
    format!("{head}\n\n……（中间部分记录过长，已省略）……\n\n{tail}")
}

/// 构建接力 prompt：任务原话 + 会话记录 + 接手指令。
pub fn build_handoff_prompt(store: &Store, task_id: &str) -> Result<String, String> {
    let row = store
        .get_task(task_id)?
        .ok_or_else(|| format!("unknown task: {task_id}"))?;
    let events = store.get_events(task_id, 0, i64::MAX)?;

    let model_note = row
        .model
        .as_deref()
        .map(|m| format!("（模型 {m}）"))
        .unwrap_or_default();

    let convo = fit_budget(&render_conversation(&events));

    Ok(format!(
        "你接手一个此前由另一个助手（{}{model_note}）执行的任务。以下是完整的任务与会话记录。\n\n\
         ===== 原始任务 =====\n{}\n\n\
         ===== 会话记录 =====\n{}\n\n\
         ===== 接手指令 =====\n\
         1. 先用 git status / git diff 核对工作目录当前状态，确认哪些工作已完成；\n\
         2. 不要重做已完成的部分，不要偏离原始任务目标；\n\
         3. 从会话记录的中断处继续，完成剩余工作。\n\
         现在开始，先核对状态再行动。",
        row.harness,
        row.prompt,
        if convo.is_empty() {
            "（该任务无对话记录，直接执行原始任务）"
        } else {
            &convo
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn seed_task(store: &Store, id: &str) {
        store
            .create_task(
                id,
                "zcode",
                "E:\\demo",
                "把日期工具补上单测",
                Some("yolo"),
                None,
            )
            .unwrap();
        for event in [
            r#"{"type":"assistant_message","text":"我先看了 utils/date.ts，计划用 vitest 补三个用例"}"#,
            r#"{"type":"tool_use","tool":"Bash","detail":"vitest init"}"#,
            r#"{"type":"tool_result","ok":true,"detail":"created vitest.config.ts"}"#,
            r#"{"type":"error","message":"quota exceeded"}"#,
        ] {
            store.append_event(id, event).unwrap();
        }
    }

    #[test]
    fn handoff_prompt_contains_intent_convo_and_instructions() {
        let store = Store::in_memory().unwrap();
        seed_task(&store, "t1");
        let prompt = build_handoff_prompt(&store, "t1").unwrap();

        assert!(
            prompt.contains("把日期工具补上单测"),
            "任务原话必须完整保留"
        );
        assert!(prompt.contains("zcode"));
        assert!(prompt.contains("【助手】"), "助手消息应保留");
        assert!(prompt.contains("vitest"), "工具细节应保留");
        assert!(prompt.contains("quota exceeded"), "错误应保留");
        assert!(prompt.contains("git status"), "接手指令应包含核对状态");
        assert!(prompt.contains("不要重做"), "接手指令应包含不重做");
    }

    #[test]
    fn handoff_prompt_without_events_still_works() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("t2", "codex", ".", "写 README", None, None)
            .unwrap();
        let prompt = build_handoff_prompt(&store, "t2").unwrap();
        assert!(prompt.contains("写 README"));
        assert!(prompt.contains("无对话记录"));
    }

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
    fn long_conversation_gets_budget_marker() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("t3", "zcode", ".", "长任务", None, None)
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
        let prompt = build_handoff_prompt(&store, "t3").unwrap();
        assert!(prompt.contains("已省略"), "超预算必须有省略标记");
        assert!(prompt.chars().count() < CONVO_BUDGET_CHARS + 2000);
    }
}

// ── AI 交接（pi 运行时压缩） ────────────────────────────────

/// AI 交接 prompt 组装：原始任务 + AI 简报 + 会话尾部原文 + 接手指令。
/// 简报为空（压缩失败）时调用方应回退到机械版 build_handoff_prompt。
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
