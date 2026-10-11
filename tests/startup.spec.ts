import { expect, test } from "@playwright/test";
import { mockDesktop } from "./helpers";

test("first screen skips unused catalogs and repeated agent selection shares discovery", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await expect(page.locator(".session-item")).toHaveCount(3);
  const calls = () => page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls);
  // 默认 harness 是 zcode：首屏发现 zcode 模型目录（有目录的 harness 才发现）
  expect((await calls()).filter((command) => command === "discover_models")).toHaveLength(1);
  expect((await calls()).filter((command) => command === "list_model_profiles")).toHaveLength(0);
  const trigger = page.getByRole("button", { name: "选择 harness", exact: true });
  await trigger.click();
  await page.getByRole("option", { name: "Codex · GPT", exact: true }).click();
  await expect.poll(async () => (await calls()).filter((command) => command === "discover_models").length).toBe(2);
  await trigger.click();
  await page.getByRole("option", { name: "ZCode · GLM", exact: true }).click();
  await trigger.click();
  await page.getByRole("option", { name: "Codex · GPT", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("option", { name: "gpt-test", exact: true })).toBeVisible();
  // 同 harness 的发现结果共享，重复选择不重复请求
  expect((await calls()).filter((command) => command === "discover_models")).toHaveLength(2);
});

test("loading conversations have feedback and repeated clicks do not duplicate requests", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await expect(page.locator(".session-item")).toHaveCount(3);
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
      __resolveEvents: () => void;
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "get_task_events"
      ? new Promise((resolve) => { w.__resolveEvents = () => { void original(cmd, args).then(resolve); }; })
      : original(cmd, args);
  });
  const chat = page.getByRole("button", { name: "调整工作台布局", exact: true });
  await chat.click();
  await expect(page.getByText("正在加载对话…", { exact: true })).toBeVisible();
  await chat.click();
  await page.evaluate(() => (window as unknown as { __resolveEvents: () => void }).__resolveEvents());
  await expect(page.locator(".assistant-markdown h2")).toHaveText("已完成");
  const reads = await page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls.filter((cmd) => cmd === "get_task_events").length);
  expect(reads).toBe(1);
});

test("project menus stay in short viewports and return keyboard focus", async ({ page }) => {
  await mockDesktop(page);
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "选择项目", exact: true });
  await trigger.press("ArrowDown");
  const menu = page.getByRole("dialog", { name: "选择项目", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(menu).toHaveCSS("transform", "none");
  await expect(menu.getByRole("button").first()).toBeFocused();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(52);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(420);
  await page.screenshot({ path: "test-results/project-menu-short-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("project dialog traps focus and returns to its launcher", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  const launcher = page.getByRole("button", { name: "添加项目", exact: true });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "创建项目", exact: true });
  await expect(dialog.getByRole("textbox", { name: "项目名称", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
});
