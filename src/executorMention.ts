/** 自然语言执行器指名：消息开头“用/让 <executor> [的 <模型> 模型] …”时改派路由。
 *  只在消息起始匹配（同 @ 路由锚点），阴性词（“不要用 zcode”）不会命中；
 *  当前会话就是该执行器时不触发（deck 自带委派工具，也不需要拦）。
 *  纯函数，便于单测/防回归。 */

export type ExecutorMention = {
  harness: string;
  /** 模型提示（如 glm5.3flash），需调用方用 discover 结果模糊解析 */
  modelHint: string | null;
  /** 去掉指名前缀后的剩余任务文本 */
  rest: string;
  length: number;
};

const EXECUTORS = "zcode|codex|opencode|deck";
const MODEL_TOKEN = "[a-z0-9._\\-]+";

const MENTION_RE = new RegExp(
  `^(?:请|麻烦|帮忙|帮我)?(?:用|让|叫|派|交给|由|换)\\s*(${EXECUTORS})\\s*(?:的\\s*(${MODEL_TOKEN})\\s*(?:模型)?)?\\s*[，,。]?\\s*`,
  "i",
);

export function detectExecutorMention(
  text: string,
  currentHarness: string,
): ExecutorMention | null {
  const match = MENTION_RE.exec(text.trim());
  if (!match) return null;
  const harness = match[1].toLowerCase();
  if (harness === currentHarness.toLowerCase()) return null;
  const rest = text.trim().slice(match[0].length).trim();
  // 指名之后必须还有正事可干，否则只是闲聊提及
  if (!rest) return null;
  return { harness, modelHint: match[2] ?? null, rest, length: match[0].length };
}
