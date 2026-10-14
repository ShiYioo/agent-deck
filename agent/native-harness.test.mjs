import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Rpc, codexItem, historyTool, contextRecords, opencodeEventOutputs } from "./native-harness.mjs";

function fixture() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const sent = [];
  child.stdin.on("data", (data) => sent.push(JSON.parse(data.toString())));
  return { child, sent };
}
test("RPC pairs out-of-order replies without conflating notifications", async () => {
  const { child, sent } = fixture();
  const notifications = [];
  const rpc = new Rpc(child, (v) => notifications.push(v));
  const first = rpc.call("initialize", {});
  const second = rpc.call("thread/start", {});
  child.stdout.write(`${JSON.stringify({ id: sent[1].id, result: { thread: { id: "b" } } })}\n`);
  child.stdout.write('{"method":"thread/started","params":{"id":"b"}}\n');
  child.stdout.write(`${JSON.stringify({ id: sent[0].id, result: { version: "v" } })}\n`);
  assert.deepEqual(await first, { version: "v" });
  assert.deepEqual(await second, { thread: { id: "b" } });
  assert.equal(notifications.length, 1);
  rpc.close();
});
test("timeout and disconnect reject pending work without silently retrying", async () => {
  const { child } = fixture();
  const rpc = new Rpc(child);
  await assert.rejects(rpc.call("initialize", {}, 5), /timeout/);
  const waiting = rpc.call("turn/start", {});
  child.emit("exit", 1);
  await assert.rejects(waiting, /disconnected/);
  assert.equal(rpc.pending.size, 0);
  await assert.rejects(rpc.call("thread/resume", {}), /closed/);
});
test("server approval requests default to rejection", async () => {
  const { child, sent } = fixture();
  const rpc = new Rpc(child);
  child.stdout.write('{"id":8,"method":"item/commandExecution/requestApproval","params":{}}\n');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent[0].id, 8);
  assert.equal(sent[0].error.code, -32601);
  rpc.close();
});
test("native final items are normalized, private reasoning is not projected", () => {
  assert.deepEqual(codexItem({ type: "agentMessage", text: "done" }), { type: "agent_message", text: "done" });
  assert.equal(codexItem({ type: "reasoning", text: "private" }), null);
  assert.equal(codexItem({ type: "commandExecution", command: "test", exitCode: 1 }).exit_code, 1);
});
test("shared history is literal, conversation-scoped and bounded without breaking Unicode", () => {
  const records = Array.from({ length: 23 }, (_, index) => ({ task_id: `source-${index}`, harness: "other", record: { text: "支付约束😀".repeat(1000) } }));
  const search = historyTool(records, "agentdeck_search_history", { query: "支付", offset: 0 });
  assert.equal(search.hits.length, 10);
  assert.equal(search.next_offset, 10);
  const page = historyTool(records, "agentdeck_read_history", { index: 0, offset: 0 });
  assert.ok(Buffer.byteLength(page.text) <= 2048);
  assert.ok(page.next_offset > 0);
  assert.ok(!page.text.includes("\ufffd"));
  assert.equal(historyTool(records, "agentdeck_search_history", { query: "does not exist" }).hits.length, 0);
  assert.throws(() => historyTool(records, "agentdeck_read_history", { index: -1 }), /out of bounds/);
  assert.throws(() => historyTool(records, "agentdeck_search_history", { query: "x", offset: -1 }), /Invalid/);
});
test("large current requests remain reachable without relying on sandbox file access", () => {
  const original = "完整当前要求😀".repeat(1000);
  const archive = { current_user_request: original, records: [{ task_id: "source", record: { text: "older" } }] };
  const records = contextRecords(archive, "transport pointer");
  assert.equal(records[0].record.text, original);
  assert.equal(records[1].task_id, "source");
  assert.equal(archive.records.length, 1);
  assert.ok(historyTool(records, "agentdeck_read_history", { index: 0 }).next_offset > 0);
  assert.equal(contextRecords({ records: [] }, "current")[0].record.text, "current");
});

