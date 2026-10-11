const { chromium } = await import(
  "./node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/index.mjs"
);
const browser = await chromium.connectOverCDP("http://localhost:9223");
const page = browser.contexts()[0].pages()[0];
await page.waitForTimeout(1200);

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
const ta = page.locator('textarea[aria-label="消息"]');
await ta.fill("创建文件 report-notes.md，内容写三行项目笔记（随意）。不要创建其他文件。");
await page.keyboard.press("Enter");
console.log("SENT");
try {
  await page.locator(".log-scroll").getByText(/任务(完成|结束)/).first().waitFor({ timeout: 240000 });
} catch {}
await page.waitForTimeout(2500);
const panel = await page.evaluate(() => {
  const el = document.querySelector(".turn-artifacts");
  return el ? el.innerText.replace(/\n+/g, " | ") : "(无面板)";
});
console.log("PANEL:", panel.slice(0, 300));
console.log("NO_DEMO:", !panel.includes("demo.png"));
await page.screenshot({ path: "debug-deliver.png" });
await browser.close();
