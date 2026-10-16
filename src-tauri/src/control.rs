//! Loopback control transport. All execution goes through the desktop's existing engine.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct Control {
    app: AppHandle,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    Tasks,
    Runs {
        source_task_id: String,
    },
    Submit {
        source_task_id: String,
        nodes: Vec<crate::orchestration::NodeSpec>,
        max_parallel: usize,
        timeout_secs: u64,
    },
    Cancel {
        id: String,
        node_id: Option<String>,
    },
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    !headers.contains_key("origin")
        && headers.get("authorization").and_then(|h| h.to_str().ok())
            == Some(format!("Bearer {token}").as_str())
}

async fn handle(
    State(control): State<Control>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !authorized(&headers, &control.token) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Unauthorized"})),
        ));
    }
    dispatch(&control.app, request)
        .await
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))))
}

async fn dispatch(app: &AppHandle, request: Request) -> Result<Value, String> {
    use crate::orchestration;
    let store = app.state::<crate::Store>();
    let registry = app.state::<orchestration::GraphRegistry>();
    match request {
        Request::Tasks => {
            // Reuse the store's public task listing rather than exposing database access.
            serde_json::to_value(store.list_tasks(200)?).map_err(|e| e.to_string())
        }
        Request::Runs { source_task_id } => {
            serde_json::to_value(orchestration::list_graph_runs(store, source_task_id)?)
                .map_err(|e| e.to_string())
        }
        Request::Submit {
            source_task_id,
            nodes,
            max_parallel,
            timeout_secs,
        } => {
            let run = orchestration::start_graph_run(
                app.clone(),
                store,
                registry,
                source_task_id,
                nodes,
                max_parallel,
                timeout_secs,
            )
            .await?;
            Ok(json!(run))
        }
        Request::Cancel {
            id,
            node_id: Some(node_id),
        } => {
            orchestration::cancel_graph_node(app.clone(), store, registry, id, node_id)?;
            Ok(json!({ "ok": true }))
        }
        Request::Cancel { id, node_id: None } => {
            orchestration::cancel_graph_run(app.clone(), store, registry, id)?;
            Ok(json!({ "ok": true }))
        }
    }
}

pub(crate) async fn serve(app: AppHandle, directory: std::path::PathBuf) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let discovery = json!({
        "url": format!("http://{address}/v1/control"),
        "token": token,
        "pid": std::process::id(),
        "version": 1
    });
    let path = directory.join("control.json");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(discovery.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, discovery.to_string()).map_err(|e| e.to_string())?;
    let router = Router::new()
        .route("/v1/control", post(handle))
        .layer(DefaultBodyLimit::max(512 * 1024))
        .with_state(Control { app, token });
    axum::serve(listener, router)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_rejects_browser_origins_and_requires_the_exact_token() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "secret"));
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        assert!(!authorized(&headers, "secret"));
        headers.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(authorized(&headers, "secret"));
        headers.insert("origin", "http://localhost:5173".parse().unwrap());
        assert!(!authorized(&headers, "secret"));
    }

    #[test]
    fn external_submit_preserves_supervision_and_dependencies() {
        let request: Request = serde_json::from_value(json!({
            "action": "submit", "source_task_id": "source", "max_parallel": 2, "timeout_secs": 900,
            "nodes": [
                { "id": "api", "harness": "zcode", "prompt": "Implement API", "dependencies": [],
                  "read_only": false, "supervision": {"commander": "opencode", "max_rounds": 3}},
                { "id": "client", "harness": "deck", "prompt": "Verify client", "dependencies": ["api"],
                  "read_only": true, "supervision": {"commander": "codex", "max_rounds": 2}}
            ]
        })).unwrap();
        let Request::Submit {
            nodes,
            max_parallel,
            timeout_secs,
            ..
        } = request
        else {
            panic!()
        };
        assert!(crate::orchestration::validate(&nodes, max_parallel, timeout_secs).is_ok());
        assert_eq!(nodes[1].dependencies, ["api"]);
    }
}
