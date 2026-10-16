import { expect, test, type Page } from "@playwright/test";
import { mockDesktop, openSection } from "./helpers";

async function openDetails(page: Page) {
  await page.goto("/");
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await page.getByRole("button", { name: "执行详情", exact: true }).click();
}
test("sharing boundaries and budgets save without replacing original messages", async ({ page }) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "共享范围与额度");
  await page.getByRole("checkbox", { name: "opencode", exact: true }).uncheck();
  await page.getByRole("textbox", { name: "禁止共享词", exact: true }).fill("customer-secret\nprivate-note");
  await page.getByRole("spinbutton", { name: "上下文窗口", exact: true }).fill("65536");
  await page.getByRole("button", { name: "保存共享策略", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testPolicyRequest: { policy: { context_window: number } };
  }).__testPolicyRequest?.policy.context_window)).toBe(65536);
  const request = await page.evaluate(() => (window as unknown as { __testPolicyRequest: {
    policy: { allowed_harnesses: string[]; blocked_terms: string[]; redact_secrets: boolean };
  } }).__testPolicyRequest);
  expect(request.policy.allowed_harnesses).not.toContain("opencode");
  expect(request.policy.blocked_terms).toEqual(["customer-secret", "private-note"]);
  expect(request.policy.redact_secrets).toBe(true);
  await expect(page.locator(".assistant-markdown h2")).toHaveText("已完成");
});
test("policy conflicts retain the unsaved boundary draft", async ({ page }) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "共享范围与额度");
  await page.getByRole("textbox", { name: "禁止共享词", exact: true }).fill("keep-my-draft");
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testPolicyConflict = true; });
  await page.getByRole("button", { name: "保存共享策略", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("共享策略已更新");
  await expect(page.getByRole("textbox", { name: "禁止共享词", exact: true })).toHaveValue("keep-my-draft");
});
test("parallel DAG submits dependencies and cancellation unlocks controls", async ({ page }, testInfo) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "多模型并行");
  await page.getByRole("textbox", { name: "task-1 任务要求", exact: true }).fill("审查权限边界");
  await page.getByRole("textbox", { name: "task-2 任务要求", exact: true }).fill("核对审查结果");
  await page.locator(".graph-node-editor").nth(1).getByRole("checkbox", { name: "task-1", exact: true }).check();
  await page.getByRole("button", { name: "启动并行协作", exact: true }).click();
  const stop = page.getByRole("button", { name: "停止任务图", exact: true });
  await expect(stop).toBeVisible();
  await expect(page.getByRole("button", { name: "添加协作任务", exact: true })).toBeDisabled();
  const request = await page.evaluate(() => (window as unknown as { __testGraphRequest: {
    nodes: { dependencies: string[]; read_only: boolean }[]; maxParallel: number; timeoutSecs: number;
  } }).__testGraphRequest);
  expect(request.nodes[1].dependencies).toEqual(["task-1"]);
  expect(request.nodes.every((n) => n.read_only)).toBe(true);
  expect(request.timeoutSecs).toBe(900);
  await page.screenshot({ path: testInfo.outputPath("graph-desktop.png") });
  await stop.click();
  await page.getByRole("button", { name: "刷新协作成果", exact: true }).click();
  await expect(page.getByRole("button", { name: "添加协作任务", exact: true })).toBeEnabled();
  await expect(page.locator(".graph-run-heading")).toContainText("已停止");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "移除隔离成果", exact: true }).click();
  await expect(page.locator(".graph-run-heading")).toContainText("成果已移除");
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__testDiscardRequest))
    .toEqual({ id: "graph-test", confirmed: true });
});
test("failed graph launch keeps the task requirements", async ({ page }) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "多模型并行");
  await page.getByRole("textbox", { name: "task-1 任务要求", exact: true }).fill("保留任务一");
  await page.getByRole("textbox", { name: "task-2 任务要求", exact: true }).fill("保留任务二");
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__testGraphError = "并行任务需要干净的 Git 基线"; });
  await page.getByRole("button", { name: "启动并行协作", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("干净的 Git 基线");
  await expect(page.getByRole("textbox", { name: "task-1 任务要求", exact: true })).toHaveValue("保留任务一");
});
test("graph controls fit a narrow execution panel", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "多模型并行");
  await page.getByRole("button", { name: "添加协作任务", exact: true }).click();
  const inputs = page.locator(".graph-node-editor textarea");
  await expect(inputs).toHaveCount(3);
  for (const input of await inputs.all()) {
    const box = await input.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.getByRole("button", { name: "启动并行协作", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("graph-mobile.png") });
});

