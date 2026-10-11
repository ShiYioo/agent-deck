# Agent Deck

一个桌面「多 harness 指挥台」：用统一的界面驱动 **ZCode（GLM）**、**Codex（GPT）** 等无头编码 agent——派任务、看日志、续会话，全部在一个窗口完成。

Agent Deck 提供两类运行器：`deck` 使用 pi SDK 执行模型请求和编码工具；ZCode、Codex、OpenCode 保留原生 CLI，通过适配器接入同一套消息、退出状态和持久化管道。

## 功能（M1）

- 一键派任务给 ZCode / Codex（无头模式，自动隐藏控制台窗口）
- 实时日志流：消息、思考、工具调用、结果统一渲染
- 会话续接：自动提取 session id，一键继续上次任务
- 任务取消、退出码、鉴权失败识别（后续弹出登录引导）
- 流式回复、可见的上游错误、运行器健康检查与工具审批
- 续聊保留前文与模型/权限配置，排队消息逐轮续发
- 三端会话接力及任意方向的指导协作：先制定方案、执行、独立验收，按反馈返工并保存各阶段记录

运行协议、状态管理与测试边界见 [docs/RUNTIME.md](docs/RUNTIME.md)。

## 架构

```
┌─ Tauri 2 桌面壳（WebView2）─────────────────────┐
│  React + Tailwind                              │
│   harness 选择器 │ 任务表单 │ 日志流面板          │
│        ↕ commands / events                      │
│  Rust 后端                                      │
│   executors/  适配器层（本项目的灵魂）             │
│   ├─ zcode.rs → zcode --json --mode <m> -p …    │
│   ├─ codex.rs → codex exec --json …             │
│   └─ runner.rs → spawn / 流解析 / 事件推送        │
└─────────────────────────────────────────────────┘
```

新增 harness 的方式：`src-tauri/src/executors/` 加一个模块，实现
`parse_line`（JSONL → 统一事件）并在 `Harness` 枚举上补一个分支，前端零改动。

## 设计系统

美术风格与动效令牌见 [docs/DESIGN.md](docs/DESIGN.md)——色板、三档动效时长、入场曲线、以及「新增动效检查单」都在那里。所有令牌实现于 `src/styles.css`。

## 开发

前置要求：Node 20+、pnpm、Rust 1.85+（Windows 需 MSVC）、ZCode CLI / Codex CLI 已安装并在 PATH 上。

```bash
pnpm install          # 安装前端依赖
pnpm test:runtime     # 真实 sidecar + 本地模拟模型服务（不使用实际 API Key）
pnpm test:ui          # 消息流、续聊、错误反馈、审批及响应式回归
pnpm tauri dev        # 启动开发模式（前端热重载）
pnpm tauri build      # 打包 NSIS 安装包
cargo test            # 运行 Rust 适配器单元测试（在 src-tauri/ 下）
```

`pnpm dev` 仅提供浏览器界面预览，没有 Tauri IPC，不会执行真实任务。界面会显示运行器未连接；真实对话请使用 `pnpm tauri dev`。`deck` 需在设置里启用至少一个有效模型配置；CLI 运行器需先安装对应 CLI 并完成登录。

## Roadmap

- [x] M1：派任务 + 日志流 + 会话续接 + 取消
- [x] M2：SQLite 会话历史持久化、任务列表管理
- [x] M3：git diff 面板、并行任务视图、失败重试 / 登录引导按钮
- [ ] M4：打包分发、更多 harness（claude、qoder via ACP）

## License

Apache-2.0。executor 适配逻辑参考了 [vibe-kanban](https://github.com/BloopAI/vibe-kanban)（Apache-2.0）的设计。
