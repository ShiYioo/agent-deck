import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

test.setTimeout(60_000);

async function setup(page: Page, running = false) {
  await mockDesktop(page);
  await page.addInitScript(({ running }) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>; convertFileSrc: (path: string) => string };
      __fileReads: Record<string, unknown>[];
      __testTasks: { status: string; execution_config: unknown }[];
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    if (running) w.__testTasks[0].status = "running";
    w.__testTasks[0].execution_config = {
      requested: { model: "requested-model", effort: null },
      resolved: { model: "resolved-model", effort: null }, transport: "cli",
    };
    w.__fileReads = [];
    w.__TAURI_INTERNALS__.convertFileSrc = (path) => `http://asset.localhost/${encodeURIComponent(path)}`;
    const paths = ["README.md", "large.log", "deleted.ts", "report.docx", "photo.png", "movie.mp4", "report.pdf", "data.bin", "src/app.ts", "ordinary.txt"];
    w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "list_task_directory") {
        const entries = args.path === "src"
          ? [{ name: "app.ts", path: "src/app.ts", directory: false, symlink: false }]
          : [{ name: "src", path: "src", directory: true, symlink: false }, ...paths.filter((p) => !p.includes("/") && p !== "deleted.ts").map((path) => ({ name: path, path, directory: false, symlink: false }))];
        return { entries, next: null };
      }
      if (cmd === "read_task_text_window") {
        w.__fileReads.push({ cmd, ...args });
        const start = Number(args.start);
        return { start, total: 2_000_000, lines: Array.from({ length: Math.min(160, 2_000_000 - start) }, (_, i) => `line ${start + i + 1}`) };
      }
      if (cmd === "get_turn_artifacts") return {
        base_dir: "C:\\workspace\\agent-deck", artifacts: [],
        files: paths.map((path) => ({ path, status: path === "deleted.ts" ? "deleted" : "modified", added: 2, removed: 1, binary: false, diff: "" })),
      };
      if (cmd === "get_task_file_patch") {
        w.__fileReads.push({ cmd, ...args });
        return { text: "diff --git a/deleted.ts b/deleted.ts\n--- a/deleted.ts\n+++ /dev/null\n@@ -38,2 +38,1 @@\n-old value\n+new value\n context", truncated: false };
      }
      if (cmd === "preview_task_file") {
        w.__fileReads.push({ cmd, ...args });
        const path = String(args.path);
        const ext = path.split(".").pop();
        const kind = ({ md: "markdown", docx: "document", png: "image", mp4: "video", pdf: "pdf", bin: "binary" } as Record<string, string>)[ext!] ?? "text";
        return {
          path: `C:\\workspace\\agent-deck\\${path}`, kind, size: path === "large.log" ? 10_000_000 : 100,
          content: path === "large.log"
            ? args.offset ? "last page" : Array.from({ length: 20000 }, (_, i) => `line ${i + 1}`).join("\n")
            : path === "README.md" ? "# Project notes\n\nHello **world**\n\n<script>window.injected=true</script>"
              : path === "ordinary.txt" ? Array.from({ length: 20000 }, (_, i) => `ordinary ${i + 1}`).join("\n")
              : path === "src/app.ts" ? "export const value: number = 42;" : "Office content",
          next_offset: path === "large.log" && !args.offset ? 256000 : null, encoding: "UTF-8", notice: null,
        };
      }
      return original(cmd, args);
    };
  }, { running });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
}

test("reads markdown inside the workspace, switches source and keeps the conversation available", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  const panel = page.getByRole("region", { name: "文件查看与改动审阅" });
  await expect(panel.getByRole("heading", { name: "Project notes" })).toBeVisible();
  await page.screenshot({ path: "test-results/file-reader-desktop.png" });
  await expect(panel.locator("script")).toHaveCount(0);
  await panel.getByRole("button", { name: "查看源码", exact: true }).click();
  await expect(panel.locator(".cm-content")).toContainText("# Project notes");
  await expect(page.locator(".composer-dock")).toBeVisible();
  await page.getByRole("button", { name: "关闭文件预览" }).click();
  await expect(panel).toHaveCount(0);
});

test("two million lines scroll continuously to EOF with bounded DOM and indexed reads", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "large.log", exact: true }).click();
  const panel = page.getByRole("region", { name: "文件查看与改动审阅" });
  await expect(panel.locator(".file-line").first()).toContainText("line 1");
  expect(await panel.locator(".file-line").count()).toBeLessThanOrEqual(160);
  await panel.getByLabel("完整大文件").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(panel.locator('[data-line="2000000"]')).toContainText("line 2000000");
  expect(await panel.locator(".file-line").count()).toBeLessThanOrEqual(160);
  await expect(panel.getByRole("button", { name: "下一段", exact: true })).toHaveCount(0);
  const reads = await page.evaluate(() => (window as unknown as { __fileReads: { cmd: string; start?: number }[] }).__fileReads);
  expect(reads.filter((r) => r.cmd === "preview_task_file")).toHaveLength(1);
  expect(reads.some((r) => r.cmd === "read_task_text_window" && Number(r.start) > 1_999_000)).toBe(true);
});