// ── opencode v2 事件 → 统一输出（提问通道） ──

test("opencode v2 text/reasoning events map to unified parts and filter other sessions", () => {
  const sid = "ses_1";
  assert.deepEqual(
    opencodeEventOutputs({ type: "session.text.ended", data: { sessionID: sid, assistantMessageID: "m1", text: "你好" } }, sid).outputs,
    [{ type: "message.part.updated", sessionID: sid, properties: { part: { type: "text", id: "m1", messageID: "m1", sessionID: sid, text: "你好" }, sessionID: sid } }],
  );
  assert.deepEqual(
    opencodeEventOutputs({ type: "session.reasoning.ended", data: { sessionID: sid, assistantMessageID: "m1", text: "想一下" } }, sid).outputs,
    [{ type: "message.part.updated", sessionID: sid, properties: { part: { type: "reasoning", id: "m1", messageID: "m1", sessionID: sid, text: "想一下" }, sessionID: sid } }],
  );
  // 其它会话的事件必须忽略
  assert.deepEqual(opencodeEventOutputs({ type: "session.text.ended", data: { sessionID: "ses_other", text: "x" } }, sid).outputs, []);
  // 空文本不产生事件
  assert.deepEqual(opencodeEventOutputs({ type: "session.text.ended", data: { sessionID: sid, text: "  " } }, sid).outputs, []);
});

test("opencode tool completion joins text content into a completed part", () => {
  const sid = "ses_1";
  const done = opencodeEventOutputs({ type: "session.tool.success", data: {
    sessionID: sid, id: "c1", assistantMessageID: "m1", name: "bash", input: { command: "ls" },
    content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  } }, sid);
  assert.equal(done.outputs.length, 1);
  assert.equal(done.outputs[0].properties.part.state.status, "completed");
  assert.equal(done.outputs[0].properties.part.state.output, "a\nb");

  const failed = opencodeEventOutputs({ type: "session.tool.failed", data: {
    sessionID: sid, id: "c1", assistantMessageID: "m1", name: "bash", input: {}, error: { message: "boom" },
  } }, sid);
  assert.equal(failed.outputs[0].properties.part.state.status, "error");
  assert.equal(failed.outputs[0].properties.part.state.error, "boom");
});

test("opencode form/question events surface control intents for the UI", () => {
  const sid = "ses_1";
  const created = opencodeEventOutputs({ type: "form.created", data: { form: {
    id: "frm_1", sessionID: sid, title: "选一个", fields: [{ key: "name", type: "string", options: [{ value: "a", label: "a" }] }],
  } } }, sid);
  assert.equal(created.outputs.length, 0);
  assert.equal(created.form.id, "frm_1");
  assert.equal(created.form.fields[0].key, "name");
  // 会话无关的表单必须忽略
  assert.equal(opencodeEventOutputs({ type: "form.created", data: { form: { id: "frm_x", sessionID: "ses_other" } } }, sid).form, undefined);

  assert.equal(opencodeEventOutputs({ type: "form.replied", data: { id: "frm_1", sessionID: sid } }, sid).formSettled, "frm_1");
  assert.equal(opencodeEventOutputs({ type: "form.cancelled", data: { id: "frm_1", sessionID: sid } }, sid).formSettled, "frm_1");
  assert.equal(opencodeEventOutputs({ type: "permission.asked", data: { id: "per_1", sessionID: sid } }, sid).permission, "per_1");
});

test("opencode execution terminal events settle the run", () => {
  const sid = "ses_1";
  assert.deepEqual(opencodeEventOutputs({ type: "session.execution.succeeded", data: { sessionID: sid } }, sid).settle, { ok: true });
  assert.deepEqual(
    opencodeEventOutputs({ type: "session.execution.failed", data: { sessionID: sid, error: { message: "boom" } } }, sid).settle,
    { ok: false, error: { message: "boom" } },
  );
  assert.deepEqual(
    opencodeEventOutputs({ type: "session.execution.interrupted", data: { sessionID: sid, reason: "user" } }, sid).settle,
    { ok: false, interrupted: true },
  );
});
