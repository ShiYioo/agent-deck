import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(({ event, payload }) => {
    (window as unknown as { __emit: (name: string, data: unknown) => void }).__emit(event, payload);
  }, { event, payload });
}

async function send(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "消息" });
  await input.fill(text);
  await input.press("Enter");
}

test("events and exit arriving before start resolves survive, and immediate continuation retains context", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
      __emit: (event: string, payload: unknown) => void;
    };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    let first = true;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      const result = await invoke(cmd, args);
      if (cmd === "start_task" && first) {
        first = false;
        w.__emit("pi-event", { taskId: "new-task", type: "deck_session_file", path: "fixture-session.jsonl" });
        w.__emit("pi-event", {
          taskId: "new-task", type: "message_end",
          message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "早到的回复" }] },
        });
        w.__emit("task-exit", { taskId: "new-task", code: 0 });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return result;
    };
  });
  await page.goto("/");
  await send(page, "@deck 第一轮");
  await expect(page.getByText("早到的回复", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await send(page, "继续追问");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(2);
  const request = await page.evaluate(() =>
    (window as unknown as { __testRequests: Record<string, unknown>[] }).__testRequests[1]);
  expect(request.harness).toBe("deck");
  expect(request.resumeSessionId).toBe("fixture-session.jsonl");
  await expect(page.getByText("早到的回复", { exact: true })).toBeVisible();
  await expect(page.locator(".message-user")).toHaveCount(2);
});

test("streaming snapshots update one message, failed partial replies retain both text and error", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await send(page, "@deck 流式测试");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  for (const text of ["正在", "正在回复"]) {
    await emit(page, "pi-event", { taskId: "new-task", type: "message_update",
      message: { role: "assistant", timestamp: 10, content: [{ type: "text", text }] } });
    await expect(page.locator(".message-assistant")).toHaveText(text);
    await expect(page.locator(".message-assistant")).toHaveCount(1);
  }
  await emit(page, "pi-event", { taskId: "new-task", type: "message_end",
    message: {
      role: "assistant", timestamp: 10, content: [{ type: "text", text: "部分回复" }],
      stopReason: "error", errorMessage: '401: {"error":{"message":"测试令牌已过期"}}',
    } });
  await emit(page, "task-exit", { taskId: "new-task", code: 1 });
  await expect(page.locator(".message-assistant")).toHaveText("部分回复");
  await expect(page.getByRole("alert")).toContainText("测试令牌已过期");
  await expect(page.getByRole("button", { name: "检查模型配置", exact: true })).toBeVisible();
  await expect(page.getByText("运行失败", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/runtime-failure-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/runtime-failure-mobile.png" });
});

test("persisted SDK events replay through the live adapter and coalesce older snapshots", async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => cmd === "get_task_events" ? [
      { type: "user_message", text: "历史问题" },
      ...["历", "历史回复"].map((text) => ({ type: "message_update",
        message: { role: "assistant", timestamp: 99, content: [{ type: "text", text }] } })),
      { type: "message_end", message: {
        role: "assistant", timestamp: 99, content: [{ type: "text", text: "历史回复" }],
      } },
      { type: "deck_error", message: '429: {"error":{"message":"测试余额不足"}}' },
      { type: "deck_run_end", ok: false, status: "failed" },
    ] : invoke(cmd, args);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".message-assistant")).toHaveCount(1);
  await expect(page.locator(".message-assistant")).toHaveText("历史回复");
  await expect(page.getByRole("alert")).toContainText("测试余额不足");
  await expect(page.getByText("任务完成", { exact: true })).toHaveCount(0);
});

test("approvals belong to their task and IPC failures preserve the pending decision", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "pi_command") throw new Error("模拟审批传输失败");
      return invoke(cmd, args);
    };
  });
  await page.goto("/");
  await send(page, "@deck 后台审批任务");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新聊天", exact: true }).first().click();
  await send(page, "@deck 前台任务");
  await emit(page, "pi-event", {
    taskId: "new-task", type: "deck_approval_request", id: "approval-a", tool: "write", args: { path: "a.txt" },
  });
  await expect(page.getByRole("button", { name: "允许", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "后台审批任务", exact: true }).click();
  await expect(page.getByRole("button", { name: "允许", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟审批传输失败");
  await expect(page.getByRole("button", { name: "允许", exact: true })).toBeVisible();
});

test("queued turns keep remaining messages and original model and permission", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await send(page, "@deck:fixture:model 队列起点");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await send(page, "队列一");
  await send(page, "队列二");
  await emit(page, "pi-event", { taskId: "new-task", type: "deck_session_file", path: "queue-session.jsonl" });
  await emit(page, "task-exit", { taskId: "new-task", code: 0 });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(2);
  await expect(page.getByText("队列二", { exact: true })).toBeVisible();
  await emit(page, "task-exit", { taskId: "new-task-2", code: 0 });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(3);
  const requests = await page.evaluate(() =>
    (window as unknown as { __testRequests: Record<string, unknown>[] }).__testRequests);
  expect(requests.map((request) => request.model)).toEqual(["fixture:model", "fixture:model", "fixture:model"]);
  expect(requests.map((request) => request.permission)).toEqual(["auto", "auto", "auto"]);
  expect(requests[2].prompt).toBe("队列二");
});

test("browser mode exposes disconnected runtime and failed sends retain the draft", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("浏览器预览未连接桌面运行器");
  await send(page, "不能悄悄消失的消息");
  await expect(page.getByRole("alert")).toContainText("仅在桌面应用内可用");
  await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("不能悄悄消失的消息");
});

