import { expect, test } from "@playwright/test";
import { mockDesktop } from "./helpers";



test("groups projects once, searches, collapses, and restores drafts", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await expect(page.locator(".project-group")).toHaveCount(2);
  await expect(page.locator(".thread-item")).toHaveCount(3);
  await page.getByRole("button", { name: "搜索聊天", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索聊天" }).fill("补充");
  await expect(page.locator(".thread-item")).toHaveCount(1);
  await page.getByRole("textbox", { name: "搜索聊天" }).press("Escape");
  await page.locator(".project-toggle").first().click();
  await expect(page.locator(".thread-item")).toHaveCount(1);
  await page.locator(".project-toggle").first().click();
  await page.getByRole("textbox", { name: "消息" }).fill("新聊天的草稿");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("textbox", { name: "消息" }).fill("会话草稿");
  await page.getByRole("button", { name: "新聊天", exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("新聊天的草稿");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("会话草稿");
  await expect(page.locator(".assistant-markdown h2")).toHaveText("已完成");
  await expect(page.locator(".assistant-markdown table")).toBeVisible();
  await expect(page.locator(".activity-event").filter({ hasText: "read · 已完成" })).not.toHaveAttribute("open", "");
  await page.screenshot({ path: "test-results/conversation-desktop.png" });
});

test("IPC bursts preserve order and only mount the last 500 events", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("textbox", { name: "消息" }).fill("开始流式任务");
  await page.getByRole("textbox", { name: "消息" }).press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (event: string, payload: unknown) => void; __renderBatches: number; __scrollWrites: number };
    w.__renderBatches = 0;
    w.__scrollWrites = 0;
    new MutationObserver(() => w.__renderBatches++).observe(document.querySelector(".log-content")!, { childList: true });
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...descriptor,
      set(value: number) {
        if ((this as Element).classList.contains("log-scroll")) w.__scrollWrites++;
        descriptor.set!.call(this, value);
      },
    });
    for (let i = 0; i < 600; i++) w.__emit("task-event", {
      taskId: "new-task", event: { type: "assistant_message", text: `stream-${i}` },
    });
  });
  await expect(page.locator(".message-assistant")).toHaveCount(500);
  await expect(page.locator(".message-assistant").first()).toHaveText("stream-100");
  await expect(page.locator(".message-assistant").last()).toHaveText("stream-599");
  const metrics = await page.evaluate(() => {
    const w = window as unknown as { __renderBatches: number; __scrollWrites: number };
    return { batches: w.__renderBatches, writes: w.__scrollWrites };
  });
  expect(metrics.batches).toBeLessThanOrEqual(3);
  expect(metrics.writes).toBeLessThanOrEqual(4);
  await test.info().attach("stream-burst-metrics", { body: JSON.stringify({ events: 600, mounted: 500, ...metrics }), contentType: "application/json" });
});

test("new events do not pull the reader down and expanding tools follows at the bottom", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("textbox", { name: "消息" }).fill("滚动测试");
  await page.getByRole("textbox", { name: "消息" }).press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (event: string, payload: unknown) => void };
    for (let i = 0; i < 70; i++) w.__emit("task-event", { taskId: "new-task", event: { type: "assistant_message", text: `message-${i}` } });
  });
  await expect(page.locator(".message-assistant")).toHaveCount(70);
  await expect.poll(() => page.locator(".log-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  await page.locator(".log-scroll").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("task-event", {
    taskId: "new-task", event: { type: "assistant_message", text: "latest-message" },
  }));
  await expect(page.getByText("latest-message", { exact: true })).toHaveCount(1);
  expect(await page.locator(".log-scroll").evaluate((el) => el.scrollTop)).toBeLessThan(3);
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await expect.poll(() => page.locator(".log-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("task-event", {
    taskId: "new-task", event: { type: "tool_result", tool: "read", ok: true, detail: "tool-output\n".repeat(100) },
  }));
  await page.locator(".activity-event summary").click();
  await expect.poll(() => page.locator(".log-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(3);
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toHaveCount(0);
});

