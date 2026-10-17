import { expect, test } from "@playwright/test";
import { mockDesktop } from "./helpers";

test("a draft survives reload and details can close without losing edits", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("保留这个尚未发送的检查要求");
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "任务详情" })).toBeHidden();
  await expect(input).toHaveValue("保留这个尚未发送的检查要求");
  await page.reload();
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(input).toHaveValue("保留这个尚未发送的检查要求");
});

test("restored queue preserves routing and attachments and requires explicit continuation", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    if (localStorage.getItem("continuity-seeded")) return;
    localStorage.setItem("continuity-seeded", "true");
    localStorage.setItem("agentdeck:session:v1:queue:a", JSON.stringify({
      queued: ["核对图片成果"],
      queuedConfigs: [{ harness: "opencode", model: "", effort: "", mode: "plan",
        permission: "plan", attachments: ["C:\\workspace\\reference.png"] }],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByText("核对图片成果", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(0);
  await page.getByRole("button", { name: "继续队列", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __testRequests: unknown[] }).__testRequests[0])).toMatchObject({
    harness: "opencode", prompt: "核对图片成果", mode: "plan", permission: "plan",
    attachments: ["C:\\workspace\\reference.png"], resumeSessionId: null,
  });
});

test("stopping with a nonempty draft pauses the queue instead of launching another task", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("开始实施");
  await input.press("Enter");
  await input.fill("@codex 验收成果");
  await input.press("Escape");
  await input.press("Enter");
  await expect(page.getByText("验收成果", { exact: true })).toBeVisible();
  await input.fill("暂不发送的草稿");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续队列", exact: true })).toBeVisible();
  await expect(input).toHaveValue("暂不发送的草稿");
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
});

test("overlapping same-name tools retain their identity when results arrive out of order", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("并行读取文件");
  await input.press("Enter");
  await page.evaluate(() => {
    const emit = (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit;
    for (const [callId, path] of [["first", "first.ts"], ["second", "second.ts"]]) {
      emit("task-event", { taskId: "new-task", event: { type: "tool_use", tool: "read", callId, args: { path }, detail: path } });
    }
    emit("task-event", { taskId: "new-task", event: { type: "tool_result", tool: "read", callId: "second", ok: false, detail: "second failed" } });
    emit("task-event", { taskId: "new-task", event: { type: "tool_result", tool: "read", callId: "first", ok: true, detail: "first succeeded" } });
  });
  const first = page.locator(".activity-event").filter({ hasText: "first.ts" });
  const second = page.locator(".activity-event").filter({ hasText: "second.ts" });
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  await first.locator("summary").click();
  await expect(first).toContainText("first succeeded");
  await expect(first).not.toContainText("second failed");
  await expect(second).toContainText("second failed");
});

test("legacy recovery offers confirmation while verified recovery stays automatic", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    Object.assign(window, { __testRecoveryTasks: ["a"], __testRecoveryLegacy: true });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  const confirm = page.getByRole("button", { name: "确认恢复", exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: "已确认旧执行者结束，保留现有改动继续" }).check();
  await confirm.click();
  await expect(confirm).toHaveCount(0);
});

test("a new request preserves a paused queue without silently resuming it", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    localStorage.setItem("agentdeck:session:v1:queue:a", JSON.stringify({
      queued: ["之后再验收"], queuedConfigs: [{ harness: "codex", model: "", effort: "" }],
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("先处理新的要求");
  await input.press("Enter");
  await expect(page.getByText("之后再验收", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void })
    .__emit("task-exit", { taskId: "new-task", code: 0 }));
  await expect(page.getByRole("button", { name: "继续队列", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
});

test("late streaming snapshots cannot replace a finalized reply or create a duplicate", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("@deck 检查流顺序");
  await input.press("Enter");
  await page.evaluate(() => {
    const emit = (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit;
    for (const [type, text] of [
      ["message_update", "尚未完成"], ["message_end", "最终回复"],
      ["message_end", "最终回复"], ["message_update", "迟到的旧快照"],
    ]) emit("pi-event", { taskId: "new-task", type,
      message: { role: "assistant", timestamp: 100, content: [{ type: "text", text }] } });
  });
  await expect(page.locator(".message-assistant")).toHaveCount(1);
  await expect(page.locator(".message-assistant")).toHaveText("最终回复");
});

test("switching chats restores the detached reading position", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    Object.assign(window, { __testTaskEvents: {
      a: Array.from({ length: 80 }, (_, i) => ({ type: "assistant_message", text: `阅读记录 ${i}` })),
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const log = page.locator(".log-scroll");
  await expect(page.locator(".message-assistant")).toHaveCount(80);
  await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  await log.hover();
  await page.mouse.wheel(0, -1500);
  await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(1000);
  const top = await log.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.keyboard.press("Control+n");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".message-assistant")).toHaveCount(80);
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeGreaterThan(top - 3);
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeLessThan(top + 3);
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
});
