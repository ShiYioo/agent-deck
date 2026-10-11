import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sidecar = process.env.DECK_TEST_SIDECAR ?? fileURLToPath(new URL("./deck-agent.mjs", import.meta.url));

async function fixture(t, respond) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-runtime-test-"));
  await fs.writeFile(path.join(cwd, "marker.txt"), "PROJECT_DIRECTORY_MARKER");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push({ url: req.url, body });
    await respond(body, res, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const profiles = [{
    id: "fixture", provider: "custom", key: "fixture-key",
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    model: "fixture-model", protocol: "chat",
  }];
  const children = [];
  function launch() {
    const child = spawn(process.execPath, [sidecar], {
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(cwd, ".pi") },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    children.push(child);
    const events = [];
    let stderr = "";
    let exited = false;
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", () => { exited = true; });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try { events.push(JSON.parse(line)); } catch {}
    });
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    async function waitFor(predicate) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const found = events.find(predicate);
        if (found) return found;
        if (exited) throw new Error(`Early exit: ${stderr}\n${JSON.stringify(events)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timeout: ${stderr}\n${JSON.stringify(events)}`);
    }
    const run = (extra = {}) => send({ cmd: "run", cwd, profiles, prompt: "Say hello", ...extra });
    return { child, events, send, waitFor, run };
  }
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { cwd, requests, launch, profiles };
}

function stream(res, { text, tool } = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  chunk({ role: "assistant" });
  if (tool) chunk({ tool_calls: [{
    index: 0, id: tool.id, type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
  }] });
  if (text) chunk({ content: text });
  chunk({}, tool ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

test("sidecar uses configured base_url, streams, and resumes without internal memory prompts", { timeout: 45000 }, async (t) => {
  const f = await fixture(t, async (_body, res) => stream(res, { text: "Hello from fixture" }));
  const first = f.launch();
  first.run();
  assert.equal((await first.waitFor((e) => e.type === "deck_run_end")).ok, true);
  const file = first.events.find((e) => e.type === "deck_session_file")?.path;
  assert.ok(file);
  assert.ok(first.events.some((e) => e.type === "message_update"));
  first.send({ cmd: "close" });
  const second = f.launch();
  second.run({ prompt: "Follow up", resumeSessionFile: file });
  assert.equal((await second.waitFor((e) => e.type === "deck_run_end")).ok, true);
  assert.equal(f.requests[0].url, "/v1/chat/completions");
  const messages = f.requests.at(-1).body.messages;
  assert.ok(messages.some((m) => m.role === "assistant" && m.content.includes("Hello from fixture")));
  assert.ok(messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Follow up")));
  assert.ok(!messages.some((m) => String(m.content).includes("===== 会话记录 =====")));
});

test("approved tools use project cwd and support repeated approvals", { timeout: 45000 }, async (t) => {
  const f = await fixture(t, async (body, res, count) => {
    const names = (body.tools ?? []).map((tool) => tool.function.name);
    assert.ok(names.includes("read"), `Missing read: ${names}`);
    if (count <= 2) stream(res, { tool: { id: `read-${count}`, name: "read", args: { path: "marker.txt" } } });
    else stream(res, { text: "Read complete" });
  });
  const run = f.launch();
  run.run({ mode: "approved" });
  for (const id of ["read-1", "read-2"]) {
    await run.waitFor((e) => e.type === "deck_approval_request" && e.id === id);
    run.send({ cmd: "approve", id });
  }
  assert.equal((await run.waitFor((e) => e.type === "deck_run_end")).ok, true);
  const results = run.events.filter((e) => e.type === "tool_execution_end");
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => JSON.stringify(e.result).includes("PROJECT_DIRECTORY_MARKER")));
});

test("abort resolves pending approval and never reports success", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, async (_body, res) => stream(res, {
    tool: { id: "blocked-read", name: "read", args: { path: "marker.txt" } },
  }));
  const run = f.launch();
  run.run({ mode: "approved" });
  await run.waitFor((e) => e.type === "deck_approval_request");
  run.send({ cmd: "abort" });
  const end = await run.waitFor((e) => e.type === "deck_run_end");
  assert.equal(end.status, "cancelled");
  assert.equal(end.ok, false);
});

test("provider errors produce visible failure rather than a successful end", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, async (_body, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Fixture invalid API key" } }));
  });
  const run = f.launch();
  run.run();
  const error = await run.waitFor((e) => e.type === "deck_error");
  assert.match(error.message, /Fixture invalid API key/);
  assert.equal((await run.waitFor((e) => e.type === "deck_run_end")).ok, false);
});

test("stdin EOF waits for in-flight requests to finish", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, async (_body, res) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stream(res, { text: "Completed after EOF" });
  });
  const run = f.launch();
  run.run();
  run.child.stdin.end();
  assert.equal((await run.waitFor((e) => e.type === "deck_run_end")).ok, true);
});

test("missing resume files fail explicitly instead of silently losing context", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, async (_body, res) => stream(res, { text: "Must not be called" }));
  const run = f.launch();
  run.run({ resumeSessionFile: path.join(f.cwd, "missing-session.jsonl") });
  const error = await run.waitFor((e) => e.type === "deck_error");
  assert.match(error.message, /missing-session\.jsonl/);
  assert.equal(f.requests.length, 0);
});

test("summarization is tool-free and returns before EOF shuts down the sidecar", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, async (_body, res) => stream(res, { text: "Fixture summary" }));
  const run = f.launch();
  run.send({
    cmd: "summarize", cwd: f.cwd, text: "Conversation text",
    profiles: f.profiles,
  });
  run.child.stdin.end();
  assert.equal((await run.waitFor((e) => e.type === "deck_summarize_result")).text, "Fixture summary");
  assert.equal(f.requests[0].body.tools?.length ?? 0, 0);
});
