import { expect, test, type Page } from "@playwright/test";
import { mockDesktop, openSection } from "./helpers";

test.setTimeout(60_000);

async function openConversation(page: Page) {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".assistant-markdown h2")).toHaveText("已完成");
}

async function send(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill(text);
  await input.press("Enter");
}

async function finish(page: Page, taskId: string, reply: string) {
  await page.evaluate(({ taskId, reply }) => {
    const w = window as unknown as { __emit: (event: string, payload: unknown) => void };
    w.__emit("task-event", { taskId, event: { type: "assistant_message", text: reply } });
    w.__emit("task-event", { taskId, event: { type: "complete", ok: true } });
    w.__emit("task-exit", { taskId, code: 0, status: "done" });
  }, { taskId, reply });
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
}

async function requests(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __testRequests: Record<string, unknown>[];
  }).__testRequests);
}

test("mentions hand off in the same conversation without hiding the latest request or calling a summary model", async ({ page }) => {
  await openConversation(page);
  await send(page, "@codex 只检查输入框，不修改文件");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  const [request] = await requests(page);
  expect(request).toMatchObject({
    harness: "codex", prompt: "只检查输入框，不修改文件",
    conversationId: "a", resumeSessionId: null, cwd: "C:\\workspace\\agent-deck",
  });
  expect(request.relay).not.toBe(true);
  await expect(page.locator(".session-item")).toHaveCount(3);
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
  await expect(page.locator(".message-user").last()).toHaveText("只检查输入框，不修改文件");
  expect(await page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls))
    .not.toContain("build_smart_handoff_prompt");
});

test("A to B to A resumes separate native handles while retaining one timeline and draft", async ({ page }) => {
  await openConversation(page);
  await send(page, "@codex 检查现有修改");
  await finish(page, "new-task", "Codex 发现需要修正按钮间距。");
  await expect(page.locator(".message-source")).toContainText(["codex"]);
  await send(page, "@zcode 根据检查修正间距");
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  const [first, second] = await requests(page);
  expect(first.resumeSessionId).toBeNull();
  expect(second.resumeSessionId).toBe("a");
  expect(second.conversationId).toBe("a");
  expect(second.prompt).toBe("根据检查修正间距");
  await expect(page.locator(".session-item")).toHaveCount(3);
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
  await expect(page.getByText("Codex 发现需要修正按钮间距。", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("共享会话中的草稿");
  await page.getByRole("button", { name: "新聊天", exact: true }).first().click();
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(input).toHaveValue("共享会话中的草稿");
});

test("read-only mode survives both harness selection and mention routing", async ({ page }) => {
  await openConversation(page);
  await page.getByRole("button", { name: "权限模式", exact: true }).click();
  await page.getByRole("option", { name: "只读规划", exact: true }).click();
  await send(page, "@codex 继续只读检查");
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  expect((await requests(page))[0].mode).toBe("readonly");
  await finish(page, "new-task", "只读检查完成。");
  await page.getByRole("button", { name: "选择 harness", exact: true }).click();
  await page.getByRole("option", { name: "ZCode · GLM", exact: true }).click();
  await expect(page.getByRole("button", { name: "权限模式", exact: true })).toContainText("只读规划");
});

test("a running conversation refuses another harness and preserves its unsent request", async ({ page }) => {
  await openConversation(page);
  await send(page, "开始实施");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await send(page, "@codex 接手实施");
  await expect(page.getByRole("alert")).toContainText("当前会话已有执行者");
  expect((await requests(page)).length).toBe(1);
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("@codex 接手实施");
});

test("deleting a shared conversation removes all harness turns but leaves other conversations", async ({ page }) => {
  await openConversation(page);
  await send(page, "@codex 检查");
  await finish(page, "new-task", "检查完成。");
  await page.locator(".session-row").filter({ hasText: "调整工作台布局" }).hover();
  await page.getByRole("button", { name: "删除会话 调整工作台布局", exact: true }).click();
  await expect(page.locator(".session-item")).toHaveCount(2);
  await expect(page.locator(".new-chat-heading")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __testDeleted: string[][] }).__testDeleted))
    .toEqual([["new-task", "a"]]);
});

test("conversations without a native handle can still transfer public context", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const tasks = (window as unknown as { __testTasks: Record<string, unknown>[] }).__testTasks;
    tasks.find((task) => task.id === "a")!.session_id = null;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await send(page, "@codex 根据记录接手");
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  expect((await requests(page))[0].conversationId).toBe("a");
  await expect(page.locator(".session-item")).toHaveCount(3);
});

test("handoff button preserves the current restriction and keeps internal instructions out of user messages", async ({ page }) => {
  await openConversation(page);
  await page.getByRole("button", { name: "权限模式", exact: true }).click();
  await page.getByRole("option", { name: "只读规划", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await openSection(page, "接力与多模型配合");
  await page.getByRole("button", { name: "用 codex 接力", exact: true }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  expect((await requests(page))[0]).toMatchObject({
    harness: "codex", mode: "readonly", conversationId: "a", relay: true,
  });
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
  await expect(page.locator(".session-item")).toHaveCount(3);
  await expect(page.locator(".message-user")).not.toContainText(["继续当前会话的未完成任务"]);
  expect(await page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls))
    .not.toContain("build_smart_handoff_prompt");
});
