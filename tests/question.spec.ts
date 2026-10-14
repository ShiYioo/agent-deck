import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

/** 发一条消息，得到一个运行中的任务（mock 的首个任务 id = new-task）。 */
async function startRunningTask(page: Page) {
  await page.goto("/");
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("帮我确认一下命名");
  await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
}

function emitForm(page: Page) {
  return page.evaluate(() => {
    (window as unknown as Record<string, unknown> & { __emit: (event: string, payload: unknown) => void }).__emit("task-form", {
      taskId: "new-task",
      id: "frm_1",
      title: "选择文件名",
      fields: [
        { key: "name", type: "string", title: "文件名", required: true, options: [
          { value: "a.txt", label: "a.txt" },
          { value: "b.txt", label: "b.txt" },
        ] },
      ],
    });
  });
}

test("opencode 提问渲染为可作答卡片并把答案经 task_command 回传", async ({ page }) => {
  await mockDesktop(page, false);
  await startRunningTask(page);
  await emitForm(page);

  // 卡片出现：选项按钮可点，必填未填时「提交」禁用
  await page.getByRole("button", { name: "a.txt", exact: true }).click();
  await expect(page.getByRole("button", { name: "提交", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "提交", exact: true }).click();

  // 答案经 task_command 下发（非 deck- 任务路由到原生适配器通道），卡片随即消失
  await expect.poll(() => page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls.includes("task_command"))).toBe(true);
  await expect(page.getByRole("button", { name: "a.txt", exact: true })).toHaveCount(0);
});

test("必填未填时不可提交，跳过经 task_command 回传并收起卡片", async ({ page }) => {
  await mockDesktop(page, false);
  await startRunningTask(page);
  await emitForm(page);

  await expect(page.getByRole("button", { name: "提交", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "跳过", exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls.includes("task_command"))).toBe(true);
  await expect(page.getByRole("button", { name: "a.txt", exact: true })).toHaveCount(0);
});