test("background windows pause activity while the event queue continues to drain", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("textbox", { name: "消息" }).fill("后台测试");
  await page.getByRole("textbox", { name: "消息" }).press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
  await expect(page.locator(".typing-dots span").first()).toHaveCSS("animation-play-state", "paused");
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("task-event", {
    taskId: "new-task", event: { type: "assistant_message", text: "background-message" },
  }));
  await expect(page.getByText("background-message", { exact: true })).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
});

test("reduced motion disables movement and responds to preference changes", async ({ page }) => {
  await mockDesktop(page, false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await page.getByRole("button", { name: "选择 harness", exact: true }).click();
  await expect(page.locator(".dropdown-menu")).toHaveCSS("opacity", "1");
  await expect(page.locator(".dropdown-menu")).toHaveCSS("transform", "none");
  await page.keyboard.press("Escape");
  await expect(page.locator(".dropdown-menu")).toHaveCount(0);
  await page.getByRole("textbox", { name: "消息" }).fill("运行状态");
  await page.getByRole("textbox", { name: "消息" }).press("Enter");
  await expect(page.locator(".typing-dots span").first()).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  await expect(page.locator(".typing-dots span").first()).toHaveCSS("animation-name", "typing-dot");
});

test("rapid menu and sidebar changes leave no stale overlays or active animations", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "选择 harness", exact: true });
  for (let i = 0; i < 8; i++) {
    await trigger.click();
    await page.keyboard.press("Escape");
  }
  await expect(page.locator(".dropdown-menu")).toHaveCount(0);
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await expect(page.locator(".app-sidebar")).toHaveCount(1);
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  await expect(page.locator('[data-motion-state="exiting"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  await page.screenshot({ path: "test-results/motion-settled-desktop.png" });
});

test("terminal events flush pending session IDs before starting queued continuations", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("原始任务");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await input.fill("排队的续接任务");
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (event: string, payload: unknown) => void };
    w.__emit("task-event", { taskId: "new-task", event: { type: "session_id", id: "session-burst" } });
    w.__emit("task-event", { taskId: "new-task", event: { type: "assistant_message", text: "终止前的最后一条消息" } });
    w.__emit("task-exit", { taskId: "new-task", code: 0 });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __testRequests: Record<string, unknown>[] }).__testRequests.length)).toBe(2);
  const request = await page.evaluate(() => (window as unknown as { __testRequests: Record<string, unknown>[] }).__testRequests[1]);
  expect(request.resumeSessionId).toBe("session-burst");
  await page.getByRole("button", { name: "原始任务", exact: true }).click();
  await expect(page.getByText("终止前的最后一条消息", { exact: true })).toBeVisible();
});

test("textarea height adapts to window width without losing the draft", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息" });
  const text = "界面输入测试".repeat(40);
  await input.fill(text);
  const initial = await input.evaluate((el) => el.clientHeight);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect.poll(() => input.evaluate((el) => el.clientHeight)).toBeGreaterThan(initial);
  await expect(input).toHaveValue(text);
  expect(await input.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(220);
  await page.screenshot({ path: "test-results/motion-textarea-mobile.png" });
});

test("failed sends preserve text and composition never submits", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("中文输入");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(input).toHaveValue("中文输入");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("模拟启动失败");
  await expect(input).toHaveValue("中文输入");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("中文输入\n");
});

test("mentions and keyboard menus keep the selected agent and model", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("@codex");
  await input.press("Enter");
  await expect(input).toHaveValue("@codex:");
  await input.press("Enter");
  await expect(input).toHaveValue("@codex:gpt-test ");
  await page.getByRole("button", { name: "选择 harness", exact: true }).press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "选择 harness", exact: true })).toContainText("Codex");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "模型", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("desktop new chat and mobile workspace stay inside the viewport", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await expect(page.locator(".new-chat-heading")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/new-chat-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "检查响应式页面", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const bounds = await page.locator(".dropdown-menu").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(page.locator(".dropdown-menu")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/conversation-mobile.png" });
  await page.getByRole("button", { name: "新聊天", exact: true }).click();
  await expect(page.locator(".new-chat-heading")).toHaveCSS("opacity", "1");
  await expect(page.locator(".composer-dock")).toHaveCSS("transform", "none");
  await page.screenshot({ path: "test-results/new-chat-mobile.png" });
});

test("project menu and settings close with Escape", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator(".composer-project-button").click();
  await expect(page.getByRole("dialog", { name: "选择项目" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "选择项目" })).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
});

