#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function discoveryPath(env = process.env) {
  if (env.AGENT_DECK_CONTROL_FILE) return env.AGENT_DECK_CONTROL_FILE;
  const base = platform() === "win32"
    ? env.APPDATA || join(homedir(), "AppData", "Roaming")
    : platform() === "darwin" ? join(homedir(), "Library", "Application Support")
      : env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "com.shiyoo.agentdeck", "control.json");
}

export async function requestControl(discovery, request) {
  const url = new URL(discovery.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1/control") {
    throw new Error("Invalid local control endpoint");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Control request failed (${response.status})`);
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: {
      source: { type: "string" }, "nodes-file": { type: "string" },
      parallel: { type: "string", default: "2" }, timeout: { type: "string", default: "900" },
      node: { type: "string" }, "control-file": { type: "string" },
      runner: { type: "string" }, "plan-file": { type: "string" }, "request-id": { type: "string" },
      "wait-seconds": { type: "string", default: "3600" }, help: { type: "boolean" },
    },
  });
  const [command, id] = positionals;
  if (values.help || !command) {
    console.log(`runnerctl tasks
runnerctl capabilities [--runner RUNNER]
runnerctl runs --source TASK
runnerctl handoff --source TASK --request-id STABLE_ID --plan-file plan.json
runnerctl submit --source TASK --nodes-file plan.json [--parallel 2] [--timeout 900]
runnerctl wait RUN --source TASK [--wait-seconds 3600]
runnerctl cancel RUN [--node NODE]

AgentDeck must be running. submit requires a completed source.
handoff accepts a running source, acknowledges the plan and releases it before dispatch.
After handoff returns accepted, finish the source turn; do not wait while occupying it.
Output is JSON. Submit once, then query/wait; do not blindly retry timed-out submissions.`);
    return;
  }
  if (!["tasks", "capabilities", "handoff", "runs", "submit", "wait", "cancel"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (["runs", "submit", "handoff", "wait"].includes(command) && !values.source) throw new Error("--source is required");
  if (["wait", "cancel"].includes(command) && !id) throw new Error("Run ID is required");
  const discovery = JSON.parse(await readFile(values["control-file"] || discoveryPath(), "utf8"));
  const request = (data) => requestControl(discovery, data);
  let result;
  if (command === "tasks") result = await request({ action: "tasks" });
  if (command === "capabilities") result = await request({ action: "capabilities", harness: values.runner ?? null });
  if (command === "handoff") {
    if (!values["plan-file"] || !values["request-id"]) throw new Error("--plan-file and stable --request-id are required");
    const plan = JSON.parse(await readFile(values["plan-file"], "utf8"));
    result = await request({ action: "handoff", source_task_id: values.source, request_id: values["request-id"], plan });
  }
  if (command === "runs") result = await request({ action: "runs", source_task_id: values.source });
  if (command === "submit") {
    if (!values["nodes-file"]) throw new Error("--nodes-file is required");
    const plan = JSON.parse(await readFile(values["nodes-file"], "utf8"));
    result = await request({
      action: "submit", source_task_id: values.source, nodes: Array.isArray(plan) ? plan : plan.nodes,
      max_parallel: Number(values.parallel), timeout_secs: Number(values.timeout),
    });
  }
  if (command === "cancel") result = await request({ action: "cancel", id, node_id: values.node ?? null });
  if (command === "wait") {
    const seconds = Number(values["wait-seconds"]);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--wait-seconds must be positive");
    const deadline = Date.now() + seconds * 1000;
    while (true) {
      const runs = await request({ action: "runs", source_task_id: values.source });
      result = runs.find((run) => run.id === id);
      if (!result) throw new Error(`Run not found: ${id}`);
      if (result.status !== "running") break;
      if (Date.now() >= deadline) throw new Error("Wait deadline reached; run continues. Query its status before taking further action.");
      await new Promise((done) => setTimeout(done, 1000));
    }
    if (result.status !== "done") process.exitCode = 2;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
