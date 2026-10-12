//! Sharing boundaries apply to public projections, never to stored originals.
use crate::store::Store;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextPolicy {
    pub version: i64,
    pub allowed_harnesses: Vec<String>,
    pub redact_secrets: bool,
    pub blocked_terms: Vec<String>,
    pub context_window: u64,
    pub output_reserve: u64,
    pub overhead_reserve: u64,
}

impl Default for ContextPolicy {
    fn default() -> Self {
        Self {
            version: 0,
            allowed_harnesses: ["codex", "opencode", "zcode", "deck"]
                .map(String::from)
                .to_vec(),
            redact_secrets: true,
            blocked_terms: Vec::new(),
            context_window: 32_768,
            output_reserve: 8_192,
            overhead_reserve: 8_192,
        }
    }
}

impl ContextPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .allowed_harnesses
            .iter()
            .any(|h| !matches!(h.as_str(), "codex" | "opencode" | "zcode" | "deck"))
            || self.allowed_harnesses.len() > 4
            || self.blocked_terms.len() > 100
            || self
                .blocked_terms
                .iter()
                .any(|s| s.trim().is_empty() || s.len() > 512)
            || !(4_096..=2_000_000).contains(&self.context_window)
            || self.output_reserve < 512
            || self.overhead_reserve < 1_024
            || self
                .output_reserve
                .saturating_add(self.overhead_reserve)
                .saturating_add(1_024)
                > self.context_window
        {
            return Err("共享策略或上下文预算无效".into());
        }
        Ok(())
    }

    pub fn authorize(&self, harness: &str) -> Result<(), String> {
        if !self.allowed_harnesses.iter().any(|h| h == harness) {
            return Err(format!("共享策略未授权向 {harness} 交付会话资料"));
        }
        Ok(())
    }

    pub fn available(&self, request: &str) -> usize {
        self.context_window
            .saturating_sub(self.output_reserve)
            .saturating_sub(self.overhead_reserve)
            .saturating_sub(estimate_tokens(request)) as usize
    }

    pub fn filter(&self, value: &mut Value) {
        match value {
            Value::String(text) => {
                for term in &self.blocked_terms {
                    *text = text.replace(term, "[REDACTED]");
                }
                if self.redact_secrets {
                    *text = redact(text);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|v| self.filter(v)),
            Value::Object(items) => {
                for (key, value) in items {
                    if self.redact_secrets && sensitive_key(key) {
                        *value = Value::String("[REDACTED]".into());
                    } else {
                        self.filter(value);
                    }
                }
            }
            _ => {}
        }
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    matches!(
        key.as_str(),
        "api_key"
            | "apikey"
            | "authorization"
            | "password"
            | "secret"
            | "access_token"
            | "refresh_token"
    )
}

fn redact(text: &str) -> String {
    let mut private = false;
    text.split_inclusive('\n')
        .map(|segment| {
            let ending = if segment.ends_with("\r\n") {
                "\r\n"
            } else if segment.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            let line = segment.strip_suffix(ending).unwrap_or(segment);
            if line.contains("-----BEGIN ") && line.contains("PRIVATE KEY-----") {
                private = true;
            }
            if private {
                if line.contains("-----END ") && line.contains("PRIVATE KEY-----") {
                    private = false;
                }
                return format!("[REDACTED PRIVATE KEY]{ending}");
            }
            let lower = line.to_ascii_lowercase();
            if [
                "api_key",
                "api-key",
                "apikey",
                "password",
                "access_token",
                "refresh_token",
                "authorization:",
                "bearer ",
            ]
            .iter()
            .any(|key| lower.contains(key))
            {
                return format!("[REDACTED CREDENTIAL LINE]{ending}");
            }
            line.split_inclusive(char::is_whitespace)
                .map(|word| {
                    if ["sk-", "ghp_", "github_pat_", "AKIA"]
                        .iter()
                        .any(|prefix| word.trim_start_matches(['"', '\'']).starts_with(prefix))
                    {
                        let whitespace = &word[word.trim_end().len()..];
                        format!("[REDACTED]{whitespace}")
                    } else {
                        word.to_string()
                    }
                })
                .collect::<String>()
                + ending
        })
        .collect::<String>()
}

// Deliberately conservative UTF-8 byte bound, not a model tokenizer.
pub fn estimate_tokens(text: &str) -> u64 {
    text.len() as u64
}

impl Store {
    pub fn context_policy(&self, task_id: &str) -> Result<ContextPolicy, String> {
        let cid = self.ensure_conversation(task_id)?;
        let conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT data FROM context_policies WHERE conversation_id=?1",
                [&cid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Ok(ContextPolicy::default()))
    }

    pub fn save_context_policy(
        &self,
        task_id: &str,
        expected: i64,
        mut policy: ContextPolicy,
    ) -> Result<ContextPolicy, String> {
        policy.validate()?;
        let cid = self.ensure_conversation(task_id)?;
        let _reservation = self.claim_conversation(&cid)?;
        let row = self.get_task(&cid)?.ok_or("会话根任务不存在")?;
        let _workspace = self.claim_workspace(&row.cwd, "update-sharing-policy")?;
        let mut conn = self.conn.lock().map_err(|_| "store poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let raw: Option<String> = tx
            .query_row(
                "SELECT data FROM context_policies WHERE conversation_id=?1",
                [&cid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let old: ContextPolicy = raw
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if expected != old.version {
            return Err("共享策略已更新，请刷新后重试".into());
        }
        policy.version = old.version + 1;
        tx.execute("INSERT INTO context_policies VALUES(?1,?2) ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data",
            params![cid, serde_json::to_string(&policy).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(policy)
    }
}

#[tauri::command]
pub fn get_context_policy(
    store: tauri::State<'_, Store>,
    task_id: String,
) -> Result<ContextPolicy, String> {
    store.context_policy(&task_id)
}
#[tauri::command]
pub fn update_context_policy(
    store: tauri::State<'_, Store>,
    task_id: String,
    expected_version: i64,
    policy: ContextPolicy,
) -> Result<ContextPolicy, String> {
    store.save_context_policy(&task_id, expected_version, policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_nested_credentials_and_keeps_normal_evidence() {
        let p = ContextPolicy {
            blocked_terms: vec!["customer-42".into()],
            ..ContextPolicy::default()
        };
        let mut v = serde_json::json!({"password":"secret","text":"ok customer-42\nAuthorization: Bearer abc\nsk-secret\nsrc/main.rs","nested":[{"api_key":"abc"}]});
        p.filter(&mut v);
        let text = v.to_string();
        assert!(!text.contains("customer-42"));
        assert!(!text.contains("sk-secret"));
        assert!(!text.contains("Bearer abc"));
        assert!(text.contains("src/main.rs"));
        assert_eq!(v["nested"][0]["api_key"], "[REDACTED]");
        assert_eq!(redact("normal\r\nsecond\n\n"), "normal\r\nsecond\n\n");
    }
    #[test]
    fn policy_budget_and_allowlist_are_enforced() {
        let mut p = ContextPolicy::default();
        p.allowed_harnesses = vec!["codex".into()];
        assert!(p.authorize("opencode").is_err());
        assert!(p.authorize("codex").is_ok());
        assert_eq!(p.available("hello"), 16_379);
        p.output_reserve = u64::MAX;
        assert!(p.validate().is_err());
    }
    #[test]
    fn policy_is_versioned_and_does_not_touch_originals() {
        let s = Store::in_memory().unwrap();
        s.create_task("a", "codex", ".", "api_key=original", None, None, None)
            .unwrap();
        s.finish_task("a", "done", Some(0));
        let p = s
            .save_context_policy("a", 0, ContextPolicy::default())
            .unwrap();
        assert_eq!(p.version, 1);
        assert!(s.save_context_policy("a", 0, p).is_err());
        assert_eq!(s.get_task("a").unwrap().unwrap().prompt, "api_key=original");
    }
    #[test]
    fn very_fast_child_completion_does_not_leave_a_delivery_pending() {
        let s = Store::in_memory().unwrap();
        s.create_task("a", "codex", ".", "test", None, None, None)
            .unwrap();
        s.ensure_conversation("a").unwrap();
        s.finish_task("a", "done", Some(0));
        s.record_delivery(
            "a",
            "a",
            &serde_json::json!({
                "context_sync":{"strategy":"replay","task_ids":[]}
            }),
        )
        .unwrap();
        assert_eq!(
            s.conversation_info("a").unwrap().deliveries[0]["status"],
            "done"
        );
    }
    #[test]
    fn branch_launch_reservation_blocks_mutation_but_allows_existing_siblings() {
        let s = Store::in_memory().unwrap();
        s.create_task("a", "codex", ".", "source", None, None, None)
            .unwrap();
        s.ensure_conversation("a").unwrap();
        s.finish_task("a", "done", Some(0));
        s.create_task("b", "opencode", ".", "branch", None, None, None)
            .unwrap();
        s.set_task_conversation("b", "a").unwrap();
        let guard = s.claim_branch_launch("a").unwrap();
        assert!(s.claim_branch_launch("b").is_err());
        s.finish_task("b", "done", Some(0));
        assert!(s.claim_conversation("a").is_err());
        drop(guard);
        assert!(s.claim_conversation("a").is_ok());
    }
}
