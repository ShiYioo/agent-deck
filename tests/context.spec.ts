import { expect, test } from "@playwright/test";
import { mockDesktop, openSection } from "./helpers";

test("shared state saves a version and preserves edits after a concurrent update", async ({ page }, testInfo) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await openSection(page, "上下文与协作设置");
  await openSection(page, "共享目标与约束");
  await page.getByRole("textbox", { name: "共享目标", exact: true }).fill("完成输入区优化");
  await page.getByRole("textbox", { name: "共享约束与决策", exact: true }).fill("不改动用户未提交的文件");
  await page.getByRole("button", { name: "保存共享任务", exact: true }).click();
  await expect(page.getByRole("region", { name: "会话上下文" })).toContainText("v1");
  await page.screenshot({ path: testInfo.outputPath("context-desktop.png") });
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testStateConflict = true; });
  await page.getByRole("textbox", { name: "共享目标", exact: true }).fill("新的本地目标");
  await page.getByRole("button", { name: "保存共享任务", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("共享任务状态已更新");
  await expect(page.getByRole("textbox", { name: "共享目标", exact: true })).toHaveValue("新的本地目标");
});

test("verified interrupted recovery clears automatically with details closed", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__testRecoveryTasks = ["a"];
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__testRecoveryConfirmed))
    .toEqual({ taskId: "a", confirmed: true });
});

test("recovery conflicts stay visible without blocking task details", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const state = window as unknown as Record<string, unknown>;
    state.__testRecoveryTasks = ["a"];
    state.__testRecoveryBlocked = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await expect(page.locator(".context-recovery-status")).toContainText("仍有受管执行进程运行");
  await expect(page.getByRole("button", { name: "确认恢复", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testRecoveryBlocked = false; });
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).__testRecoveryConfirmed),
    { timeout: 10_000 }).toEqual({ taskId: "a", confirmed: true });
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
});

test("a damaged native binding can be reset without losing public history", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await openSection(page, "上下文与协作设置");
  await openSection(page, "模型会话记录");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "重建 zcode 上下文", exact: true }).click();
  await expect(page.getByRole("button", { name: "重建 zcode 上下文", exact: true })).toHaveCount(0);
  await expect(page.locator(".assistant-markdown h2")).toHaveText("已完成");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("重新核对原文后继续");
  await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
  await expect.poll(async () => page.evaluate(() => (window as unknown as {
    __testRequests: Record<string, unknown>[];
  }).__testRequests.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as {
    __testRequests: Record<string, unknown>[];
  }).__testRequests[0].resumeSessionId)).toBeNull();
});

test("original history is searchable and paginated without replacing the conversation timeline", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__testContextRows = Array.from({ length: 23 }, (_, index) => ({
      task_id: "a", harness: index % 2 ? "codex" : "zcode", seq: index + 1,
      event: { type: "user_message", text: `早期约束 ${index + 1}：不得修改支付模块` },
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await openSection(page, "上下文与协作设置");
  await openSection(page, "模型会话记录");
  await page.getByRole("textbox", { name: "搜索会话原文", exact: true }).fill("早期约束");
  await page.getByRole("button", { name: "执行原文搜索", exact: true }).click();
  await expect(page.locator(".context-results > details")).toHaveCount(20);
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".context-results > details")).toHaveCount(23);
  await page.locator(".context-results summary").first().click();
  await expect(page.locator(".context-results pre").first()).toContainText("不得修改支付模块");
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
});

test("context state stays usable inside a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await openSection(page, "上下文与协作设置");
  await openSection(page, "共享目标与约束");
  const goal = page.getByRole("textbox", { name: "共享目标", exact: true });
  await goal.fill("完整共享任务目标");
  await goal.scrollIntoViewIfNeeded();
  const box = await goal.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  const save = page.getByRole("button", { name: "保存共享任务", exact: true });
  await save.scrollIntoViewIfNeeded();
  await save.click();
  await expect(page.locator(".context-actions")).toContainText("v1");
  await page.screenshot({ path: testInfo.outputPath("context-mobile.png") });
});

test("guided cooperation carries current restrictions and bounds phase duration", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "权限模式", exact: true }).click();
  await page.getByRole("option", { name: "只读规划", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await openSection(page, "接力与多模型配合");
  await page.getByRole("spinbutton", { name: "阶段时限（分钟）", exact: true }).fill("10");
  await page.getByRole("button", { name: "开始指导协作", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__testCollaborationRequest))
    .toMatchObject({ sourceTaskId: "a", readOnly: true, phaseTimeoutSecs: 600, maxRounds: 2 });
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("阶段之间尝试发送");
  await input.press("Enter");
  await expect(page.locator(".conversation-status")).toContainText("协作进行中");
  await expect(input).toHaveValue("");
  await expect(page.getByText("阶段之间尝试发送", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "停止协作", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止协作", exact: true })).toHaveCount(0);
});
