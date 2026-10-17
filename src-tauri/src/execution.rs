//! Per-dispatch settings: native capabilities, scoped defaults and immutable snapshots.
use crate::{Store, executors::Harness};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::{AppHandle, State};
static ADAPTER: OnceLock<std::path::PathBuf> = OnceLock::new();

pub(crate) fn initialize(app: &AppHandle) {
    let _ = ADAPTER.set(crate::sidecar_path(app).with_file_name("native-harness.mjs"));
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionConfig {
    // None inherits; an empty string explicitly selects the harness default.
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelCapability {
    pub model: String,
    pub efforts: Vec<String>,
    pub context_window: Option<u64>,
}

type CatalogCache = Mutex<HashMap<String, (Instant, Vec<ModelCapability>)>>;
static CATALOGS: OnceLock<CatalogCache> = OnceLock::new();
static ZCODE_EXECUTION: OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

pub(crate) fn zcode_busy() -> bool {
    ZCODE_EXECUTION
        .get()
        .is_some_and(|lock| lock.try_lock().is_err())
}

pub(crate) fn claim_zcode(
    harness: &str,
) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, String> {
    if !harness.eq_ignore_ascii_case("zcode") {
        return Ok(None);
    }
    ZCODE_EXECUTION
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
        .try_lock_owned()
        .map(Some)
        .map_err(|_| "ZCode 使用全局模型配置，当前已有 ZCode 执行者；请等待结束后再派发".into())
}

fn catalog_output(command: std::process::Command) -> Result<std::process::Output, String> {
    use command_group::AsyncCommandGroup;
    use tokio::io::AsyncReadExt;
    tauri::async_runtime::block_on(async move {
        let mut command = tokio::process::Command::from(command);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = command
            .group()
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdout = child.inner().stdout.take().ok_or("模型目录输出不可用")?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            let mut bytes = Vec::new();
            let mut reader = stdout.take(8 * 1024 * 1024 + 1);
            let (read, status) = tokio::join!(reader.read_to_end(&mut bytes), child.wait());
            read.map_err(|e| e.to_string())?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("模型目录超过读取上限".into());
            }
            Ok(std::process::Output {
                status: status.map_err(|e| e.to_string())?,
                stdout: bytes,
                stderr: Vec::new(),
            })
        })
        .await;
        // Metadata helpers and their service descendants cannot remain after a probe.
        let _ = child.start_kill();
        match result {
            Ok(value) => value,
            Err(_) => {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
                Err("模型目录查询超时，请重试或检查执行器连接".into())
            }
        }
    })
}

fn opencode_catalog(text: &str) -> Result<Vec<ModelCapability>, String> {
    let mut rest = text;
    let mut catalog = Vec::new();
    while let Some(start) = rest.find('{') {
        let mut stream = serde_json::Deserializer::from_str(&rest[start..]).into_iter::<Value>();
        let value = stream
            .next()
            .ok_or("模型元数据缺失")?
            .map_err(|e| e.to_string())?;
        let end = start + stream.byte_offset();
        if let (Some(provider), Some(model)) = (value["providerID"].as_str(), value["id"].as_str())
        {
            catalog.push(ModelCapability {
                model: format!("{provider}/{model}"),
                efforts: value["variants"]
                    .as_object()
                    .map(|v| v.keys().cloned().collect())
                    .unwrap_or_default(),
                context_window: value["limit"]["context"].as_u64(),
            });
        }
        rest = &rest[end..];
    }
    Ok(catalog)
}

fn opencode_command(args: &[&str]) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "opencode"])
            .args(args)
            .creation_flags(0x0800_0000);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = std::process::Command::new("opencode");
        c.args(args);
        c
    }
}

/// OpenCode 2 的纯文本目录：一行一个 `provider/model`。
///
/// 没有 variants / limit.context 可用，能力档位留空即可（前端会显示「不可配置」，
/// 由 CLI 自己按模型默认档位执行）。
fn opencode_catalog_plain(text: &str) -> Vec<ModelCapability> {
    text.lines()
        .map(str::trim)
        .filter(|line| {
            !line.contains(char::is_whitespace)
                && line
                    .split_once('/')
                    .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty())
        })
        .map(|line| ModelCapability {
            model: line.to_string(),
            efforts: Vec::new(),
            context_window: None,
        })
        .collect()
}

