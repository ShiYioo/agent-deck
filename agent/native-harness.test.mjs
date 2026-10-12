import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Rpc, codexItem, historyTool, contextRecords } from "./native-harness.mjs";

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