test("collaboration output reads without opening any settings panel", async ({ page }) => {
  await mockDesktop(page, false);
  // 记录随页面加载就存在，模拟「回到一个已经有协作产出的任务」：
  // 不该需要任何额外点击，更不必展开设置面板
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__testGraphs = [{
      id: "graph-read", source_task_id: "a", conversation_id: "a", cwd: "C:\\workspace\\agent-deck",
      base_commit: "0123456789abcdef", status: "done", integrated: false, max_parallel: 2, timeout_secs: 900, error: null,
      nodes: [
        { spec: { id: "task-1", harness: "codex", prompt: "把侧栏改成浮层\n并在 860px 以下转浮层", dependencies: [], read_only: true },
          status: "done", task_id: "child-1", report: "侧栏已在 860px 以下转为浮层。", error: null, patch_path: null, patch_hash: "abcdef1234567890", worktree: null },
        { spec: { id: "task-2", harness: "opencode", prompt: "补断点回归测试", dependencies: [], read_only: false },
          status: "failed", task_id: "child-2", report: null, error: "测试环境不可用", patch_path: null, patch_hash: null, worktree: null },
      ],
    }];
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const run = page.locator(".graph-run");
  await expect(run).toBeVisible();
  // 有节点失败时不能报「都完成了」
  await expect(run.locator(".graph-run-heading")).toContainText("1/2 个模型完成了，1 个没成");
  // 每行先说「被派去做什么」，而不是内部节点编号
  const first = run.locator(".graph-node-result").first();
  await expect(first.locator("summary")).toContainText("把侧栏改成浮层");
  await expect(first.locator("summary")).not.toContainText("task-1");
  await expect(first.locator(".node-source")).toHaveText("codex");
  await expect(first.locator(".node-status")).toHaveText("已完成");
  await expect(run.locator(".graph-node-result").nth(1).locator(".node-status")).toHaveText("失败");
  // 内部标识与整段产出默认不占正文，展开才给
  await expect(page.getByText("改动记录 abcdef123456")).toBeHidden();
  await expect(page.getByText("侧栏已在 860px 以下转为浮层。")).toBeHidden();
  await first.locator("summary").click();
  await expect(page.getByText("侧栏已在 860px 以下转为浮层。")).toBeVisible();
  await expect(page.getByText("改动记录 abcdef123456")).toBeVisible();
});

test("two parallel command chains submit separate supervisors and show live relationships", async ({ page }, testInfo) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "多模型并行");
  await page.getByRole("button", { name: "配置指挥示例", exact: true }).click();
  await page.getByRole("textbox", { name: "opencode-zcode 任务要求", exact: true }).fill("实现登录接口");
  await page.getByRole("textbox", { name: "codex-deck 任务要求", exact: true }).fill("验证客户端交互");
  const preview = page.getByRole("group", { name: "指挥与协作关系图" });
  await expect(preview.locator(".relationship-lane")).toHaveCount(2);
  await expect(preview.locator(".relationship-lane").first()).toContainText("opencode");
  await expect(preview.locator(".relationship-lane").first()).toContainText("zcode");
  await page.getByRole("button", { name: "启动并行协作", exact: true }).click();
  const request = await page.evaluate(() => (window as unknown as {
    __testGraphRequest: { nodes: { harness: string; supervision: { commander: string; max_rounds: number } }[]; maxParallel: number };
  }).__testGraphRequest);
  expect(request.maxParallel).toBe(2);
  expect(request.nodes.map((n) => [n.supervision.commander, n.harness, n.supervision.max_rounds]))
    .toEqual([["opencode", "zcode", 3], ["codex", "deck", 3]]);
  const result = page.locator(".graph-run");
  await result.getByRole("button", { name: "查看关系任务 opencode-zcode", exact: true }).click();
  await expect(result.getByRole("button", { name: "停止任务链 opencode-zcode", exact: true })).toBeVisible();
  await result.getByRole("button", { name: "停止任务链 opencode-zcode", exact: true }).click();
  await expect(result.locator(".relationship-lane").first()).toContainText("已停止");
  await expect(result.locator(".relationship-lane").nth(1)).toContainText("等待");
  await page.screenshot({ path: testInfo.outputPath("parallel-command-desktop.png") });
});

