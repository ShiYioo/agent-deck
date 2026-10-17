import { expect, test } from "@playwright/test";
import { applyTaskUpdates, restoreTask, type LogItem } from "../src/taskState";
import { buildConversation, createConversationProjector } from "../src/conversation";
import type { TimedAgentEvent, LiveTask } from "../src/types";
import { mockDesktop } from "./helpers";

const item = (key: number, event: TimedAgentEvent): LogItem => ({ key, event });
const task = (events: LogItem[]): LiveTask => ({
  harness: "codex", cwd: ".", prompt: "check", mode: "full", events, running: true, exitCode: null,
});

test("snapshot batches index history once instead of searching it for every token", () => {
  const size = 4000;
  let reads = 0;
  const history = Array.from({ length: size }, (_, key) =>
    item(key, { type: "raw", line: String(key) }));
  history.push(item(size, { type: "assistant_message", text: "draft", streamId: "s", sourceTaskId: "a", streaming: true }));
  const events = new Proxy(history, { get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) reads++;
    return Reflect.get(target, property, receiver);
  } });
  const original = task(events);
  const result = applyTaskUpdates(original, Array.from({ length: 128 }, (_, index) => ({
    taskId: "a", item: item(size + index + 1, {
      type: "assistant_message", streamId: "s", streaming: true, text: `snapshot ${index}`,
    }),
  })));
  expect(reads).toBeLessThan(size * 3);
  expect(result.events).toHaveLength(size + 1);
  expect(result.events[size]).toMatchObject({ key: size, event: { text: "snapshot 127" } });
  expect(original.events[size].event).toMatchObject({ text: "draft" });
});

test("stream indexes preserve source identity, finalization and immutable branches", () => {
  const original = task([]);
  const update = (taskId: string, key: number, text: string, streaming: boolean) => ({
    taskId, item: item(key, { type: "assistant_message", streamId: "shared", text, streaming }),
  });
  const first = applyTaskUpdates(original, [update("a", 1, "a", true)]);
  const branch = applyTaskUpdates(first, [update("b", 2, "b", false)]);
  const final = applyTaskUpdates(first, [update("a", 3, "final", false)]);
  expect(applyTaskUpdates(final, [update("a", 4, "late", true)])).toBe(final);
  expect(applyTaskUpdates(final, [{ taskId: "a", running: true }])).toBe(final);
  const next = applyTaskUpdates(branch, [update("a", 5, "a2", true)]);
  expect(next.events.map(({ event }) => "text" in event ? event.text : "")).toEqual(["a2", "b"]);
  expect(first.events[0].event).toMatchObject({ text: "a" });
  expect(final.events[0]).toMatchObject({ key: 1, event: { text: "final" } });
});

test("replay overlap handles repetitive histories and preserves state-only updates", () => {
  const replay = Array.from({ length: 4000 }, (_, key) => item(key, { type: "raw", line: key === 3999 ? "b" : "a" }));
  const buffered = Array.from({ length: 4000 }, (_, key) => ({
    taskId: "a", item: item(key + 4000, { type: "raw", line: "a" }),
  }));
  const separate = restoreTask(task([]), replay, buffered);
  expect(separate.events).toHaveLength(8000);
  const repeated = restoreTask(task([]), [item(1, { type: "raw", line: "a" }), item(2, { type: "raw", line: "a" })], [
    { taskId: "a", item: item(3, { type: "raw", line: "a" }), running: false },
    { taskId: "a", item: item(4, { type: "raw", line: "a" }) },
    { taskId: "a", item: item(5, { type: "raw", line: "b" }) },
  ]);
  expect(repeated.events).toHaveLength(3);
  expect(repeated.running).toBe(false);
  expect(repeated.events[2].event).toMatchObject({ line: "b" });
});

test("semantic projection reuses history but updates paired tools and ignores bookkeeping", () => {
  const project = createConversationProjector();
  const first = [
    item(0, { type: "assistant_message", text: "history" }),
    item(1, { type: "tool_use", tool: "read", callId: "call", detail: "a.txt", args: { path: "a.txt" } }),
  ];
  const before = project(first);
  const updated = [...first, item(2, { type: "tool_result", tool: "read", callId: "call", ok: true, detail: "ok" })];
  const after = project(updated);
  expect(after).toEqual(buildConversation(updated));
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(before[1]).toMatchObject({ status: "running" });
  expect(after[1]).toMatchObject({ status: "completed" });
  expect(project([...updated, item(3, { type: "session_id", id: "native" })])).toBe(after);
});

test("completion duration projection never mutates persisted events", () => {
  const complete = Object.freeze({ type: "complete" as const, ok: true, ts: 200 });
  const rows = buildConversation([
    item(1, { type: "user_message", text: "start", ts: 100 }),
    item(2, complete),
  ]);
  expect(rows[1]).toMatchObject({ durationMs: 100 });
  expect(complete).not.toHaveProperty("durationMs");
});

test("slow artifact scans stay serial and completion waits for a fresh final snapshot", async ({ page }) => {
  await page.clock.install();
  await mockDesktop(page, false);
  await page.goto("/");
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
      __scanCount: number; __finishScan: (name: string) => void;
    };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__scanCount = 0;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd !== "get_turn_artifacts" || args.taskId !== "new-task") return invoke(cmd, args);
      w.__scanCount++;
      return new Promise((resolve) => {
        w.__finishScan = (name) => resolve({
          base_dir: "C:\\workspace", files: [], artifacts: [{ path: name, kind: "image", size: 100 }],
        });
      });
    };
  });
  await page.locator(".composer-input").fill("@opencode scan");
  await page.locator(".composer-input").press("Enter");
  const count = () => page.evaluate(() => (window as unknown as { __scanCount: number }).__scanCount);
  await expect.poll(count).toBe(1);
  await page.clock.runFor(12_000);
  expect(await count()).toBe(1);
  await page.evaluate(() => (window as unknown as { __emit: (name: string, value: unknown) => void })
    .__emit("task-exit", { taskId: "new-task", code: 0 }));
  await expect(page.locator(".conversation-status")).toContainText("本轮已完成");
  expect(await count()).toBe(1);
  await page.evaluate(() => (window as unknown as { __finishScan: (name: string) => void }).__finishScan("old.png"));
  await expect.poll(count).toBe(2);
  await page.evaluate(() => (window as unknown as { __finishScan: (name: string) => void }).__finishScan("final.png"));
  await expect(page.locator(".turn-artifacts")).toContainText("final.png");
  await expect(page.locator(".turn-artifacts")).not.toContainText("old.png");
});
