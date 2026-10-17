import { expect, test } from "@playwright/test";
import { mockDesktop } from "./helpers";
import { applyTaskUpdates } from "../src/taskState";
import type { LiveTask } from "../src/types";

test("planning protocol is hidden only for its own task, preserving worker output", () => {
  const task: LiveTask = { harness: "opencode", cwd: ".", prompt: "write", mode: null,
    events: [], running: true, exitCode: null, workflowPlanning: "planner" };
  const updated = applyTaskUpdates(task, [
    { taskId: "planner", item: { key: 1, event: { type: "assistant_message", text: '{"kind":"workflow"}' } } },
    { taskId: "worker", item: { key: 2, event: { type: "assistant_message", text: "真实执行成果" } } },
    { taskId: "planner", item: { key: 3, event: { type: "assistant_message", text: "请选择模型", workflow_visible: true } } },
  ]);
  expect(updated.events.map(({ event }) => "text" in event ? event.text : "")).toEqual(["真实执行成果", "请选择模型"]);
});

test("natural language preserves the whole intent and enters platform planning", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const text = "现在写小说，Zcode 的 glm5.3flash 先写，然后 Codex 的 6.1sol 扩写，由 OpenCode 核验，最后 Deck 验收";
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testInvokes: { cmd: string; args: Record<string, unknown> }[];
  }).__testInvokes.find((call) => call.cmd === "start_task")?.args)).toMatchObject({
    prompt: text, workflow: true,
  });
  await expect(page.getByRole("checkbox", { name: "自动分工", exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-behavior")).not.toContainText("自动分工");
});

test("old opt-out settings cannot disable planning and planning phases stay out of the transcript", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
      __testTasks: { id: string; execution_config: Record<string, unknown> }[];
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "get_setting" && args.key === "automatic_workflow") return "off";
      const result = await original(cmd, args);
      if (cmd === "start_task") {
        const task = w.__testTasks.find((task) => task.id === "new-task")!;
        task.execution_config = { ...task.execution_config, purpose: "planning" };
      }
      return result;
    };
  });
  await page.goto("/");
  await expect(page.locator(".composer-behavior")).toContainText("由 zcode 接手，按需协作");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("请完成任务");
  await input.press("Enter");
  await expect(page.locator(".timeline-activity")).toHaveText("正在理解任务…");
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (name: string, payload: unknown) => void };
    w.__emit("task-event", { taskId: "new-task", event: { type: "status", text: "内部意图解析", planning: true } });
    w.__emit("task-event", { taskId: "new-task", event: { type: "assistant_message", text: '{"kind":"direct"}' } });
    w.__emit("workflow-update", { taskId: "new-task", status: "launching" });
  });
  await expect(page.locator(".timeline-activity")).toHaveText("正在安排执行…");
  await expect(page.locator(".log-content")).not.toContainText("内部意图解析");
  await expect(page.locator(".log-content")).not.toContainText('{"kind":"direct"}');
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as {
    __testInvokes: { cmd: string; args: Record<string, unknown> }[];
  }).__testInvokes.find((call) => call.cmd === "start_task")?.args)).toMatchObject({ workflow: true });
  await page.evaluate(() => (window as unknown as { __emit: (name: string, payload: unknown) => void })
    .__emit("workflow-update", { taskId: "new-task", status: "awaiting_confirmation" }));
  await expect(page.locator(".timeline-activity")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
});

