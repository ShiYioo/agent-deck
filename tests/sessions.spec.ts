import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

async function sessionFixture(page: Page) {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __testTasks: Record<string, unknown>[];
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const base = w.__testTasks[0];
    w.__testTasks.splice(0, w.__testTasks.length,
      { ...base, id: "second", prompt: "补充回归测试", created_at: 20, session_id: "shared.jsonl" },
      { ...base, id: "first", prompt: "调整工作台布局", created_at: 10, session_id: "shared.jsonl" },
      { ...base, id: "other-agent", prompt: "另一个智能体", harness: "codex", created_at: 30, session_id: "shared.jsonl" },
      { ...base, id: "no-session-1", prompt: "无会话任务一", created_at: 40, session_id: null },
      { ...base, id: "no-session-2", prompt: "无会话任务二", created_at: 50, session_id: null },
    );
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "get_task_events" && args.taskId === "second") return [
        { type: "user_message", text: "调整工作台布局" },
        { type: "assistant_message", text: "布局已调整。" },
        { type: "complete", ok: true },
        { type: "user_message", text: "补充回归测试" },
        { type: "assistant_message", text: "回归测试已补充。" },
        { type: "complete", ok: true },
      ];
      return original(cmd, args);
    };
  });
  await page.goto("/");
}

test("sidebar lists sessions without turn dropdowns and opens the full conversation", async ({ page }) => {
  await sessionFixture(page);
  await expect(page.locator(".session-item")).toHaveCount(4);
  await expect(page.locator(".turn-item")).toHaveCount(0);
  const session = page.locator(".session-group").filter({ has: page.getByRole("button", { name: "调整工作台布局", exact: true }) });
  await expect(session.locator("[aria-expanded]")).toHaveCount(0);
  await expect(session.locator(".session-count")).toHaveCount(0);
  await expect(page.locator(".task-view")).toHaveCount(0);
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".message-user")).toHaveText(["调整工作台布局", "补充回归测试"]);
  await expect(page.locator(".message-assistant")).toHaveText(["布局已调整。", "回归测试已补充。"]);
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
  await expect(page.getByRole("button", { name: "调整工作台布局", exact: true })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: "test-results/session-list-desktop.png" });
  await expect(session.locator(".session-item")).toHaveClass(/is-active/);
});

test("searching a later turn preserves the first-prompt title and the full deletion group", async ({ page }) => {
  await sessionFixture(page);
  await page.getByRole("button", { name: "搜索聊天", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索聊天" }).fill("回归");
  await expect(page.locator(".session-item")).toHaveCount(1);
  await expect(page.locator(".session-item")).toHaveText("调整工作台布局");
  await page.locator(".session-row").hover();
  await page.getByRole("button", { name: "删除会话 调整工作台布局", exact: true }).click();
  await expect(page.locator(".session-item")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __testDeleted: string[][] }).__testDeleted))
    .toEqual([["second", "first"]]);
  await page.getByRole("textbox", { name: "搜索聊天" }).press("Escape");
  await expect(page.locator(".session-item")).toHaveCount(3);
});

test("deleting a selected session clears all turns and stale runtime events cannot restore it", async ({ page }) => {
  await sessionFixture(page);
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.locator(".session-row").filter({ hasText: "调整工作台布局" }).hover();
  await page.getByRole("button", { name: "删除会话 调整工作台布局", exact: true }).click();
  await expect(page.locator(".new-chat-heading")).toBeVisible();
  await expect(page.locator(".session-item")).toHaveCount(3);
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (event: string, payload: unknown) => void };
    w.__emit("task-event", { taskId: "second", event: { type: "assistant_message", text: "stale" } });
    w.__emit("task-exit", { taskId: "second", code: 0 });
  });
  await expect(page.locator(".session-item")).toHaveCount(3);
  await expect(page.getByText("stale", { exact: true })).toHaveCount(0);
});

test("failed deletion preserves the selected conversation", async ({ page }) => {
  await sessionFixture(page);
  await page.evaluate(() => { (window as unknown as { __testDeleteError: string }).__testDeleteError = "模拟删除失败"; });
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.locator(".session-row").filter({ hasText: "调整工作台布局" }).hover();
  await page.getByRole("button", { name: "删除会话 调整工作台布局", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟删除失败");
  await expect(page.locator(".session-item")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "调整工作台布局", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".message-user")).toHaveCount(2);
});

test("mobile opens a conversation directly with no nested turn list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await sessionFixture(page);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toBeVisible();
  await expect(page.locator(".turn-item")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  await expect(page.locator(".message-user")).toHaveCount(2);
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
  await page.screenshot({ path: "test-results/session-conversation-mobile.png" });
});

test("continuations stay in one sidebar row and retain the conversation title", async ({ page }) => {
  await sessionFixture(page);
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("继续完善");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await expect(page.locator(".session-item")).toHaveCount(4);
  await expect(page.locator(".workspace-title")).toHaveText("调整工作台布局");
  await expect(page.locator(".message-user")).toHaveText(["调整工作台布局", "补充回归测试", "继续完善"]);
  await expect(page.locator(".session-row [aria-expanded]")).toHaveCount(0);
  const request = await page.evaluate(() => (window as unknown as { __testRequests: Record<string, unknown>[] }).__testRequests[0]);
  expect(request.resumeSessionId).toBe("shared.jsonl");
  await input.fill("保留的会话草稿");
  await page.getByRole("button", { name: "新聊天", exact: true }).first().click();
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(input).toHaveValue("保留的会话草稿");
});

test("deleting a running conversation does not dispatch queued turns from its exit event", async ({ page }) => {
  await sessionFixture(page);
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("运行中的续接");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await input.fill("待发送消息");
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await page.evaluate(() => {
    const w = window as unknown as {
      __emit: (event: string, payload: unknown) => void;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "delete_session") w.__emit("task-exit", { taskId: args.taskId, code: 0 });
      return original(cmd, args);
    };
  });
  await page.locator(".session-row").filter({ hasText: "调整工作台布局" }).hover();
  await page.getByRole("button", { name: "删除会话 调整工作台布局", exact: true }).click();
  await expect(page.locator(".new-chat-heading")).toBeVisible();
  await expect(page.locator(".session-item")).toHaveCount(3);
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
});

test("receiving a session handle does not reset an unsent conversation draft", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("开始会话");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await input.fill("尚未发送的补充");
  await page.evaluate(() => (window as unknown as {
    __emit: (event: string, payload: unknown) => void;
  }).__emit("task-event", {
    taskId: "new-task", event: { type: "session_id", id: "real-session.jsonl" },
  }));
  await expect(input).toHaveValue("尚未发送的补充");
  await expect(page.locator(".workspace-title")).toHaveText("开始会话");
});
