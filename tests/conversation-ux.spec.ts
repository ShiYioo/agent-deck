import { expect, test } from "@playwright/test";
import { mockDesktop } from "./helpers";

test("task starters prepare an editable draft without starting a runner", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "解决问题", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(/预期行为/);
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(0);
  await page.getByRole("button", { name: "选择项目", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "选择项目", exact: true })).toBeVisible();
});

test("running state accepts cross-runner followups in order", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("检查布局");
  await input.press("Enter");
  await expect(page.locator(".conversation-status")).toContainText("正在执行");
  await expect(page.locator(".composer-behavior")).toContainText("本轮结束后继续");
  await input.fill("@opencode 检查结果");
  await input.press("Escape");
  await expect(page.getByRole("button", { name: "排队接力", exact: true })).toBeEnabled();
  await input.press("Enter");
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(1);
  await input.fill("完成后补充测试");
  await input.press("Enter");
  await expect(page.locator(".conversation-status")).toContainText("2 条待发送");
  await page.evaluate(() => (window as unknown as { __emit: (event: string, payload: unknown) => void })
    .__emit("task-exit", { taskId: "new-task", code: 0 }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests[1]))
    .toMatchObject({ harness: "opencode", prompt: "检查结果", resumeSessionId: null });
});

for (const hasArtifacts of [false, true]) {
  test(`OpenCode artifact polling stays quiet and preserves results (${hasArtifacts})`, async ({ page }) => {
    await mockDesktop(page, false);
    await page.goto("/");
    await page.evaluate((hasArtifacts) => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
        __artifactPollCount: number;
        __failArtifactPoll: () => void;
      };
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__artifactPollCount = 0;
      w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        if (cmd !== "get_turn_artifacts" || args.taskId !== "new-task") return original(cmd, args);
        const count = ++w.__artifactPollCount;
        if (count === 2) await new Promise<void>((_resolve, reject) => {
          w.__failArtifactPoll = () => reject(new Error("temporary scan failure"));
        });
        return {
          base_dir: "C:\\workspace", files: [],
          artifacts: hasArtifacts || count >= 3
            ? [{ path: `C:\\workspace\\result-${count >= 3 ? 2 : 1}.png`, kind: "image", size: 100 }] : [],
        };
      };
    }, hasArtifacts);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill("@opencode 检查布局");
    await input.press("Enter");
    await expect(page.locator(".timeline-activity")).toContainText("opencode 正在处理任务");
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __artifactPollCount: number }).__artifactPollCount),
    { timeout: 10_000 }).toBe(2);
    await expect(page.getByText("正在收集本轮产出…", { exact: true })).toHaveCount(0);
    await expect(page.locator(".turn-artifacts")).toHaveCount(hasArtifacts ? 1 : 0);
    if (hasArtifacts) await expect(page.locator(".turn-artifacts")).toContainText("result-1.png");
    await page.evaluate(() =>
      (window as unknown as { __failArtifactPoll: () => void }).__failArtifactPoll());
    await expect(page.locator(".turn-artifacts")).toHaveCount(hasArtifacts ? 1 : 0);
    if (hasArtifacts) await expect(page.locator(".turn-artifacts")).toContainText("result-1.png");
    await expect(page.locator(".turn-artifacts")).toContainText("result-2.png", { timeout: 10_000 });
    await expect(page.getByText("正在收集本轮产出…", { exact: true })).toHaveCount(0);
  });
}

test("a pending question gets a direct composer answer instead of a queued message", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("@deck 检查布局");
  await input.press("Enter");
  await page.evaluate(() => {
    (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("pi-event", {
      taskId: "new-task", type: "deck_approval_request", id: "question-ux", tool: "ask_user_question",
      args: { __question: { question: "使用哪个主题？", options: [] } },
    });
  });
  await expect(page.locator(".conversation-status")).toContainText("需要你的回应");
  await input.fill("使用浅色主题");
  await expect(page.getByRole("button", { name: "发送回答", exact: true })).toBeEnabled();
  await input.press("Enter");
  await expect(page.locator(".approval-surface")).toHaveCount(0);
  const invokes = await page.evaluate(() => (window as unknown as {
    __testInvokes: { cmd: string; args: Record<string, unknown> }[];
  }).__testInvokes);
  expect(invokes.find((item) => item.cmd === "task_command" && item.args.id === "question-ux")?.args).toMatchObject({
    cmd: "approve", answer: "使用浅色主题",
  });
});

test("older conversation pages remain reachable and results share the reading surface", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__testTaskEvents = {
      a: Array.from({ length: 620 }, (_, i) => ({ type: "assistant_message", text: `历史记录 ${i}` })),
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByText("历史记录 0", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /查看更早的记录/ }).click();
  await expect(page.getByText("历史记录 0", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /查看更早的记录/ })).toHaveCount(0);
});

test("collaboration keeps its last known state through a temporary sync failure and then recovers", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
      __graphFailNext: boolean; __graphFailed: boolean; __graphDone: boolean;
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd !== "list_graph_runs") return original(cmd, args);
      if (w.__graphFailNext) {
        w.__graphFailNext = false;
        w.__graphFailed = true;
        throw new Error("temporary connection failure");
      }
      const done = w.__graphDone;
      return [{
        id: "sync-graph", source_task_id: "a", conversation_id: "a", cwd: "C:\\workspace",
        status: done ? "done" : "running", integrated: false, max_parallel: 1, timeout_secs: 900,
        nodes: [{
          spec: { id: "inspect", harness: "opencode", prompt: "检查布局", dependencies: [], read_only: true },
          status: done ? "done" : "running", task_id: null, report: null, error: null,
        }],
      }];
    };
  });
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.locator(".conversation-status")).toContainText("协作进行中");
  await page.evaluate(() => { (window as unknown as { __graphFailNext: boolean }).__graphFailNext = true; });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __graphFailed: boolean }).__graphFailed)).toBe(true);
  await expect(page.locator(".graph-run")).toBeVisible();
  await expect(page.locator(".conversation-status")).toContainText("协作进行中");
  await page.evaluate(() => { (window as unknown as { __graphDone: boolean }).__graphDone = true; });
  await expect(page.locator(".graph-run-heading")).toContainText("结论都出来了", { timeout: 8000 });
  await expect(page.locator(".conversation-status")).toContainText("本轮已完成");
});

for (const width of [1280, 390]) {
  test(`conversation workspace stays readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await mockDesktop(page, false);
    await page.goto("/");
    if (width < 500) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
    await expect(page.locator(".assistant-markdown h2")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const timeline = (await page.locator(".conversation-timeline").boundingBox())!;
    const composer = (await page.locator(".composer-card").boundingBox())!;
    expect(timeline.height).toBeGreaterThan(180);
    expect(timeline.y + timeline.height).toBeLessThanOrEqual(composer.y);
    await page.screenshot({ path: `test-results/conversation-ux-${width}.png` });
  });
}
