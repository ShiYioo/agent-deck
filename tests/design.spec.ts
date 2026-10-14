import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

test.use({ viewport: { width: 1280, height: 816 }, deviceScaleFactor: 1.5 });
// Cold Vite transforms on Windows can consume most of the default navigation budget.
test.setTimeout(60_000);

async function settled(page: Page) {
  await expect(page.locator(".composer-dock")).toHaveCSS("transform", "none");
  await expect(page.locator(".workspace-main")).toBeVisible();
}

test("reference-sized workspace keeps messages and composer on one content column", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".assistant-markdown h2")).toHaveText("已完成");
  await settled(page);
  expect((await page.locator(".navigation-rail").boundingBox())!.width).toBe(52);
  expect((await page.locator(".app-sidebar").boundingBox())!.width).toBe(288);
  const composer = (await page.locator(".composer-card").boundingBox())!;
  const content = (await page.locator(".log-content").boundingBox())!;
  expect(composer.width).toBe(736);
  expect(Math.abs(composer.x - content.x)).toBeLessThan(1);
  await expect(page.locator(".task-controls")).toBeHidden();
  await expect(page.getByRole("button", { name: "执行详情", exact: true })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "复制回复", exact: true }).click();
  await expect(page.getByRole("button", { name: "已复制回复", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("## 已完成");
  await page.screenshot({ path: "test-results/codex-workspace-desktop.png" });
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  await expect(page.locator(".task-controls")).toBeVisible();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
  expect(errors).toEqual([]);
});

test("navigation rail switches real recent chats and focuses search", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await expect(page.locator(".project-group")).toHaveCount(2);
  await page.getByRole("button", { name: "最近聊天", exact: true }).click();
  await expect(page.locator(".project-group")).toHaveCount(0);
  await expect(page.locator(".session-item")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "最近聊天", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "查找聊天", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索聊天", exact: true });
  await expect(search).toBeFocused();
  await search.fill("响应式");
  await expect(page.locator(".session-item")).toHaveCount(1);
  await search.press("Escape");
  await page.getByRole("button", { name: "项目工作台", exact: true }).click();
  await expect(page.locator(".project-group")).toHaveCount(2);
});

test("reference-sized settings keep opaque chrome and searchable functional sections", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(page.getByRole("switch", { name: "Worktree 隔离", exact: true })).toHaveCSS("background-color", "rgb(50, 150, 255)");
  await expect(page.locator(".settings-sidebar")).toHaveCSS("width", "288px");
  await page.locator(".settings-main h1").click();
  await page.screenshot({ path: "test-results/codex-settings-desktop.png" });
  const search = page.getByRole("textbox", { name: "搜索设置", exact: true });
  await search.fill("模型");
  await expect(dialog.locator(".settings-nav-item")).toHaveCount(1);
  await dialog.getByRole("button", { name: "模型池", exact: true }).click();
  await expect(dialog.locator("h1")).toHaveText("模型池");
  await search.fill("不存在的设置");
  await expect(dialog.getByText("无匹配设置", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除设置搜索", exact: true }).click();
  await dialog.getByRole("button", { name: "通知", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "任务完成通知", exact: true })).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Worktree 隔离", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开设置", exact: true })).toBeFocused();
});

test("model editor stays usable on narrow screens without nested panels or clipped fields", async ({ page }) => {
  await mockDesktop(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(page.locator(".sidebar-scrim-holder")).toBeHidden();
  const directoryButton = dialog.getByRole("button", { name: "更改", exact: true });
  await expect(directoryButton).toHaveCSS("white-space", "nowrap");
  expect((await directoryButton.boundingBox())!.height).toBeLessThan(40);
  await page.screenshot({ path: "test-results/codex-settings-mobile.png" });
  await dialog.getByRole("button", { name: "模型池", exact: true }).click();
  await page.getByRole("button", { name: "添加模型配置", exact: true }).click();
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("视觉回归");
  await page.getByPlaceholder(/Base URL/).fill("https://api.test/v1");
  await page.getByPlaceholder("API Key").fill("sk-ui-preview");
  await page.getByRole("button", { name: "添加并启用", exact: true }).click();
  await page.getByRole("button", { name: "编辑 视觉回归", exact: true }).click();
  await page.getByRole("textbox", { name: "新模型名称", exact: true }).fill("provider/model");
  await page.getByRole("textbox", { name: "新上下文窗口", exact: true }).fill("128K");
  await page.getByRole("textbox", { name: "新最大输出", exact: true }).fill("8K");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "模型名称", exact: true })).toHaveValue("provider/model");
  await page.locator(".model-add-fields").scrollIntoViewIfNeeded();
  for (const field of await page.locator(".model-add-fields input, .model-catalog-fields input").all()) {
    const rect = (await field.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(360);
  }
  await page.screenshot({ path: "test-results/codex-model-editor-mobile.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("diff and project dialogs share quiet framing and keyboard focus", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "查看 Diff", exact: true }).click();
  const diff = page.getByRole("dialog", { name: "Git Diff", exact: true });
  await expect(diff).toBeVisible();
  await expect(diff).toHaveCSS("opacity", "1");
  await expect(diff.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await expect(diff).toContainText('const layout = "workspace";');
  await page.screenshot({ path: "test-results/codex-diff-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(diff).toHaveCount(0);
  await page.getByRole("button", { name: "添加项目", exact: true }).click();
  const project = page.getByRole("dialog", { name: "创建项目", exact: true });
  await expect(project).toHaveCSS("opacity", "1");
  await expect(project.getByRole("textbox", { name: "项目名称", exact: true })).toBeFocused();
  await project.getByRole("textbox", { name: "项目名称", exact: true }).fill("新项目");
  await page.screenshot({ path: "test-results/codex-create-project-desktop.png" });
});

/**
 * 侧栏分档回归：常驻侧栏占 292px（导航栏 52 + 侧栏 240），窄于 860px 会把内容列压到
 * 570px 以下、输入区工具栏折行。既有用例只覆盖 1280 与 390/360，验证不到这一段。
 */
test("sidebar becomes an overlay before it pinches the composer toolbar", async ({ page }) => {
  await mockDesktop(page);

  // 860px 以上：侧栏常驻，占据自己的列，不覆盖正文
  await page.setViewportSize({ width: 900, height: 816 });
  await page.goto("/");
  await page.waitForSelector(".composer-dock");
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-open/);
  const sidebar = (await page.locator(".app-sidebar").boundingBox())!;
  const main = (await page.locator(".workspace-main").boundingBox())!;
  expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(main.x + 1);

  // 860px 及以下：侧栏抽离文档流，初始收起，内容区拿回被占的宽度
  await page.setViewportSize({ width: 800, height: 816 });
  await page.goto("/");
  await page.waitForSelector(".composer-dock");
  await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-open/);
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  const wideMain = (await page.locator(".workspace-main").boundingBox())!;
  expect(wideMain.width).toBeGreaterThan(700);

  // 最紧的一档（761px，桌面版式的最窄处）：工具栏必须仍是单行
  await page.setViewportSize({ width: 761, height: 816 });
  await page.goto("/");
  await page.waitForSelector(".composer-dock");
  const toolbar = (await page.locator(".composer-toolbar").boundingBox())!;
  expect(toolbar.height).toBeLessThan(60);
  const composer = (await page.locator(".composer-card").boundingBox())!;
  expect(composer.width).toBeGreaterThan(600);
});
