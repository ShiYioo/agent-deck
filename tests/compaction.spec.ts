import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

/** 发一条消息，得到一个运行中的任务（mock 的首个任务 id = new-task）。 */
async function runningTask(page: Page) {
  await page.goto("/");
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("长任务");
  await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
}

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ([name, body]) =>
      (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit(name as string, body),
    [event, payload] as const,
  );

// opencode / zcode / codex 的压缩都走同一条通路：status 事件携带 compacting 标志
test("压缩状态行在交互层给出提示（task-event 路径）", async ({ page }) => {
  await mockDesktop(page, false);
  await runningTask(page);

  await emit(page, "task-event", { taskId: "new-task", event: { type: "status", text: "正在压缩上下文…", compacting: true } });
  await expect(page.locator(".compaction-notice")).toHaveText("正在压缩上下文…");

  await emit(page, "task-event", { taskId: "new-task", event: { type: "status", text: "上下文压缩完成", compacting: false } });
  await expect(page.locator(".compaction-notice")).toHaveCount(0);
  await expect(page.locator(".activity-event").filter({ hasText: "上下文压缩完成" })).toHaveCount(1);
});

test("deck（pi）压缩事件同时给出状态行与交互层提示", async ({ page }) => {
  await mockDesktop(page, false);
  await runningTask(page);

  await emit(page, "pi-event", { taskId: "new-task", type: "compaction_start", reason: "threshold" });
  await expect(page.locator(".compaction-notice")).toHaveText("正在压缩上下文…");
  await expect(page.locator(".activity-event").filter({ hasText: "正在压缩上下文…" })).toHaveCount(1);

  await emit(page, "pi-event", { taskId: "new-task", type: "compaction_end", result: { estimatedTokensAfter: 32000 } });
  await expect(page.locator(".compaction-notice")).toHaveCount(0);
  await expect(page.locator(".activity-event").filter({ hasText: "上下文压缩完成" })).toHaveCount(1);
});

// /compact：手动压缩上下文，只作用于正在运行的会话
test("/compact 对运行中的会话下发压缩指令，且不派发新任务", async ({ page }) => {
  await mockDesktop(page, false);
  await runningTask(page);
  const dispatched = () => page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length);
  const before = await dispatched();

  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("/compact 保留支付模块的决策");
  await input.press("Enter");

  await expect.poll(() => page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls.includes("task_command"))).toBe(true);
  expect(await dispatched()).toBe(before);
  await expect(page.locator(".action-notice")).toHaveText("已请求压缩上下文…");
});

test("/compact 在没有运行会话时给出提示", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();

  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("/compact");
  await input.press("Enter");

  await expect(page.locator(".action-error")).toHaveText("压缩只能作用于正在运行的会话");
});