/// OpenCode 2 的 `GET /api/model`。
///
/// 这是 v2 里**唯一还带档位与上下文**的通道：`models --verbose` 已被移除，
/// 纯文本目录只有模型名。响应形如
/// `{"data":[{"providerID":"opencode","modelID":"cat-jam-free",
///            "variants":[{"id":"low"},…],"limit":{"context":262144}}]}`。
fn opencode_catalog_api(text: &str) -> Result<Vec<ModelCapability>, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let data = value["data"]
        .as_array()
        .ok_or("OpenCode 模型目录缺少 data 字段")?;
    Ok(data
        .iter()
        .filter_map(|item| {
            let provider = item["providerID"].as_str()?;
            let model = item["modelID"].as_str().or_else(|| item["id"].as_str())?;
            Some(ModelCapability {
                model: format!("{provider}/{model}"),
                // v2 的 variants 是对象数组（v1 是对象映射），取各自的 id
                efforts: item["variants"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .filter_map(|v| v["id"].as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                context_window: item["limit"]["context"].as_u64(),
            })
        })
        .collect())
}

/// OpenCode 的模型目录。
///
/// 依次尝试三条通道，先成功的先用：
///   1. v2 的 `api GET /api/model` —— 带 variants / limit.context（首选）
///   2. v1 的 `models --verbose`   —— NDJSON，带 variants / limit.context
///   3. v2 的 `models`             —— 纯文本一行一个 `provider/model`
///
/// 2.x 移除了 `--verbose`（未知旗标会直接报错退出），也没有 --json / --format，
/// 所以第 2 条在 v2 上必然失败，第 3 条只是兜底（无档位信息）。
fn opencode_models() -> Result<Vec<ModelCapability>, String> {
    if let Ok(output) = catalog_output(opencode_command(&["api", "GET", "/api/model"])) {
        if output.status.success() {
            if let Ok(values) = opencode_catalog_api(&String::from_utf8_lossy(&output.stdout)) {
                if !values.is_empty() {
                    return Ok(values);
                }
            }
        }
    }
    if let Ok(output) = catalog_output(opencode_command(&["models", "--verbose"])) {
        if output.status.success() {
            if let Ok(values) = opencode_catalog(&String::from_utf8_lossy(&output.stdout)) {
                if !values.is_empty() {
                    return Ok(values);
                }
            }
        }
    }
    let output = catalog_output(opencode_command(&["models"]))
        .map_err(|_| "OpenCode 模型能力查询失败".to_string())?;
    if !output.status.success() {
        return Err("OpenCode 模型能力查询失败".into());
    }
    Ok(opencode_catalog_plain(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// ZCode 能力目录：~/.zcode/v2/config.json 的 provider.<id>.models，
/// 含 reasoning.variants（思考档位）。
fn zcode_models() -> Vec<ModelCapability> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(home.join(".zcode/v2/config.json")) else {
        return Vec::new();
    };
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(providers) = cfg.get("provider").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (pid, provider) in providers {
        let Some(models) = provider.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (mid, model) in models {
            let efforts = model
                .pointer("/reasoning/variants")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            out.push(ModelCapability {
                model: format!("{pid}/{mid}"),
                efforts,
                context_window: model.pointer("/limit/context").and_then(|v| v.as_u64()),
            });
        }
    }
    out
}

pub(crate) fn catalog(harness: &str) -> Result<Vec<ModelCapability>, String> {
    let cache = CATALOGS.get_or_init(Default::default);
    if let Some((time, values)) = cache.lock().map_err(|_| "模型目录锁错误")?.get(harness) {
        if time.elapsed().as_secs() < 60 {
            return Ok(values.clone());
        }
    }
    let values = match harness {
        "codex" => {
            let program = crate::discovery::locate(crate::executors::Harness::Codex)
                .ok_or("未找到 codex，请安装并加入 PATH")?
                .path()
                .to_path_buf();
            let mut command = std::process::Command::new("node");
            command.arg(ADAPTER.get().ok_or("模型适配器未初始化")?).arg(
                json!({
                    "harness":"codex","program":program,"probe":true,"probeModels":true
                })
                .to_string(),
            );
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let output = catalog_output(command)?;
            if !output.status.success() {
                return Err("Codex 模型能力查询失败".into());
            }
            let models = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|v| v["type"] == "native.models")
                .ok_or("Codex 未返回模型能力")?;
            serde_json::from_value(models["models"].clone()).map_err(|e| e.to_string())?
        }
        "opencode" => opencode_models()?,
        "zcode" => zcode_models(),
        _ => Vec::new(),
    };
    cache
        .lock()
        .map_err(|_| "模型目录锁错误")?
        .insert(harness.into(), (Instant::now(), values.clone()));
    Ok(values)
}

/// Resolve only exact identifiers or unambiguous spelling variants of a model's
/// leaf name. Substring/fuzzy matches are suggestions, never execution authority.
pub(crate) fn bind_model(hint: &str, models: &[ModelCapability]) -> Result<String, String> {
    if let Some(model) = models.iter().find(|m| m.model == hint) {
        return Ok(model.model.clone());
    }
    let normalize = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let wanted = normalize(hint);
    let matches: Vec<_> = models
        .iter()
        .filter(|m| {
            let leaf = m.model.rsplit(['/', ':']).next().unwrap_or(&m.model);
            !wanted.is_empty() && (normalize(&m.model) == wanted || normalize(leaf) == wanted)
        })
        .collect();
    match matches.as_slice() {
        [model] => Ok(model.model.clone()),
        [] => Err(format!(
            "模型「{hint}」未在该运行器目录中唯一匹配，请选择具体模型"
        )),
        _ => Err(format!("模型「{hint}」对应多个供应商，请选择完整模型 ID")),
    }
}

pub(crate) fn workflow_models(
    store: &Store,
    harness: &str,
) -> Result<Vec<ModelCapability>, String> {
    if harness != "deck" {
        return catalog(harness);
    }
    let mut models = Vec::new();
    for profile in store.list_model_profiles(true)? {
        let mut ids: Vec<String> = store
            .list_profile_models(&profile.id)?
            .into_iter()
            .map(|m| m.model)
            .collect();
        if let Some(model) = profile.model {
            ids.push(model);
        }
        ids.sort();
        ids.dedup();
        models.extend(ids.into_iter().map(|id| ModelCapability {
            model: format!("{}:{id}", profile.id),
            efforts: Vec::new(),
            context_window: None,
        }));
    }
    Ok(models)
}

#[tauri::command]
pub async fn discover_execution_models(
    app: AppHandle,
    harness: String,
) -> Result<Vec<ModelCapability>, String> {
    initialize(&app);
    tauri::async_runtime::spawn_blocking(move || catalog(&harness))
        .await
        .map_err(|e| e.to_string())?
}

fn key(cid: Option<&str>, harness: &str) -> String {
    match cid {
        Some(id) => format!("execution:{id}:{harness}"),
        None => format!("execution:default:{harness}"),
    }
}

fn defaults(store: &Store, cid: Option<&str>, harness: &str) -> Result<ExecutionConfig, String> {
    let parse = |raw: Option<String>| -> Result<ExecutionConfig, String> {
        raw.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
            .unwrap_or(Ok(ExecutionConfig::default()))
    };
    let global = parse(store.get_setting(&key(None, harness))?)?;
    let scoped = if cid.is_some() {
        parse(store.get_setting(&key(cid, harness))?)?
    } else {
        ExecutionConfig::default()
    };
    Ok(ExecutionConfig {
        model: scoped.model.or(global.model),
        effort: scoped.effort.or(global.effort),
    })
}

#[tauri::command]
pub fn get_execution_defaults(
    store: State<'_, Store>,
    task_id: Option<String>,
    harness: String,
) -> Result<ExecutionConfig, String> {
    let cid = task_id
        .as_deref()
        .map(|id| store.ensure_conversation(id))
        .transpose()?;
    defaults(&store, cid.as_deref(), &harness)
}

#[tauri::command]
pub fn set_execution_defaults(
    store: State<'_, Store>,
    task_id: Option<String>,
    harness: String,
    config: ExecutionConfig,
) -> Result<(), String> {
    validate_shape(&harness, &config)?;
    let cid = task_id
        .as_deref()
        .map(|id| store.ensure_conversation(id))
        .transpose()?;
    store.set_setting(
        &key(cid.as_deref(), &harness),
        &serde_json::to_string(&config).map_err(|e| e.to_string())?,
    )
}

fn validate_shape(harness: &str, config: &ExecutionConfig) -> Result<(), String> {
    if harness != "deck" {
        Harness::parse(harness)?;
    }
    for value in [&config.model, &config.effort].into_iter().flatten() {
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err("执行配置无效".into());
        }
    }
    Ok(())
}

pub(crate) fn resolve(
    store: &Store,
    cid: Option<&str>,
    harness: &str,
    requested: &ExecutionConfig,
) -> Result<(ExecutionConfig, String), String> {
    validate_shape(harness, requested)?;
    let base = defaults(store, cid, harness)?;
    let config = ExecutionConfig {
        model: requested.model.clone().or(base.model.clone()),
        effort: requested.effort.clone().or_else(|| {
            if requested.model.is_some() && requested.model != base.model {
                Some(String::new())
            } else {
                base.effort
            }
        }),
    };
    // codex 默认走 app-server 协议适配器：提问（request_user_input）、上下文压缩、
    // 推理档位都在协议通道上；exec --json 缺这些能力。显式设置仍可切回 cli。
    let transport = if harness == "deck" {
        "sidecar".into()
    } else {
        let default = if harness == "codex" { "native" } else { "cli" };
        store
            .get_setting(&format!("transport_{harness}"))?
            .unwrap_or_else(|| default.into())
    };
    if !matches!(transport.as_str(), "cli" | "native" | "acp" | "sidecar") {
        return Err("未知运行入口".into());
    }
    let model = config.model.as_deref().filter(|s| !s.is_empty());
    let effort = config.effort.as_deref().filter(|s| !s.is_empty());
    if transport == "acp" && (model.is_some() || effort.is_some()) {
        return Err("当前 ACP 入口不支持指定模型或思考强度，请选择 CLI 或原生服务".into());
    }
    if let Some(effort) = effort {
        if !matches!(harness, "codex" | "opencode") {
            return Err("当前执行器尚不支持指定思考强度".into());
        }
        let model = model.ok_or("请先选择具体模型再设置思考强度")?;
        let models = catalog(harness)?;
        if !models
            .iter()
            .any(|m| m.model == model && m.efforts.iter().any(|e| e == effort))
        {
            return Err(format!("{model} 不支持思考档位 {effort}，请刷新模型目录"));
        }
    }
    if harness == "opencode" && model.is_some_and(|m| !m.contains('/')) {
        return Err("OpenCode 模型必须使用 provider/model".into());
    }
    if matches!(harness, "codex" | "opencode") && model.is_some() {
        // Populate model-window metadata even when reasoning remains at its default.
        let _ = catalog(harness);
    }
    Ok((config, transport))
}

pub(crate) fn snapshot(
    store: &Store,
    task_id: &str,
    requested: &ExecutionConfig,
    resolved: &ExecutionConfig,
    transport: &str,
) -> Result<(), String> {
    let planning: bool = store.conn.lock().map_err(|_| "store poisoned")?
        .query_row("SELECT EXISTS(SELECT 1 FROM task_events WHERE task_id=?1 AND json_extract(event,'$.planning')=1)",
            [task_id], |row| row.get(0)).map_err(|e| e.to_string())?;
    let value = json!({"requested":requested,"resolved":resolved,"transport":transport,
        "purpose":if planning { "planning" } else { "execution" }});
    let changed = store
        .conn
        .lock()
        .map_err(|_| "store poisoned")?
        .execute(
            "UPDATE tasks SET execution_config=?2 WHERE id=?1 AND execution_config IS NULL",
            rusqlite::params![task_id, value.to_string()],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("执行快照已存在或任务已删除".into());
    }
    Ok(())
}

pub(crate) fn known_window(harness: &str, model: Option<&str>) -> Option<u64> {
    let model = model?;
    CATALOGS
        .get()?
        .lock()
        .ok()?
        .get(harness)?
        .1
        .iter()
        .find(|m| m.model == model)?
        .context_window
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionOverride {
    pub target: String,
    pub version: i64,
    pub config: ExecutionConfig,
}

pub(crate) fn override_config(
    store: &Store,
    run_id: &str,
    target: &str,
    initial: &ExecutionConfig,
) -> Result<ExecutionConfig, String> {
    let values = overrides(store, run_id)?;
    Ok(values
        .into_iter()
        .find(|v| v.target == target)
        .map(|v| v.config)
        .unwrap_or_else(|| initial.clone()))
}

fn overrides(store: &Store, run_id: &str) -> Result<Vec<ExecutionOverride>, String> {
    let conn = store.conn.lock().map_err(|_| "store poisoned")?;
    let mut stmt = conn
        .prepare("SELECT target,version,config FROM execution_overrides WHERE run_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        let (target, version, config) = r.map_err(|e| e.to_string())?;
        Ok(ExecutionOverride {
            target,
            version,
            config: serde_json::from_str(&config).map_err(|e| e.to_string())?,
        })
    })
    .collect()
}

#[tauri::command]
pub fn list_execution_overrides(
    store: State<'_, Store>,
    run_id: String,
) -> Result<Vec<ExecutionOverride>, String> {
    overrides(&store, &run_id)
}

#[tauri::command]
pub async fn update_delegation_execution(
    store: State<'_, Store>,
    run_id: String,
    target: String,
    expected_version: i64,
    config: ExecutionConfig,
) -> Result<ExecutionOverride, String> {
    let target_info = |conn: &rusqlite::Connection| -> Result<(String, String), String> {
        let raw = conn.query_row("SELECT data FROM graph_runs WHERE id=?1 UNION ALL SELECT data FROM collaborations WHERE id=?1", [&run_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let run: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if run["status"] != "running" {
            return Err("协作已结束，不能修改后续派发".into());
        }
        let cid = run["conversation_id"]
            .as_str()
            .ok_or("会话缺失")?
            .to_string();
        let harness = if let Some(nodes) = run["nodes"].as_array() {
            let commander = target.ends_with(":commander");
            let node_id = target.strip_suffix(":commander").unwrap_or(&target);
            let node = nodes
                .iter()
                .find(|n| n["spec"]["id"] == node_id)
                .ok_or("节点不存在")?;
            if node["status"] != "pending"
                && !(node["status"] == "running"
                    && (commander || node["spec"]["supervision"].is_object()))
            {
                return Err("节点已启动，执行快照不可修改".into());
            }
            if commander {
                node["spec"]["supervision"]["commander"]
                    .as_str()
                    .ok_or("指挥方缺失")?
            } else {
                node["spec"]["harness"].as_str().ok_or("执行器缺失")?
            }
        } else {
            match target.as_str() {
                "planning" | "reviewing" => run["mentor"].as_str(),
                "executing" => run["worker"].as_str(),
                _ => None,
            }
            .ok_or("阶段无效")?
        }
        .to_string();
        Ok((cid, harness))
    };
    let (cid, harness) = {
        let conn = store.conn.lock().map_err(|_| "store poisoned")?;
        target_info(&conn)?
    };
    let _reservation = store.claim_conversation_mutation(&cid)?;
    let copy = store.clone_handle();
    let cfg = config.clone();
    tauri::async_runtime::spawn_blocking(move || resolve(&copy, Some(&cid), &harness, &cfg))
        .await
        .map_err(|e| e.to_string())??;
    let mut conn = store.conn.lock().map_err(|_| "store poisoned")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    target_info(&tx)?;
    persist_override(&tx, &run_id, &target, expected_version, &config)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ExecutionOverride {
        target,
        version: expected_version + 1,
        config,
    })
}

fn persist_override(
    conn: &rusqlite::Connection,
    run_id: &str,
    target: &str,
    expected_version: i64,
    config: &ExecutionConfig,
) -> Result<(), String> {
    let changed = if expected_version == 0 {
        conn.execute("INSERT OR IGNORE INTO execution_overrides VALUES(?1,?2,1,?3)",
            rusqlite::params![run_id,target,serde_json::to_string(&config).map_err(|e| e.to_string())?])
    } else {
        conn.execute("UPDATE execution_overrides SET version=version+1,config=?4 WHERE run_id=?1 AND target=?2 AND version=?3",
            rusqlite::params![run_id,target,expected_version,serde_json::to_string(&config).map_err(|e| e.to_string())?])
    }.map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("执行配置已被其他操作修改，请刷新后重试".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_metadata_preserves_real_variants_and_windows() {
        let values = opencode_catalog("opencode/a\n{\"providerID\":\"opencode\",\"id\":\"a\",\"variants\":{\"high\":{}},\"limit\":{\"context\":32000}}\nopencode/b\n{\"providerID\":\"opencode\",\"id\":\"b\",\"variants\":{}}").unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].efforts, vec!["high"]);
        assert_eq!(values[0].context_window, Some(32000));
        assert!(values[1].efforts.is_empty());
    }
    #[test]
    fn plain_catalog_parses_v2_model_lines_and_skips_help_noise() {
        // OpenCode 2 的 `models` 是纯文本：一行一个 provider/model。
        // 未知旗标时 CLI 会把 usage 打到 stdout，这些提示行必须被忽略。
        let values = opencode_catalog_plain(
            "DESCRIPTION\n  List all available models\n\nopencode/mimo-v2.6-flash-free\nzhipuai-coding-plan/glm-5.3\nollama/qwen3.5:2b\n\n",
        );
        assert_eq!(
            values.iter().map(|m| m.model.as_str()).collect::<Vec<_>>(),
            vec![
                "opencode/mimo-v2.6-flash-free",
                "zhipuai-coding-plan/glm-5.3",
                "ollama/qwen3.5:2b",
            ]
        );
        assert!(values[0].efforts.is_empty());
        assert_eq!(values[0].context_window, None);
    }
    #[test]
    fn api_catalog_reads_v2_variants_and_context() {
        // 取自 `opencode api GET /api/model` 的真实响应形状：
        // variants 是对象数组（v1 是对象映射），档位取各自的 id。
        let values = opencode_catalog_api(
            r#"{"location":{"directory":"C:\\w"},"data":[
                {"id":"cat-jam-free","modelID":"cat-jam-free","providerID":"opencode",
                 "variants":[{"id":"low","settings":{"reasoningEffort":"low"}},
                             {"id":"high","settings":{"reasoningEffort":"high"}}],
                 "limit":{"context":262144,"output":131072}},
                {"id":"glm-5.3","modelID":"glm-5.3","providerID":"zhipuai-coding-plan"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].model, "opencode/cat-jam-free");
        assert_eq!(values[0].efforts, vec!["low", "high"]);
        assert_eq!(values[0].context_window, Some(262144));
        // 没有 variants 的模型档位留空，不参与报错
        assert_eq!(values[1].model, "zhipuai-coding-plan/glm-5.3");
        assert!(values[1].efforts.is_empty());
        assert_eq!(values[1].context_window, None);
    }
    #[test]
    fn explicit_default_clears_inheritance_and_unsupported_effort_is_rejected() {
        let store = Store::in_memory().unwrap();
        store
            .set_setting(
                &key(None, "opencode"),
                r#"{"model":"opencode/free","effort":""}"#,
            )
            .unwrap();
        let (config, _) = resolve(&store, None, "opencode", &ExecutionConfig::default()).unwrap();
        assert_eq!(config.model.as_deref(), Some("opencode/free"));
        let (config, _) = resolve(
            &store,
            None,
            "opencode",
            &ExecutionConfig {
                model: Some("".into()),
                effort: Some("".into()),
            },
        )
        .unwrap();
        assert_eq!(config.model.as_deref(), Some(""));
        assert!(
            resolve(
                &store,
                None,
                "zcode",
                &ExecutionConfig {
                    model: None,
                    effort: Some("high".into())
                }
            )
            .is_err()
        );
        store.set_setting("transport_opencode", "acp").unwrap();
        assert!(resolve(&store, None, "opencode", &ExecutionConfig::default()).is_err());
    }
    #[test]
    fn scoped_defaults_merge_fields_and_changed_models_clear_inherited_effort() {
        let store = Store::in_memory().unwrap();
        store
            .set_setting(
                &key(None, "zcode"),
                r#"{"model":"provider/a","effort":"high"}"#,
            )
            .unwrap();
        store
            .set_setting(&key(Some("chat"), "zcode"), r#"{"model":null,"effort":""}"#)
            .unwrap();
        let (config, _) =
            resolve(&store, Some("chat"), "zcode", &ExecutionConfig::default()).unwrap();
        assert_eq!(config.model.as_deref(), Some("provider/a"));
        assert_eq!(config.effort.as_deref(), Some(""));
        let (config, _) = resolve(
            &store,
            None,
            "zcode",
            &ExecutionConfig {
                model: Some("provider/b".into()),
                effort: None,
            },
        )
        .unwrap();
        assert_eq!(config.effort.as_deref(), Some(""));
    }
    #[test]
    fn future_overrides_use_compare_and_swap_and_do_not_rewrite_task_snapshots() {
        let store = Store::in_memory().unwrap();
        store
            .create_task("task", "codex", ".", "request", None, None, None)
            .unwrap();
        let original = ExecutionConfig {
            model: Some("first".into()),
            effort: Some("low".into()),
        };
        snapshot(&store, "task", &original, &original, "cli").unwrap();
        assert!(
            snapshot(
                &store,
                "task",
                &ExecutionConfig::default(),
                &ExecutionConfig::default(),
                "native"
            )
            .is_err()
        );
        {
            let conn = store.conn.lock().unwrap();
            persist_override(&conn, "run", "node", 0, &original).unwrap();
            assert!(
                persist_override(&conn, "run", "node", 0, &ExecutionConfig::default()).is_err()
            );
            persist_override(&conn, "run", "node", 1, &ExecutionConfig::default()).unwrap();
            assert!(persist_override(&conn, "run", "node", 1, &original).is_err());
        }
        assert_eq!(overrides(&store, "run").unwrap()[0].version, 2);
        assert_eq!(
            store
                .get_task("task")
                .unwrap()
                .unwrap()
                .execution_config
                .unwrap()["resolved"]["model"],
            "first"
        );
    }
    #[test]
    fn reasoning_flags_are_per_dispatch_and_preserve_permission_and_resume() {
        let args = Harness::Codex.build_execution_args(
            Some("readonly"),
            Some("gpt"),
            "request",
            Some("sid"),
            &[],
            Some("high"),
        );
        assert!(args.windows(2).any(|v| v == ["--sandbox", "read-only"]));
        assert!(
            args.windows(2)
                .any(|v| v == ["-c", "model_reasoning_effort=\"high\""])
        );
        assert!(args.windows(2).any(|v| v == ["resume", "sid"]));
        assert_eq!(args.last().unwrap(), "request");
        let args = Harness::Opencode.build_execution_args(
            Some("plan"),
            Some("opencode/free"),
            "request",
            Some("sid"),
            &[],
            Some("low"),
        );
        assert!(args.windows(2).any(|v| v == ["--agent", "plan"]));
        // OpenCode 2 不认 `--variant`，档位写进模型串
        assert!(args.windows(2).any(|v| v == ["-m", "opencode/free#low"]));
        assert!(!args.iter().any(|a| a == "--variant"));
        assert!(args.windows(2).any(|v| v == ["-s", "sid"]));
    }
    #[test]
    fn global_zcode_model_selection_excludes_concurrent_runs_and_releases() {
        let first = claim_zcode("zcode").unwrap();
        assert!(claim_zcode("zcode").is_err());
        assert!(claim_zcode("codex").unwrap().is_none());
        drop(first);
        assert!(claim_zcode("zcode").is_ok());
    }
}
