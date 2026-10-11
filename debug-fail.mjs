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
await ta.fill("读取文件 C:\nonexistent\no-such-file.txt 的内容，读不到就直接回复：读不到。分两次思考再回答");
await page.keyboard.press("Enter");
console.log("SENT");
try {
  await page.locator(".log-scroll").getByText(/任务(完成|结束)/).first().waitFor({ timeout: 180000 });
} catch {}
await page.waitForTimeout(1000);
const log = await page.evaluate(() => {
  const el = document.querySelector(".log-scroll");
  return el ? el.innerText : "";
});
console.log("FAIL_TITLE:", /失败/.test(log));
const fails = log.split("\n").filter((l) => l.includes("失败"));
console.log("FAIL_LINES:", JSON.stringify(fails.slice(0, 3)));
console.log("THINK_TIMED:", (log.match(/思考 · \d+(\.\d+)? 秒/g) || []).length, "块带耗时");
const timed = log.split("\n").filter((l) => /思考 · /.test(l));
console.log("TIMED_LINES:", JSON.stringify(timed.slice(0, 5)));
await page.screenshot({ path: "debug-fail.png" });
await browser.close();
