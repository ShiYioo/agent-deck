const { chromium } = await import(
  "./node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/index.mjs"
);
const browser = await chromium.connectOverCDP("http://localhost:9223");
const page = browser.contexts()[0].pages()[0];
await page.waitForTimeout(1200);

async function pickMode(label) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("title") === "权限模式");
    btn?.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate((label) => {
    const opt = [...document.querySelectorAll("*")].find(
      (el) => el.textContent?.trim().startsWith(label) && el.children.length === 0,
    );
    opt?.click();
  }, label);
  await page.waitForTimeout(400);
}

// 1. 新聊天 → deck → 计划模式
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "新聊天");
  btn?.click();
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("title") === "选择 harness");
  btn?.click();
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const opt = [...document.querySelectorAll("*")].find(
    (el) => el.textContent?.trim() === "AgentDeck Agent" && el.children.length === 0,
  );
  opt?.click();
});
await page.waitForTimeout(400);
await pickMode("计划模式");
const ta = page.locator('textarea[aria-label="消息"]');
await ta.fill("我想给项目加一个暗色主题，给我一个计划");
await page.keyboard.press("Enter");
console.log("PLAN_SENT");
try {
  await page.locator(".log-scroll").getByText(/任务(完成|结束)/).first().waitFor({ timeout: 180000 });
} catch {}
await page.waitForTimeout(800);
const planLog = await page.evaluate(() => document.querySelector(".log-scroll")?.innerText ?? "");
console.log("PLAN_DISCIPLINE:", planLog.includes("计划模式"));
console.log("PLAN_HAS_STEPS:", planLog.includes("计划") && (planLog.includes("步骤") || planLog.includes("阶段")));
await page.screenshot({ path: "debug-plan.png" });

// 2. 新聊天 → 目标模式
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "新聊天");
  btn?.click();
});
await page.waitForTimeout(500);
await pickMode("目标模式");
await ta.fill("本会话目标：确认暗号是西瓜");
await page.keyboard.press("Enter");
console.log("GOAL_SENT");
try {
  await page.locator(".log-scroll").getByText(/任务(完成|结束)/).first().waitFor({ timeout: 180000 });
} catch {}
// 第二轮：问暗号（goal 注入应让模型记得）
await page.waitForTimeout(800);
await ta.fill("暗号是什么？");
await page.keyboard.press("Enter");
try {
  await page.locator(".log-scroll").getByText(/任务(完成|结束)/).nth(1).waitFor({ timeout: 180000 });
} catch {}
await page.waitForTimeout(800);
const goalLog = await page.evaluate(() => document.querySelector(".log-scroll")?.innerText ?? "");
console.log("GOAL_INJECTED:", goalLog.includes("会话目标"));
console.log("GOAL_REMEMBERED:", goalLog.includes("西瓜"));
await page.screenshot({ path: "debug-goal.png" });
await browser.close();