test("deleted files can be reviewed with old and new line numbers and honest attribution", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "deleted.ts", exact: true }).click();
  const panel = page.getByRole("region", { name: "文件查看与改动审阅" });
  await expect(panel.locator(".file-line.removed")).toContainText("old value");
  await expect(panel.locator(".file-line.removed .file-line-number").first()).toHaveText("38");
  await expect(panel.locator(".file-line.added .file-line-number").nth(1)).toHaveText("38");
  await expect(panel.locator(".file-lines")).not.toContainText("diff --git");
  await expect(panel.locator(".file-lines")).not.toContainText("/dev/null");
  await expect(panel.locator(".file-lines")).not.toContainText("@@");
  await expect(panel.locator(".file-lines")).toContainText("deleted.ts");
  await panel.getByRole("button", { name: "查看原始 Diff", exact: true }).click();
  await expect(panel.locator(".file-lines")).toContainText("diff --git");
  await expect(panel.locator(".file-lines")).toContainText("@@ -38,2 +38,1 @@");
  await panel.getByRole("button", { name: "返回改动视图", exact: true }).click();
  await expect(panel.locator(".file-line.removed")).toContainText("old value");
  await expect(panel).toContainText("逐行作者尚未确认");
  await expect(panel.locator(".file-preview-provenance")).toContainText("zcode");
  await expect(panel.locator(".file-preview-provenance")).toContainText("resolved-model（执行配置）");
  await expect(panel.locator(".file-preview-provenance")).not.toContainText("requested-model");
  await panel.getByRole("button", { name: "内容", exact: true }).click();
  await expect(panel).toContainText("文件已删除");
  const reads = await page.evaluate(() => (window as unknown as { __fileReads: { cmd: string }[] }).__fileReads);
  expect(reads.map((r) => r.cmd)).toEqual(["get_task_file_patch"]);
});

test("office, binary and native media previews share one file panel", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await page.route("http://asset.localhost/**", (route) => route.fulfill({
    status: 200, contentType: "application/pdf", headers: { "Access-Control-Allow-Origin": "*" }, body: pdf,
  }));
  await setup(page);
  await page.getByRole("button", { name: "report.docx", exact: true }).click();
  const panel = page.getByRole("region", { name: "文件查看与改动审阅" });
  await expect(panel).toContainText("Office content");
  for (const [path, selector] of [["photo.png", "img"], ["movie.mp4", "video"]] as const) {
    await page.getByRole("treeitem", { name: path, exact: true }).click();
    await expect(panel.locator(selector)).toHaveAttribute("src", /asset\.localhost/);
  }
  await page.getByRole("treeitem", { name: "report.pdf", exact: true }).click();
  await expect(panel.getByLabel("PDF 第 1 页")).toHaveAttribute("width", "200");
  await expect(panel.locator("canvas")).toHaveCount(1);
  await expect(panel).toContainText("第 1 / 1 页");
  await page.getByRole("treeitem", { name: "data.bin", exact: true }).click();
  await expect(panel.locator(".file-lines")).toBeVisible();
  expect(await page.locator(".file-preview-panel").count()).toBe(1);
  expect(errors).toEqual([]);
});

test("project tree opens without a file dialog, supports preview and permanent tabs and reveals nested files", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "查看工作区文件", exact: true }).click();
  const workspace = page.getByRole("region", { name: "项目文件工作区" });
  await expect(workspace.getByRole("tree", { name: "项目文件树" })).toBeVisible();
  await workspace.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await expect(workspace.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
  await workspace.getByRole("treeitem", { name: "src", exact: true }).click();
  await workspace.getByRole("treeitem", { name: "app.ts", exact: true }).click();
  await expect(workspace.locator(".cm-content")).toContainText("export const value");
  await expect(workspace.getByRole("tab")).toHaveCount(2);
  await workspace.getByRole("treeitem", { name: "ordinary.txt", exact: true }).click();
  await expect(workspace.getByRole("tab")).toHaveCount(2);
  await expect(workspace.getByRole("tab", { name: "app.ts", exact: true })).toHaveCount(0);
  await expect(workspace.locator(".cm-content")).toContainText("ordinary 1");
  expect(await workspace.locator(".cm-line").count()).toBeLessThan(200);
  await workspace.getByRole("button", { name: "跳转 Ctrl+G", exact: true }).click();
  await workspace.getByRole("textbox", { name: "Go to line" }).fill("15000");
  await workspace.getByRole("textbox", { name: "Go to line" }).press("Enter");
  await expect(workspace.locator(".cm-content")).toContainText("ordinary 15000");
  await workspace.getByRole("tab", { name: "README.md", exact: true }).click();
  await expect(workspace.getByRole("treeitem", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "test-results/project-workspace-zed.png" });
  await workspace.getByRole("button", { name: "关闭 README.md", exact: true }).click();
  await expect(workspace.getByRole("tab", { name: "ordinary.txt", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(workspace.locator(".cm-content")).toContainText("ordinary 15000");
  const composer = await page.locator(".composer-card").boundingBox();
  expect(composer!.width).toBeGreaterThan(280);
});

test("project workspace fits narrow screens and tree supports keyboard expansion", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "查看工作区文件", exact: true }).click();
  const tree = page.getByRole("tree", { name: "项目文件树" });
  await tree.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: "app.ts", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "app.ts", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = page.getByRole("region", { name: "项目文件工作区" });
  const rect = await workspace.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.width).toBeLessThanOrEqual(390);
  await workspace.getByRole("button", { name: "隐藏项目目录", exact: true }).click();
  await expect(tree).toHaveCount(0);
  await expect(workspace.locator(".cm-content")).toBeVisible();
  await page.screenshot({ path: "test-results/project-workspace-mobile.png" });
});

test("Escape closes the reader without cancelling an active runner", async ({ page }) => {
  await setup(page, true);
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(page.getByRole("region", { name: "文件查看与改动审阅" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "文件查看与改动审阅" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __testCalls: string[] }).__testCalls);
  expect(calls).not.toContain("cancel_task");
});
