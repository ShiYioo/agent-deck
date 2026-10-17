import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

async function setup(page: Page, many = false) {
  await mockDesktop(page, false);
  await page.addInitScript(({ many }) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
      __reviewCalls: { cmd: string; args: Record<string, unknown> }[];
      __conflict: boolean;
      __testTasks: Record<string, unknown>[];
    };
    w.__reviewCalls = [];
    w.__conflict = false;
    const row = w.__testTasks.find((task) => task.id === "a")!;
    row.execution_config = { requested: { model: "requested" }, resolved: { model: "actual-config" }, transport: "cli" };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      w.__reviewCalls.push({ cmd, args });
      if (cmd === "get_turn_artifacts") return {
        base_dir: "C:\\workspace\\agent-deck", artifacts: [],
        files: many ? Array.from({ length: 1200 }, (_, index) => ({
          path: `src/file-${index}.ts`, status: "modified", added: 1, removed: 1, binary: false, diff: "",
        })) : [
          { path: "src/main.ts", status: "modified", added: 18, removed: 7, binary: false, diff: "" },
          { path: "client/dist/index.js", status: "modified", added: 52, removed: 4, binary: false, diff: "" },
          { path: "photo.png", status: "added", added: null, removed: null, binary: true, diff: "" },
        ],
      };
      if (cmd === "get_task_file_patch") return {
        text: `diff --git a/${args.path} b/${args.path}\n--- a/${args.path}\n+++ b/${args.path}\n@@ -38,1 +38,5001 @@\n-old value\n${Array.from({ length: 5001 }, (_, i) => `+new line ${i}`).join("\n")}`,
        truncated: false,
      };
      if (cmd === "undo_task_file") {
        if (w.__conflict) throw new Error("文件在本轮结束后已变化，撤销已阻止；请查看当前差异");
        return "C:\\recovery\\backup";
      }
      return original(cmd, args);
    };
  }, { many });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByRole("region", { name: "本轮变更", exact: true })).toBeVisible();
}

test("summarizes changes, folds generated files and expands a bounded inline diff on demand", async ({ page }) => {
  await setup(page);
  const review = page.getByRole("region", { name: "本轮变更", exact: true });
  await expect(review).toContainText("更改了 3 个文件");
  await expect(review.locator(".artifact-heading")).toContainText("+70");
  await expect(review.locator(".artifact-heading")).toContainText("−11");
  await expect(review).toContainText("1 个文件无可用行数");
  await expect(review.getByRole("button", { name: "审查 client/dist/index.js", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __reviewCalls: { cmd: string }[] })
    .__reviewCalls.filter((call) => call.cmd === "get_task_file_patch").length)).toBe(0);
  await review.getByRole("button", { name: "审查 src/main.ts", exact: true }).click();
  await expect(review.locator(".file-line.removed")).toContainText("old value");
  await expect(review).toContainText("zcode · 配置模型：actual-config");
  await expect(review).not.toContainText("requested");
  await expect(review.locator(".file-lines")).not.toContainText("diff --git");
  expect(await review.locator(".file-line").count()).toBeLessThanOrEqual(100);
  await review.getByLabel("src/main.ts 的改动", { exact: true }).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(review.locator(".file-line").last()).toContainText("new line 5000");
  await review.getByRole("button", { name: "构建与生成文件 · 1", exact: true }).click();
  await expect(review.getByRole("button", { name: "审查 client/dist/index.js", exact: true })).toBeVisible();
  await review.screenshot({ path: "test-results/turn-changes-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await review.locator(".artifact-heading").scrollIntoViewIfNeeded();
  const bounds = await review.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/turn-changes-mobile.png" });
});

test("undo requires confirmation, keeps conflicts inline and exposes a recovery backup after success", async ({ page }) => {
  await setup(page);
  const review = page.getByRole("region", { name: "本轮变更", exact: true });
  await review.getByRole("button", { name: "审查 src/main.ts", exact: true }).click();
  await page.evaluate(() => { (window as unknown as { __conflict: boolean }).__conflict = true; });
  await review.getByRole("button", { name: "撤销", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __reviewCalls: { cmd: string }[] })
    .__reviewCalls.filter((call) => call.cmd === "undo_task_file").length)).toBe(0);
  await review.getByRole("button", { name: "确认撤销此文件", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("撤销已阻止");
  await expect(review.getByRole("button", { name: "查看当前差异", exact: true })).toBeVisible();
  await expect(review).not.toContainText("已撤销，原内容已备份");
  await page.evaluate(() => { (window as unknown as { __conflict: boolean }).__conflict = false; });
  await review.getByRole("button", { name: "撤销", exact: true }).click();
  await review.getByRole("button", { name: "确认撤销此文件", exact: true }).click();
  await expect(review).toContainText("已撤销，原内容已备份");
  await expect(review.getByRole("button", { name: "查看恢复备份", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
});

test("large change lists load incrementally without eagerly reading file patches", async ({ page }) => {
  await setup(page, true);
  const review = page.getByRole("region", { name: "本轮变更", exact: true });
  await expect(review).toContainText("更改了 1200 个文件");
  await expect(review.locator(".turn-change-file")).toHaveCount(60);
  await review.getByRole("button", { name: /再显示 60 个文件/ }).click();
  await expect(review.locator(".turn-change-file")).toHaveCount(120);
  expect(await page.evaluate(() => (window as unknown as { __reviewCalls: { cmd: string }[] })
    .__reviewCalls.filter((call) => call.cmd === "get_task_file_patch").length)).toBe(0);
});