test("changing the harness preserves the conversation without reusing the other agent's handle", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "选择 harness", exact: true }).press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "选择 harness", exact: true })).toContainText("Codex");
  await send(page, "使用选中的新运行器");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
  const request = await page.evaluate(() =>
    (window as unknown as { __testRequests: Record<string, unknown>[] }).__testRequests[0]);
  expect(request.harness).toBe("codex");
  expect(request.resumeSessionId).toBeNull();
  expect(request.conversationId).toBe("a");
  expect(request.prompt).toBe("使用选中的新运行器");
  expect(await page.evaluate(() =>
    (window as unknown as { __testCalls: string[] }).__testCalls)).not.toContain("build_smart_handoff_prompt");
});

const planEvent = (id: string) => ({
  taskId: "new-task", type: "deck_approval_request", id, tool: "propose_collaboration",
  args: { __plan: {
    why: "实现与测试互相独立，可并行后再对比",
    nodes: [
      { id: "impl", harness: "codex", prompt: "把侧栏改成浮层", dependencies: [], read_only: true },
      { id: "tests", harness: "opencode", prompt: "补 860px 断点回归测试", dependencies: ["impl"], read_only: true },
    ],
    parallel: 2, minutes: 15,
  } },
});

test("an agent-proposed collaboration plan starts the shared graph run only after the user confirms", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await send(page, "@deck 把实现和测试分开做");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await emit(page, "pi-event", planEvent("plan-1"));
  // 计划以自然语言呈现，用户只需判断「要不要这么做」，不必自己搭 DAG
  await expect(page.getByText("建议这样拆给多个模型")).toBeVisible();
  await expect(page.getByText("实现与测试互相独立，可并行后再对比")).toBeVisible();
  await expect(page.getByText("把侧栏改成浮层")).toBeVisible();
  await expect(page.getByText("补 860px 断点回归测试")).toBeVisible();
  await expect(page.getByText("等 impl 先完成")).toBeVisible();
  await expect(page.getByText(/最多 2 路并行，总时限 15 分钟，共 2 个节点/)).toBeVisible();
  expect(await page.evaluate(() =>
    (window as unknown as { __testGraphRequest?: unknown }).__testGraphRequest)).toBeUndefined();
  await page.getByRole("button", { name: "确认并启动", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    Boolean((window as unknown as { __testGraphRequest?: unknown }).__testGraphRequest))).toBe(true);
  // 复用既有编排通道（隔离 worktree + DAG），不是给 agent 另开一条执行路径
  const request = await page.evaluate(() =>
    (window as unknown as { __testGraphRequest: Record<string, unknown> }).__testGraphRequest);
  expect(request.sourceTaskId).toBe("new-task");
  expect(request.nodes).toEqual([
    { id: "impl", harness: "codex", prompt: "把侧栏改成浮层", dependencies: [], read_only: true },
    { id: "tests", harness: "opencode", prompt: "补 860px 断点回归测试", dependencies: ["impl"], read_only: true },
  ]);
  expect(request.maxParallel).toBe(2);
  expect(request.timeoutSecs).toBe(900);
  // agent 阻塞在审批通道上，必须收到回执才会继续
  expect(await page.evaluate(() =>
    (window as unknown as { __testCalls: string[] }).__testCalls)).toContain("pi_command");
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toHaveCount(0);
});

test("cancelling an agent-proposed plan releases the agent without starting a run", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await send(page, "@deck 把实现和测试分开做");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await emit(page, "pi-event", planEvent("plan-2"));
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() =>
    (window as unknown as { __testGraphRequest?: unknown }).__testGraphRequest)).toBeUndefined();
  expect(await page.evaluate(() =>
    (window as unknown as { __testCalls: string[] }).__testCalls)).toContain("pi_command");
});
