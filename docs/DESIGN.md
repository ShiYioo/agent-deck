# AgentDeck 设计系统

> 实现入口：`src/styles.css`（全部令牌与关键帧都在这里，组件只消费类名）。

## 设计立场

AgentDeck 是一张「指挥台」：人负责意图与验收，agent 负责执行。
界面应该像一张安静的纸——把注意力让给 agent 的输出流；
身份与状态用极少的信号色表达；动效只做三件事：**反馈、引导、连续性**。

## 色彩

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#ffffff` | 主纸面 |
| `--bg-subtle` | `#f7f7f8` | 侧栏、rail |
| `--border` / `--border-strong` | 黑色 8% / 16% | 全部边线只用黑透明度，不引入灰阶色值 |
| `--text-1/2/3` | `#18181b / #52525b / #a1a1aa` | 三级文字 |
| `--harness-zcode` | `#059669` 翠绿 | ZCode · GLM 的身份色 |
| `--harness-codex` | `#0284c7` 天蓝 | Codex · GPT 的身份色 |

**身份色纪律**：绿/蓝只允许出现在「harness 是谁」的语义上
（信号点、发送键、聚焦细线、侧栏选中条），绝不用于装饰。
状态色独立于身份色：running 蓝、done 绿、failed 红、cancelled 灰。

## 字体与排版

- 界面：system-ui / Microsoft YaHei 栈；日志与代码：`font-mono`。
- 空态标题 `text-2xl font-medium tracking-tight`，正文最小到 `text-xs`（日志）。
- 三级信息密度：日志 `text-xs leading-relaxed space-y-2`，条目不加分隔线，靠间距呼吸。

## 动效

三档时长，一条主曲线：

| 令牌 | 时长 | 场景 |
|---|---|---|
| `--dur-1` | 150ms | hover、按钮、颜色过渡 |
| `--dur-2` | 240ms | 事件滑入、弹层、composer 聚焦 |
| `--dur-3` | 420ms | 场景切换（空态↔任务） |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | 一切出场的默认曲线 |

清单：

- **场景切换**：空态↔任务视图 `scene-in`（420ms，位移+微缩放），以任务 id 作 key 触发。
- **空态**：点阵底纹（radial mask 边缘淡出）+ 品牌符与标题错落 70ms。
- **日志事件**：`ev-in` 240ms 滑入；历史回放按 24ms/条排队（封顶 12 条），实时流式时逐条即时滑入不排队。
- **thinking**：`shimmer-text` 流光扫过，表达「agent 正在想」。
- **运行中**：脉冲点（ring 扩散 2s）+ 三点打字指示；composer 禁用并显示打字点。
- **composer**：聚焦时边框深化、双层阴影抬升、底部品牌色细线渐显；发送键 hover 抬升 1px、按下回弹。
- **侧栏**：选中项左侧 2.5px 身份色信号条渐显；hover 仅背景过渡。
- **弹层**：背景 150ms 淡入，面板 240ms 弹性 pop（scale 0.97→1）。
- **滚动**：日志平滑滚底（`.log-scroll`）。

## 无障碍

`prefers-reduced-motion: reduce` 时，所有动画与过渡时长压到 0.01ms——
动效全部消失但信息结构不变。这是硬性要求，新增动画不得绕过它。

## 新增动效的检查单

1. 有明确的信息职责吗（反馈/引导/连续性）？纯装饰不加。
2. 时长落在三档之内？曲线用 `--ease-out`（需要回弹才用 `--ease-spring`）？
3. 会不会在流式输出时高频重放？进场动画必须只作用于「新挂载的节点」。
4. `prefers-reduced-motion` 下是否安静？
