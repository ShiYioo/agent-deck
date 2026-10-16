# 交互层对齐 ZCode —— 批次进度与交接

> 目的：把 Agent Deck 的对话流 / 流式工作交互，对齐 ZCode（桌面版 + TUI）的做法。
> 本文件是交接单：已完成什么、还剩什么、每批的验收标准与参照依据。

## 0. 参照物与依据

ZCode 的两个产品面，本仓库已调研完（结论见下，不必重新挖）：

- **桌面/Web 版**（与我们同口径）：仓库 `zai-org/ZCode` 的 `DESIGN.md`、`docs/ui/*.md`、
  `docs/chat/*.md`、`packages/ui/src/v4/{SessionPane,V4ChatPane,ConversationTimeline,ConversationComposer}.tsx`、
  `packages/ui/src/styles.css`
- **终端版**（真实产物）：本机 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`（压缩 JS，
  字符串可读；i18n 在 `o8o.tui` / `o8o.cli`，工具行摘要在 `summarizeToolCall`）

**要照抄的关键规则**（每条都有原文依据）：

1. **loading 是状态机**：只在「最后一个 running 轮且无 blocker」时显示；blocker =
   AskUserQuestion / permission / pendingApproval / 上下文压缩 / goal 校验。且
   「视觉上只渲染 loading 动画，不展示"正在思考"或其它可见文案」，无障碍名用通用的"加载中"。
2. **重试可见阈值**：`MIN_VISIBLE_API_RETRY_ATTEMPT = 3`，前两次重试不占转写。
3. **工具行**：`Tool <name> <status>` 单行摘要；状态色 running=accent / completed=success /
   failed=danger；输出超限截断并明示（TUI 文案 `[N KB of earlier output omitted]` /
   `[Truncated. Full output: <path>]` / `...[truncated]`）。
4. **思考与工作历史**：流式「Thinking · 摘要」→ 完成「Thought · duration」；
   工作历史折叠头「已工作 {duration}」（running 显示「工作中」）。
5. **文件变更汇总**：`ConversationFileSummaryPanel`「{n} 个文件已更改」+ 审查 / 撤销。
6. **子代理行永远单行摘要**（`agentName + primaryText + status`），点击开右侧只读 tab，
   **父行不得物化 child 的工具行**（否则 child 的 Read/Bash 会被画成父自己的）。
7. **上下文用量徽章**：composer 底部「上下文已用 {used} / 总量 {total}」；
   cache 命中率**仅 ≥78% 才展示**；K/M/B（英）vs 万/亿（中）。
8. **滚动是显式意图机** FOLLOWING / DETACHED：离底阈值 48px、吸底用 instant `scrollTop`
   （**禁 smooth**）、离底时消息层底部 96px 全透明 + 24px 渐变 mask、
   回底按钮仅"离底且有溢出"时出现；优先级：用户滚动意图 > 显式定位 > 内容/测高变化。
9. **队列**：标题「待发送消息（{count}）」；非 autoDrain 时暂停横幅 +「继续」；
   **编辑 = 撤回完整输入意图到 composer**（含附件恢复），不是在队列里原地改；
   `compact` 项无编辑入口。composer 快捷键：Enter 提交 / Shift+Enter 换行 /
   Cmd(Ctrl)+Enter 反转本次投递（queue↔startNow）/ Esc 停止。
10. **令牌与禁止清单**：强制 `text-ui-*` 字号阶（`xl/lg/base/caption/sm/xs` = +4/+2/0/−1/−2/−4px，
    默认 14px），**禁止** Tailwind `text-base/sm/xs`、`text-[13px]`、内联 font-size；
    圆角阶梯 `rounded-xl → lg → md → sm`；**diff 用专用语义色**（明文：不许拿 success/destructive
    顶上）；**等待确认全产品统一一个绿**；**状态永不只靠颜色**（aria-label 必带状态词）；
    动效「fast and low-drama」，禁 spring 弹性。

## 1. 环境与工作流（跨机器注意）

- 仓库：`D:\新建文件夹\agent-deck`（目录名含中文，命令里加引号）。分支 `main`。
- **`pnpm` 不一定在 PATH**：优先试 `corepack pnpm …`；本机之前用的是会话级临时 shim
  （`…\Temp\commandcode\…\scratchpad\pnpm.cmd`），**换机器后该 shim 不存在**，需要自行
  装/找 pnpm（或 `corepack enable`）。Rust 需要 `%USERPROFILE%\.cargo\bin` 在 PATH。
- 验证命令：

  ```powershell
  corepack pnpm exec tsc --noEmit                     # 每次改完必跑
  corepack pnpm exec playwright test tests/<x>.spec.ts --reporter=line   # 迭代期只跑相关 spec
  corepack pnpm exec playwright test                                   # 收尾再全量（基线 80 passed）
  cargo test                                          # 只有动 Rust 时才跑（基线 124 passed, 1 ignored）
  ```

- 提交约定：
  1. `git add <精确文件>`，**不要 `git add -A`**（仓库有未跟踪的 `.commandcode/`，属于 taste 学习目录，不能提交）。
  2. 提交信息**必须**用 UTF-8 文件：先 `write_file` 写到临时目录，再 `git commit -F <路径>`。
     （PowerShell here-string 管道会把中文变成 `?`，已被坑过两次。）
  3. 结尾必须是 `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>`。
  4. **不要 push**，除非用户明确说"提交推送"。不要 amend 别人的提交。

- 测试约定：`tests/helpers.ts` 的 `mockDesktop(page, failSend?)` 起 mock；
  注入事件用 `window.__emit`：
  - `__emit("task-event", { taskId: "new-task", event: { type: "status", … } })`（已归一化事件，最常用）
  - `__emit("pi-event", { taskId: "new-task", type: "tool_execution_start", toolName, args })`（deck/pi 原始事件）
  - mock 的首个运行中任务 id 恒为 `new-task`。
- 硬约束：中文文案 + 中文注释（只写"为什么"）；不引入新依赖；不动 `src-tauri/`（除非任务要求）。

## 2. 已完成

前置（同一 UX 主题，已完成）：

| commit | 内容 |
| --- | --- |
| `cb97a8e` | 文件操作在四个运行器统一可见（目标文件 / 增删徽标 / ±行数），事件模型加 `ToolResult.added/removed` |
| `c7c5471` | zcode app-server 转发工具生命周期（`tool.updated` → tool_use/tool_result，含 `operation.path/diff`） |
| `2da08ba` | 「本轮运行」只显示可读模型名，去掉内部 `mp-…` id 与"默认"占位 |
| `bf022d9` | 本轮产出按会话隔离：轮次结束在 `finish_task` 冻结目录快照（`tasks.result_manifest`） |
| `8d60df1` | 运行中只看本任务事件碰过的文件（`touched_files_from_events`），跨会话严格隔离 |

**批次 1**（`f9678a8`）工具行"活着"：

- 状态词 `执行中 / 已执行 / 执行失败`（`EventLine.tsx` 的 `statusWord`）——状态不只靠颜色
- 运行中的行加 indeterminate 扫光条：`.tool-sweep`（`styles.css`，role=progressbar + aria-label，
  跟随 `prefers-reduced-motion` 与 `html[data-document-hidden]` 停动）
- 输出超 200 行截断并明示「另有 N 行未显示」（`capOutput` + `.output-truncated`）

**批次 2**（`72b541d`）等待状态机 + 思考行文案：

- `LogPanel` 新增 `blocked` prop；`App.tsx` 传 `!!approval || !!selectedLive?.compacting`
  （**提问也在这个 approvals 队列里**，所以已覆盖 AskUserQuestion）
- 空态与"有内容"两种情况都只在 `running && !blocked` 时显示 `<LoadingIndicator/>`
  （只有动画、`aria-label="加载中"`，挂在转写末尾随内容滚动）
- 思考行：`streaming` → 「正在思考」（`.thought-streaming` 图标呼吸）；结束 → 「思考 · Ns」(`thoughtDuration`)
- 重试阈值：`conversation.ts` 的 `MIN_VISIBLE_API_RETRY_ATTEMPT = 3` + `retryAttempt()` 解析
  `<n>/<max>`、`第 n 次`、`attempt n`；`retryKey === "local-compact"` 豁免；解析不到则照常显示

## 3. 批次 3-7 完成情况（2026-10-16）

| 批次 | 状态 | 提交/说明 |
| --- | --- | --- |
| 3 上下文用量徽章 | ✅ | `02fbd89`：complete.tokens → used（input+output），window 仅 deck 上报；cache 命中率 ≥78% 才露出 |
| 4 diff 语义色 | ✅ | `2727b1d`：`--color-diff-added/removed(+bg)` 令牌；opBadge/±计数/DiffModal 行全部改走语义色 |
| 5 文件变更汇总 | ✅ | 标题「N 个文件已更改」；diff 按钮改「审查」语义；删除文件无审查入口但保留状态词 |
| 6 子代理单行摘要 | ✅（架构上已满足） | 我们的 delegate/协作事件从不下沉 child 工具行进父转录（协作面板独立渲染），父流里的 delegate 本来就是单行 tool 摘要——无 child 物化问题可修 |
| 7 滚动状态机+队列 | ✅ | 48px 离底阈值、贴底 instant（删 smooth 中间帧误读）、离底 96px 透明+24px 渐变 mask、回底按钮需有溢出；队列标题「待发送消息（N）」、编辑=撤回完整意图回 composer（/compact 项无编辑） |

注意：批次 3 的提交（02fbd89）里 App.tsx 已引用批次 7 的 Composer `injectedDraft` prop，
该 prop 在批次 7 提交（本提交）才入库——02fbd89..本提交 之间单独 checkout 会 tsc 失败，tip 完整。

## 4. 待完成批次

> 每批：实现 → `tsc` + **相关 spec** → 独立提交（用户明确要求别每批跑全量 UI）。

### 批次 3：上下文用量徽章（P1-④）

- 目标：composer 底部显示「上下文已用 {used} / 总量 {total}」，cache 命中率 **≥78% 才显示**。
- 数据来源：`complete` 事件的 `tokens`（`AgentEvent.complete.tokens`）与各 harness 上报的
  contextWindow；取**最近一次**已知值，跨会话按 taskId 隔离（不要用别的任务的用量）。
- 落点：`App.tsx` composer dock（`.composer-dock` / `RuntimeStatus` 附近），或新组件
  `src/components/ContextUsage.tsx` 由 App 挂载。
- 验收：`running` 且有 tokens 时显示；没有数据时不显示（不要编 0）；≥78% 的 cache 命中率才出现。

### 批次 4：令牌化 + diff 专属语义色（P1-⑤）

- `styles.css` 增加令牌：`--ui-font-size: 14px` + `.text-ui-*` 工具类（或直接定义字号变量），
  以及 `--color-diff-added` / `--color-diff-removed`；**删改一律用 diff 语义色**，
  不再用通用 emerald/red（涉及 `EventLine.tsx` 的 `diffBadge`/`opBadge`、
  `TurnArtifacts.tsx` 的 +/- 与状态词、`DiffModal`）。
- 逐步清掉内联 `text-[11px]/text-[12px]/text-[13px]`，改用 `text-ui-*`（**范围要收敛，
  一次别全动**；按组件推进，每组件一提交）。
- 验收：无新增内联字号；diff 颜色来自令牌；状态仍带可读文本（不只靠颜色）。

### 批次 5：文件变更汇总面板（P1-⑥）

- `TurnArtifacts.tsx`：标题从「本轮产出」改为「{n} 个文件已更改」，并给每行/整体加
  **审查（打开 diff）** 入口（现在有 diff 按钮但缺"审查"语义），保留撤销（二次确认已有）。
- 验收：n 与文件行数一致；删除文件没有 diff 入口但仍有状态词「删除」。

### 批次 6：子代理单行摘要（P2-⑦）

- 目标：委派/协作产生的子代理调用，在父转录里**只保留一行摘要**
  （`agentName + primaryText + status`），点击开只读面板（可复用 `DiffModal` 形态的抽屉）。
- **关键正确性**：父行**不得物化 child 的工具行**——现在子代理的事件若混进父事件流，
  会把 child 的 Read/Bash 画成父自己的。需要按 `agentId`/`childSessionId` 过滤
  （zcode 的 `tool.updated` 带 `agentId/childSessionId/childToolCallId`，codex/opencode 见各自 parser）。
- 验收：子代理行恒为单行；展开不出现子工具明细；父转录不出现 child 工具。

### 批次 7：滚动意图机 + 队列语义（P2-⑧⑨）

- 滚动：`App.tsx` 的 follow/scroll-latest 升级为**显式 FOLLOWING/DETACHED 状态机**：
  离底阈值 48px、吸底用 instant `scrollTop`（禁 smooth）、离底时底部加 96px 透明 + 24px 渐变
  mask（`styles.css`），回底按钮仅"离底且有溢出"时出现。
- 队列：标题「待发送消息（{count}）」；非自动续发时顶部「队列已暂停 / 继续」横幅；
  **编辑 = 撤回重填到 composer**（不是原地改）；`/compact` 项无编辑入口。
- 验收：上滚后新内容不抢滚动权；回底恢复吸附；队列编辑后输入框拿到完整原文。

## 4. 已知取舍 / 风险

- **轮级「已工作 {duration}」折叠头暂缓**：我们的行没有时间戳（重放的历史事件无法还原到达时刻），
  而 `complete` 行已经显示「工作 N 秒」，收益低、风险高。
- **运行中的产出仍是事件驱动**：CLI 用 shell 悄悄改的文件要等轮次结束（冻结快照）才补齐；
  这是共用目录下的固有取舍，见 `docs/RUNTIME.md` 相关段落。
- 全量 UI 基线：**80 passed**；Rust：**124 passed, 1 ignored**。改动若让既有断言失败，
  **更新断言**而不是回退功能（文案变化属预期）。
- 收尾前务必跑一次全量 `playwright test` + `tsc`；如动了 Rust 再跑 `cargo test`。
