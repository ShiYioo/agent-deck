import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

/** 选择负责理解请求的运行器。 */
async function useOpenCode(page: Page) {
  await page.getByRole("button", { name: "选择运行器" }).click();
  await page.getByRole("option", { name: "OpenCode" }).click();
}

test("指名运行器交给语义规划，保留完整请求并禁止前端猜测模型", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await useOpenCode(page);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("用Zcode的glm5.3flash模型读一下这个项目");
  await input.press("Enter");

  await expect(page.locator(".action-notice")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => {
      const calls = (window as unknown as { __testInvokes: { cmd: string; args: unknown }[] }).__testInvokes;
      return calls.find((call) => call.cmd === "start_task")?.args;
    }, undefined),
  ).toMatchObject({ harness: "opencode", workflow: true, prompt: "用Zcode的glm5.3flash模型读一下这个项目" });
});

test("当前执行器自己被指名时不拦截，照常派发", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await useOpenCode(page);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("用 opencode 的 subagent 机制想想这个方案");
  await input.press("Enter");

  await expect(page.locator(".action-notice")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => {
      const requests = (window as unknown as { __testRequests: { harness?: string; prompt?: string }[] }).__testRequests ?? [];
      const task = requests.find((r) => r.prompt?.includes("subagent"));
      return task?.harness ?? null;
    }),
  ).toBe("opencode");
});
