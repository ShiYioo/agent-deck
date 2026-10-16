import { expect, test } from "@playwright/test";
import { mockDesktop } from "./helpers";

test("a running task restored in a fresh view keeps streaming and queues its next message", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __testTasks: { id: string; status: string; conversation_id: string }[];
      __testTaskEvents: Record<string, unknown[]>;
      __testBeforeTaskReplay?: () => void;
      __emit: (event: string, payload: unknown) => void;
    };
    Object.assign(w.__testTasks[0], { status: "running", conversation_id: "a" });
    const event = { type: "assistant_message", text: "恢复前已经输出的内容" };
    w.__testTaskEvents = { a: [event] };
    w.__testBeforeTaskReplay = () => {
      delete w.__testBeforeTaskReplay;
      // The snapshot already contains the first event; the second arrived after the snapshot.
      w.__emit("task-event", { taskId: "a", event });
      w.__emit("task-event", { taskId: "a", event: { type: "assistant_message", text: "恢复期间的新内容" } });
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByText("恢复前已经输出的内容", { exact: true })).toHaveCount(1);
  await expect(page.getByText("恢复期间的新内容", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("完成后继续检查");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByText("当前会话已有执行者运行中，请等待结束或停止后再接力", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __testRequests: unknown[] }).__testRequests.length)).toBe(0);
  await page.evaluate(() => {
    (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("task-exit", {
      taskId: "a", code: 0, status: "done",
    });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testRequests: { prompt: string }[];
  }).__testRequests[0]?.prompt)).toBe("完成后继续检查");
});

test("an exit received during restoration wins over the fetched running status", async ({ page }) => {
  await mockDesktop(page, false);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __testTasks: { status: string }[];
      __testTaskEvents: Record<string, unknown[]>;
      __testBeforeTaskReplay?: () => void;
      __emit: (event: string, payload: unknown) => void;
    };
    w.__testTasks[0].status = "running";
    w.__testTaskEvents = { a: [{ type: "assistant_message", text: "结束前的内容" }] };
    w.__testBeforeTaskReplay = () => {
      delete w.__testBeforeTaskReplay;
      w.__emit("task-exit", { taskId: "a", code: 0, status: "done" });
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "调整工作台布局", exact: true }).click();
  await expect(page.getByText("结束前的内容", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("继续检查");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testRequests: { prompt: string }[];
  }).__testRequests[0]?.prompt)).toBe("继续检查");
});
