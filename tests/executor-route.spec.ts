import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./helpers";

/** 切到 OpenCode 会话（执行器指名拦截的“当前执行器”）。 */
async function useOpenCode(page: Page) {
  await page.getByRole("button", { name: "选择运行器" }).click();
  await page.getByRole("option", { name: "OpenCode" }).click();
}

test("自然语言指名执行器改派路由：用 zcode 的 glm5.3flash → start_task 落在 zcode 且模型命中", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/");
  await useOpenCode(page);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("用Zcode的glm5.3flash模型读一下这个项目");
  await input.press("Enter");

  await expect(page.locator(".action-notice")).toContainText("已按你的指示改派 zcode · GLM-5.3-Flash");
  await expect.poll(() =>
    page.evaluate(() => {
      const requests = (window as unknown as { __testRequests: { harness?: string; model?: string; prompt?: string }[] }).__testRequests ?? [];
      const task = requests.find((r) => r.harness === "zcode");
      return task
        ? { harness: task.harness, model: task.model, prompt: task.prompt }
        : null;
    }, undefined),
  ).toEqual({ harness: "zcode", model: "zhipuai-coding-plan/GLM-5.3-Flash", prompt: "读一下这个项目" });
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
