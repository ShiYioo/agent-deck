import { build } from "esbuild";
import { performance } from "node:perf_hooks";

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { applyTaskUpdates } = await load("src/taskState.ts");
const conversation = await load("src/conversation.ts");
const size = 10_000;
const events = Array.from({ length: size }, (_, key) => ({
  key, event: { type: "assistant_message", text: `历史消息 ${key}`, sourceTaskId: "task", sourceHarness: "codex" },
}));
events.push({ key: size, event: {
  type: "assistant_message", streamId: "reply", streaming: true, text: "draft",
  sourceTaskId: "task", sourceHarness: "codex",
} });
const initial = { harness: "codex", events, running: true };
const batch = Array.from({ length: 64 }, (_, key) => ({
  taskId: "task", item: { key: size + 1 + key, event: {
    type: "assistant_message", streamId: "reply", streaming: true, text: `snapshot ${key}`,
  } },
}));
// Warm each path before measuring. Timings are local evidence, not CI thresholds.
applyTaskUpdates(initial, batch);
const started = performance.now();
for (let i = 0; i < 100; i++) applyTaskUpdates(initial, batch);
const updateMs = performance.now() - started;
const project = conversation.createConversationProjector?.() ?? conversation.buildConversation;
const first = project(events);
const changed = applyTaskUpdates(initial, batch).events;
const second = project(changed);
const reused = first.slice(0, size).filter((row, index) => row === second[index]).length;
console.log(JSON.stringify({
  historyEvents: size, snapshotsPerBatch: batch.length, batches: 100,
  updateMs: Number(updateMs.toFixed(2)),
  historicalRowsReused: `${reused}/${size}`,
}, null, 2));
