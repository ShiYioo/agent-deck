import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

/** 发一条消息，得到一个运行中的任务（mock 的首个任务 id = new-task）。 */
async function runningTask(page: Page) {
  await page.goto("/");
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("改一下源码");
  await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
}

const emit = (page: Page, payload: unknown) =>
  page.evaluate(
    (body) => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("pi-event", body),
    payload,
  );

const emitTool = async (
  page: Page,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) => {
  await emit(page, { taskId: "new-task", type: "tool_execution_start", toolName: tool, args });
  await emit(page, { taskId: "new-task", type: "tool_execution_end", toolName: tool, result });
};

test("deck 的文件工具行点名文件、显示状态词与 +/- 行数", async ({ page }) => {
  await mockDesktop(page, false);
  await runningTask(page);

  // pi 的 edit：入参是 { path, edits[] }；只发 tool_use 时行必须是"执行中"
  await emit(page, {
    taskId: "new-task",
    type: "tool_execution_start",
    toolName: "edit",
    args: { path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] },
  });

  const running = page.locator(".activity-event").filter({ hasText: "edit · 执行中" });
  await expect(running).toHaveCount(1);
  await expect(running).toContainText("src/foo.ts");
  // 运行中的行要有扫光进度条（不靠颜色也要能读出"在跑"）
  await expect(page.locator(".tool-sweep")).toHaveCount(1);

  await emit(page, {
    taskId: "new-task",
    type: "tool_execution_end",
    toolName: "edit",
    result: {
      content: [{ text: "已修改" }],
      details: { diff: "@@ -1 +1 @@\n-a\n+b\n", patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n-a\n+b\n" },
    },
  });

  const row = page.locator(".activity-event").filter({ hasText: "edit · 已执行" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("src/foo.ts");
  await expect(row).toContainText("+1");
  await expect(row).toContainText("−1");
  await expect(page.locator(".tool-sweep")).toHaveCount(0);
});

test("折叠后的工具摘要也点名文件、并标出删除", async ({ page }) => {
  await mockDesktop(page, false);
  await runningTask(page);

  await emitTool(
    page,
    "edit",
    { path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] },
    { content: [{ text: "已修改" }], details: { patch: "--- a\n+++ b\n-a\n+b\n" } },
  );
  await emitTool(page, "delete_file", { path: "src/legacy.ts" }, { content: [{ text: "已删除" }] });

  // 两行以上会折叠成「工具操作 ×N」——摘要必须点名文件，删除必须显式标出
  const segment = page.locator(".activity-event").filter({ hasText: "工具操作 ×2" });
  await expect(segment).toHaveCount(1);
  await expect(segment).toContainText("src/foo.ts");
  await expect(segment).toContainText("src/legacy.ts");
  await expect(segment).toContainText("删除 1");
});
