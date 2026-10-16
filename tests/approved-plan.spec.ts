import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

async function propose(page: Page, multiple = false) {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("@deck 使用 opencode 的免费模型分析沙盒");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.evaluate(({ multiple }) => {
    const nodes = [{
      id: "cleanup", harness: "opencode", prompt: "分析测试沙盒，保留用户笔记",
      dependencies: [] as string[], read_only: true,
    }];
    if (multiple) nodes.push({
      id: "review", harness: "codex", prompt: "审查分析结论", dependencies: ["cleanup"], read_only: true,
    });
    (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("pi-event", {
      taskId: "new-task", type: "deck_approval_request", id: "plan-approval",
      tool: "propose_collaboration", args: { __plan: { why: "按用户要求指定运行器", nodes, parallel: 2, minutes: 15 } },
    });
  }, { multiple });
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toBeVisible();
}

test("a waiting planner hands a single task to the selected free model without a Git task graph", async ({ page }) => {
  await propose(page);
  await expect(page.getByText("在当前工作目录执行。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "cleanup 执行 模型", exact: true }).click();
  await page.getByRole("option", { name: "opencode/test-free 免费", exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__testApprovedPlanEarlyEvent = {
      type: "assistant_message", text: "交接期间已开始检查沙盒",
    };
  });
  await page.getByRole("button", { name: "确认并启动", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testApprovedPlanRequest?: { nodes: { execution?: { model: string } }[] };
  }).__testApprovedPlanRequest?.nodes[0].execution?.model)).toBe("opencode/test-free");
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toHaveCount(0);
  const state = await page.evaluate(() => {
    const w = window as unknown as { __testTasks: { id: string; harness: string; cwd: string; status: string; model: string }[]; __testCalls: string[] };
    return { tasks: w.__testTasks, calls: w.__testCalls };
  });
  expect(state.tasks.find((task) => task.id === "new-task")?.status).toBe("cancelled");
  expect(state.tasks.find((task) => task.id === "planned-worker")).toMatchObject({
    harness: "opencode", model: "opencode/test-free", status: "running", cwd: "C:\\workspace\\agent-deck",
  });
  expect(state.calls).not.toContain("start_graph_run");
  expect(state.calls).not.toContain("pi_command");
  await expect(page.getByText("交接期间已开始检查沙盒", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("task-event", {
      taskId: "planned-worker", event: { type: "assistant_message", text: "接手后的实时进度" },
    });
  });
  await expect(page.getByText("接手后的实时进度", { exact: true })).toBeVisible();
});

test("model validation failure retains the pending plan and running planner", async ({ page }) => {
  await propose(page);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__testApprovedPlanError = "执行模型不可用，请重新选择";
  });
  await page.getByRole("button", { name: "确认并启动", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toBeEnabled();
  await expect(page.getByText("执行模型不可用，请重新选择").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as {
    __testTasks: { id: string; status: string }[];
  }).__testTasks.find((task) => task.id === "new-task")?.status)).toBe("running");
});

test("a confirmed multi-node plan releases its planner and starts the isolated task graph", async ({ page }) => {
  await propose(page, true);
  await page.getByRole("button", { name: "确认并启动", exact: true }).click();
  await expect(page.locator(".graph-run")).toBeVisible();
  await expect(page.locator(".graph-run .relationship-lane")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toHaveCount(0);
});