for (const background of [false, true]) {
  test(`planner handoff preserves queued followups and conversation focus (${background})`, async ({ page }) => {
    await mockDesktop(page, false);
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill("请分配执行");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void })
      .__emit("workflow-update", { taskId: "new-task", status: "planning" }));
    await input.fill("完成后补充测试");
    await input.press("Enter");
    await expect(page.getByText("完成后补充测试", { exact: true })).toBeVisible();
    if (background) {
      await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
      await expect(page.getByText("请调整工作台布局，并验证小屏幕下的表现。", { exact: true })).toBeVisible();
    }
    await page.evaluate(() => {
      const w = window as unknown as {
        __emit: (event: string, payload: unknown) => void;
        __testTasks: Record<string, unknown>[];
        __testTaskEvents: Record<string, unknown[]>;
      };
      const source = w.__testTasks.find((row) => row.id === "new-task")!;
      w.__emit("task-exit", { taskId: "new-task", code: 0 });
      w.__testTasks.unshift({ ...source, id: "actual-worker", harness: "codex", session_id: "real-session",
        status: "running", exit_code: null, created_at: Date.now() + 100 });
      w.__testTaskEvents = { "actual-worker": [{ type: "assistant_message", text: "实际工作者已接手" }] };
      w.__emit("workflow-update", { taskId: "new-task", status: "launched", targetTaskId: "actual-worker" });
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __testInvokes: { cmd: string; args: { taskId?: string } }[];
    }).__testInvokes.some((call) => call.cmd === "get_task_events" && call.args.taskId === "actual-worker"))).toBe(true);
    if (background) {
      await expect(page.getByText("请调整工作台布局，并验证小屏幕下的表现。", { exact: true })).toBeVisible();
      await expect(page.getByText("实际工作者已接手", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText("实际工作者已接手", { exact: true })).toBeVisible();
      await expect(page.getByText("完成后补充测试", { exact: true })).toBeVisible();
    }
    await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void })
      .__emit("task-exit", { taskId: "actual-worker", code: 0 }));
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __testRequests: unknown[];
    }).__testRequests.length)).toBe(2);
    expect(await page.evaluate(() => (window as unknown as {
      __testRequests: Record<string, unknown>[];
    }).__testRequests[1])).toMatchObject({ harness: "zcode", prompt: "完成后补充测试", resumeSessionId: null });
  });
}

test("unresolved model blocks launch until selected and persists as a reviewable plan", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("@opencode 写小说并让 Codex 修改");
  await page.getByRole("textbox", { name: "消息", exact: true }).press("Enter");
  await page.evaluate(() => {
    const w = window as unknown as { __emit: (name: string, data: unknown) => void };
    w.__emit("pi-event", {
      type: "deck_approval_request", taskId: "new-task", id: "semantic-plan", tool: "propose_collaboration",
      args: { __workflow: true, __issues: ["expand · codex：6.1sol 未唯一匹配"], __plan: {
        why: "按用户要求真实交接", parallel: 1, minutes: 15,
        nodes: [{ id: "expand", harness: "codex", prompt: "扩写到1500字", dependencies: [], read_only: false,
          execution: { model: null, effort: null },
          contract: { workspace: "artifacts", model_hint: "6.1sol", outputs: ["novel.md"], acceptance: false } }],
      } },
    });
  });
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toBeDisabled();
  await expect(page.getByText("要求的模型：6.1sol")).toBeVisible();
  await expect(page.getByText("输出：novel.md")).toBeVisible();
  await expect(page.getByText(/成果按文件版本在独立目录交接/)).toBeVisible();
  await page.getByRole("button", { name: "expand 执行 模型", exact: true }).click();
  await page.getByRole("option", { name: "gpt-test", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认并启动", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testCancelledWorkflow?: { approvalId: string };
  }).__testCancelledWorkflow?.approvalId)).toBe("semantic-plan");
});

test("artifact workflow exposes actual executor records and never offers Git integration", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const harnesses = ["zcode", "codex", "opencode", "deck"];
    w.__testGraphs = [{
      id: "novel-workflow", source_task_id: "a", conversation_id: "a", cwd: "C:\\workspace\\agent-deck",
      base_commit: "", status: "running", integrated: false, max_parallel: 3, timeout_secs: 900,
      nodes: harnesses.map((harness, index) => ({
        spec: { id: `stage-${index}`, harness, prompt: ["写初稿", "扩写小说", "独立核验", "最终验收"][index],
          dependencies: index ? [`stage-${index - 1}`] : [], read_only: index > 1,
          execution: { model: `provider/${harness}-model`, effort: null },
          contract: { workspace: "artifacts", outputs: index < 2 ? ["novel.md"] : [], acceptance: index > 1 } },
        status: index < 3 ? "done" : "pending", task_id: index < 3 ? `actual-${harness}` : null,
        report: index < 3 ? `${harness} 已提交` : null,
        patch_hash: index < 3 ? `version-${index}` : null,
        evidence: { execution: { resolved: { model: `provider/${harness}-model` } }, observed_model: null },
      })),
    }];
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".graph-run .relationship-lane")).toHaveCount(4);
  await expect(page.locator(".graph-run-heading")).toContainText("3/4 阶段完成");
  await expect(page.getByRole("button", { name: "采纳改动", exact: true })).toHaveCount(0);
  await page.locator(".graph-node-result").nth(1).locator("summary").first().click();
  await expect(page.getByRole("button", { name: "打开成果 · novel.md", exact: true })).toBeVisible();
  await expect(page.locator(".graph-node-result").nth(1).getByText("运行器报告：未报告实际模型", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看执行记录", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/workflow-artifacts.png", fullPage: true });
});
