import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

async function details(page: Page) {
  await page.goto("/");
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
}

async function choose(page: Page, title: string, option: string) {
  await expect(page.getByRole("button", { name: title, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("option", { name: option.endsWith("-free") ? `${option} 免费` : option, exact: true }).click();
}

test("handoff uses the recipient model and native reasoning variant", async ({ page }, testInfo) => {
  await mockDesktop(page, false);
  await details(page);
  await page.locator("summary").filter({ hasText: /^会话接力$/ }).click();
  await choose(page, "opencode 接力 模型", "opencode/test-free");
  await choose(page, "opencode 接力 思考强度", "高");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("execution-desktop.png") });
  await page.getByRole("button", { name: "用 opencode 接力", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testRequests: { harness: string; model: string; effort: string }[];
  }).__testRequests.at(-1))).toMatchObject({ harness: "opencode", model: "opencode/test-free", effort: "high" });
});

test("guided phases carry separate execution configurations", async ({ page }) => {
  await mockDesktop(page, false);
  await details(page);
  await page.locator("summary").filter({ hasText: /^互相指导$/ }).click();
  await page.getByLabel("执行方", { exact: true }).selectOption("opencode");
  await choose(page, "planning 模型", "gpt-test");
  await choose(page, "planning 思考强度", "高");
  await choose(page, "executing 模型", "opencode/test-free");
  await choose(page, "executing 思考强度", "低");
  await choose(page, "reviewing 模型", "gpt-test");
  await choose(page, "reviewing 思考强度", "中");
  await page.getByRole("button", { name: "开始指导协作", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testCollaborationRequest: { execution: unknown };
  }).__testCollaborationRequest?.execution)).toEqual({
    planning: { model: "gpt-test", effort: "high" },
    executing: { model: "opencode/test-free", effort: "low" },
    reviewing: { model: "gpt-test", effort: "medium" },
  });
});

test("pending node overrides keep a conflicted draft and fit a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, false);
  await details(page);
  await page.locator("summary").filter({ hasText: /^并行协作$/ }).click();
  await page.getByRole("textbox", { name: "task-1 任务要求", exact: true }).fill("review");
  await page.getByRole("textbox", { name: "task-2 任务要求", exact: true }).fill("verify");
  await choose(page, "task-1 模型", "gpt-test");
  await choose(page, "task-1 思考强度", "低");
  await page.getByRole("button", { name: "启动并行协作", exact: true }).click();
  await page.locator(".graph-node-result").first().locator("summary").click();
  const override = page.locator(".graph-node-result").first();
  await expect(override.getByRole("button", { name: "task-1 模型", exact: true })).toBeEnabled();
  await override.getByRole("button", { name: "task-1 思考强度", exact: true }).click();
  await page.getByRole("option", { name: "高", exact: true }).click();
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testExecutionConflict = true; });
  await page.getByRole("button", { name: "task-1 保存执行配置", exact: true }).click();
  await expect(override.getByRole("alert")).toContainText("其他操作");
  await expect(override.getByRole("button", { name: "task-1 思考强度", exact: true })).toContainText("高");
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testExecutionConflict = false; });
  await page.getByRole("button", { name: "task-1 保存执行配置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testExecutionRequest: { config: unknown };
  }).__testExecutionRequest?.config)).toEqual({ model: "gpt-test", effort: "high" });
  await override.scrollIntoViewIfNeeded();
  for (const button of await override.locator(".dropdown-trigger").all()) {
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({ path: testInfo.outputPath("execution-mobile.png") });
});

test("models without variants do not advertise configurable thinking", async ({ page }) => {
  await mockDesktop(page, false);
  await details(page);
  await page.locator("summary").filter({ hasText: /^会话接力$/ }).click();
  await choose(page, "opencode 接力 模型", "opencode/plain-free");
  await expect(page.getByRole("button", { name: "opencode 接力 思考强度", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "opencode 接力 思考强度", exact: true })).toContainText("不可配置");
});

async function startCodex(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "检查响应式页面", exact: true }).click();
  await choose(page, "模型", "gpt-test");
  await choose(page, "思考强度", "低");
  await page.locator(".composer-input").fill("continue safely");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".execution-current")).toContainText("低");
}

test("queued configuration changes dispatch independently of the running snapshot", async ({ page }) => {
  await mockDesktop(page, false);
  await startCodex(page);
  await page.locator(".composer-input").fill("queued review");
  await page.locator(".composer-input").press("Enter");
  await choose(page, "排队 1 思考强度", "高");
  await expect(page.locator(".execution-current")).toContainText("低");
  await page.evaluate(() => (window as unknown as {
    __emit: (event: string, payload: unknown) => void;
  }).__emit("task-exit", { taskId: "new-task", code: 0 }));
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testRequests: Record<string, unknown>[];
  }).__testRequests.at(-1))).toMatchObject({ prompt: "queued review", model: "gpt-test", effort: "high", mode: "write" });
});

test("reconfiguration waits for persistent termination and suppresses automatic queue dispatch", async ({ page }) => {
  await mockDesktop(page, false);
  await startCodex(page);
  await page.locator(".composer-input").fill("queued review");
  await page.locator(".composer-input").press("Enter");
  await choose(page, "思考强度", "高");
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testCancelDeferred = true; });
  await page.getByRole("button", { name: "停止并按新配置继续", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testCalls: string[];
  }).__testCalls.includes("cancel_task"))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
  await page.evaluate(() => (window as unknown as {
    __emit: (event: string, payload: unknown) => void;
  }).__emit("task-exit", { taskId: "new-task", code: 0 }));
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testRequests: Record<string, unknown>[];
  }).__testRequests.at(-1))).toMatchObject({ effort: "high", mode: "write", relay: true });
  await expect(page.getByText("queued review", { exact: true }).last()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(2);
});

test("failed cancellation leaves the existing execution and queue intact", async ({ page }) => {
  await mockDesktop(page, false);
  await startCodex(page);
  await choose(page, "思考强度", "高");
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testCancelError = "cancel rejected"; });
  await page.getByRole("button", { name: "停止并按新配置继续", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("cancel rejected");
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
  await expect(page.locator(".execution-current")).toContainText("低");
});

test("scheduler-owned graph children refuse independent reconfiguration", async ({ page }) => {
  await mockDesktop(page, false);
  await startCodex(page);
  await choose(page, "思考强度", "高");
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__testGraphs = [{
      status: "running", nodes: [{ task_id: "new-task" }],
    }];
  });
  await page.getByRole("button", { name: "停止并按新配置继续", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("并行协作管理");
  expect(await page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls.includes("cancel_task"))).toBe(false);
});

test("reopening a conversation keeps next-turn defaults separate from its execution snapshot", async ({ page }) => {
  await mockDesktop(page, false);
  await startCodex(page);
  await choose(page, "思考强度", "高");
  await page.getByRole("button", { name: "新聊天", exact: true }).first().click();
  await page.getByRole("button", { name: "检查响应式页面", exact: true }).click();
  await expect(page.getByRole("button", { name: "思考强度", exact: true })).toContainText("高");
  await expect(page.locator(".execution-current")).toContainText("低");
});