test("successful send clears only its draft, running messages queue, and stop remains available", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill("执行任务");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await input.fill("补充消息");
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("补充消息", { exact: true })).toBeVisible();
  const starts = await page.evaluate(() => ((window as unknown as { __testCalls: string[] }).__testCalls).filter((c) => c === "start_task").length);
  expect(starts).toBe(1);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls.includes("cancel_task"))).toBe(true);
  await page.getByRole("button", { name: "新聊天", exact: true }).first().click();
  await expect(input).toHaveValue("");
});

test("settings and long model names fit narrow windows", async ({ page }) => {
  await mockDesktop(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Worktree 隔离" })).toBeVisible();
  await page.screenshot({ path: "test-results/settings-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "检查响应式页面", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: "provider/a-very-long-model-name-for-layout-checks", exact: true }).click();
  const sendBounds = await page.getByRole("button", { name: "发送", exact: true }).boundingBox();
  expect(sendBounds!.x + sendBounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/long-model-mobile.png" });
});

test("model profile add/edit flow sends camelCase keys and persists in the mock", async ({ page }) => {
  await mockDesktop(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型池" }).click();

  // 新增：API Key/Base URL/模型 ID → 保存 → 列表出现该档案
  await page.getByRole("button", { name: "添加模型配置" }).click();
  await page.getByPlaceholder(/Base URL/).fill("https://api.test/v1");
  await page.getByPlaceholder("API Key").fill("sk-test-1234");
  await page.getByPlaceholder(/模型 ID/).fill("deepseek-chat");
  await page.getByRole("button", { name: "添加并启用" }).click();
  await expect(page.getByText("已添加并启用")).toBeVisible();
  await expect(page.getByText("自定义", { exact: true })).toBeVisible();
  await expect(page.getByText(/sk-t…1234/)).toBeVisible();

  // 编辑：改备注名 → 保存 → 行标题更新
  await page.getByRole("button", { name: "编辑 custom" }).click();
  await page.getByRole("textbox", { name: "供应商名称" }).fill("中转 · 测试");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(page.getByText("自定义 · 中转 · 测试")).toBeVisible();

  // 模型目录：重新进入编辑表单，内嵌面板中添加模型
  await page.getByRole("button", { name: "编辑 中转 · 测试" }).click();
  await page.getByRole("textbox", { name: "新模型名称" }).fill("deepseek-v4-pro");
  await page.getByRole("textbox", { name: "新上下文窗口" }).fill("1M");
  await page.getByRole("textbox", { name: "新最大输出" }).fill("8K");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "模型名称", exact: true }).last(),
  ).toHaveValue("deepseek-v4-pro");
  await expect(
    page.getByRole("textbox", { name: "上下文窗口", exact: true }).last(),
  ).toHaveValue("1M");
  await expect(
    page.getByRole("textbox", { name: "最大输出 token", exact: true }).last(),
  ).toHaveValue("8K");

  // 内联编辑：改名 → 回车保存 → 值保持
  const nameBox = page.getByRole("textbox", { name: "模型名称", exact: true }).last();
  await nameBox.fill("deepseek-v4-flash");
  await nameBox.press("Enter");
  await expect(page.getByRole("textbox", { name: "模型名称", exact: true }).last()).toHaveValue(
    "deepseek-v4-flash",
  );
  await expect(page.getByText("模型列表（1）")).toBeVisible();
  await expect(page.getByText("1 个模型")).toBeVisible();
});