test("relationship graph shows rework and dependencies within a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__testGraphs = [{
      id: "command-graph", source_task_id: "a", conversation_id: "a", cwd: "C:\\workspace\\agent-deck",
      base_commit: "base", status: "running", integrated: false, max_parallel: 2, timeout_secs: 900, error: null,
      nodes: [
        { spec: { id: "api", harness: "zcode", prompt: "实现登录接口", dependencies: [], read_only: false,
            supervision: { commander: "opencode", max_rounds: 3 } },
          status: "running", phase: "executing", round: 2, task_id: "api-rework", report: null, error: null,
          history: [{ phase: "reviewing", round: 1, harness: "opencode", task_id: "api-review",
            report: "补充登录失败用例" }] },
        { spec: { id: "client", harness: "deck", prompt: "验证客户端交互", dependencies: ["api"], read_only: true,
            supervision: { commander: "codex", max_rounds: 2 } },
          status: "pending", phase: "planning", round: 0, task_id: null, report: null, error: null, history: [] },
      ],
    }];
  });
  await page.goto("/");
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  }
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  const graph = page.getByRole("group", { name: "指挥与协作关系图" });
  await expect(graph).toBeVisible();
  await expect(graph).toContainText("实施 · 2/3 轮");
  await expect(graph.getByRole("button", { name: "查看依赖 api", exact: true })).toBeVisible();
  await graph.getByRole("button", { name: "查看依赖 api", exact: true }).click();
  await page.locator(".node-stage-history summary").click();
  await expect(page.getByText("补充登录失败用例", { exact: true })).toBeVisible();
  const bounds = await graph.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await graph.screenshot({ path: testInfo.outputPath("command-mobile.png") });
});

test("externally submitted graphs appear in the open conversation without a reload", async ({ page }) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await expect(page.locator(".graph-run")).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const run = {
      id: "external", source_task_id: "a", conversation_id: "a", cwd: "C:\\workspace\\agent-deck",
      base_commit: "base", status: "running", integrated: false, max_parallel: 1, timeout_secs: 900,
      nodes: [{ spec: { id: "external-api", harness: "zcode", prompt: "外部运行器提交的任务", dependencies: [], read_only: true,
        supervision: { commander: "opencode", max_rounds: 2 } }, status: "pending", phase: "planning" }],
    };
    w.__testGraphs = [run];
    (w.__emit as (event: string, payload: unknown) => void)("orchestration-update", run);
  });
  await expect(page.locator(".graph-run")).toBeVisible();
  await expect(page.locator(".relationship-chain")).toContainText("opencode");
});

test("command chains can outnumber concurrency slots without replacing existing tasks", async ({ page }) => {
  await mockDesktop(page, false);
  await openDetails(page);
  await openSection(page, "上下文与协作设置");
  await openSection(page, "多模型并行");
  await page.getByRole("button", { name: "配置指挥示例", exact: true }).click();
  await page.getByRole("textbox", { name: "opencode-zcode 任务要求", exact: true }).fill("保留已有任务");
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "添加指挥链", exact: true }).click();
  }
  await expect(page.locator(".graph-node-editor")).toHaveCount(5);
  await expect(page.getByRole("textbox", { name: "opencode-zcode 任务要求", exact: true })).toHaveValue("保留已有任务");
  const inputs = page.locator(".graph-node-editor textarea");
  for (let i = 1; i < 5; i++) await inputs.nth(i).fill(`独立任务 ${i}`);
  await page.getByRole("spinbutton", { name: "并行数量", exact: true }).fill("2");
  await page.getByRole("button", { name: "启动并行协作", exact: true }).click();
  const request = await page.evaluate(() => (window as unknown as {
    __testGraphRequest: { nodes: { id: string; supervision: unknown }[]; maxParallel: number };
  }).__testGraphRequest);
  expect(request.nodes).toHaveLength(5);
  expect(new Set(request.nodes.map((node) => node.id)).size).toBe(5);
  expect(request.nodes.every((node) => node.supervision)).toBe(true);
  expect(request.maxParallel).toBe(2);
  await expect(page.locator(".graph-run .relationship-lane")).toHaveCount(5);
});
