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

test("多题表单走向导：逐题作答 → 复核 → 整体提交", async ({ page }) => {
  await mockDesktop(page, false);
  await startRunningTask(page);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown> & { __emit: (event: string, payload: unknown) => void }).__emit("task-form", {
      taskId: "new-task",
      id: "frm_wizard",
      title: "两项确认",
      fields: [
        { key: "lang", type: "string", title: "语言", options: [
          { value: "ts", label: "TypeScript" }, { value: "py", label: "Python" },
        ] },
        { key: "db", type: "string", title: "数据库", options: [
          { value: "pg", label: "PostgreSQL" }, { value: "mysql", label: "MySQL" },
        ] },
      ],
    });
  });

  // 第 1 题 → 下一题
  await expect(page.getByText("1/2")).toBeVisible();
  await page.getByRole("button", { name: "TypeScript", exact: true }).click();
  await page.getByRole("button", { name: "下一题", exact: true }).click();
  // 第 2 题 → 复核
  await expect(page.getByText("2/2")).toBeVisible();
  await page.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await page.getByRole("button", { name: "复核回答", exact: true }).click();
  await expect(page.getByText("提交全部", { exact: true })).toBeVisible();
  await expect(page.getByText("未回答")).toHaveCount(0);
  await page.getByRole("button", { name: "提交全部", exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const invokes = (window as unknown as { __testInvokes: { cmd: string; args: Record<string, unknown> }[] }).__testInvokes ?? [];
    return invokes.some((r) => r.cmd === "task_command" && JSON.stringify(r.args ?? {}).includes("lang"));
  }), { timeout: 10_000 }).toBe(true);
  await expect(page.getByRole("button", { name: "TypeScript", exact: true })).toHaveCount(0);
});

test("审批/提问按 FIFO 排队：第二个请求排队，应答第一个后补位", async ({ page }) => {
  await mockDesktop(page, false);
  await startRunningTask(page);
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { __emit: (event: string, payload: unknown) => void };
    w.__emit("task-form", { taskId: "new-task", id: "frm_a", title: "问题 A",
      fields: [{ key: "a", type: "string", title: "问题 A", options: [{ value: "a1", label: "A1" }] }] });
    w.__emit("task-form", { taskId: "new-task", id: "frm_b", title: "问题 B",
      fields: [{ key: "b", type: "string", title: "问题 B", options: [{ value: "b1", label: "B1" }] }] });
  });
  // 队首是 A，且有排队提示
  await expect(page.getByText("问题 A", { exact: true })).toBeVisible();
  await expect(page.getByText(/还有 1 个待处理请求/)).toBeVisible();
  // 应答 A → B 补位
  await page.getByRole("button", { name: "A1", exact: true }).click();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect(page.getByText("问题 B", { exact: true })).toBeVisible();
  await expect(page.getByText(/还有 .* 个待处理请求/)).toHaveCount(0);
});
