# AgentDeck

AgentDeck 是一个面向 Windows 的 AI 编程工作台。它把 ZCode、Codex、OpenCode 和内置 Deck 运行器放进同一个桌面界面，让多个运行器可以共享一个逻辑会话、接力执行任务、并行协作、检查成果和继续返工。

它不把不同模型伪装成同一个模型，也不要求它们共享供应商的原生会话文件。AgentDeck 负责保存用户目标、公开记录、阶段状态、成果版本和验收证据；每个运行器仍然使用自己的原生会话、权限和上下文压缩机制。

当前版本：`0.1.1`

## 下载安装

Windows 安装包由 GitHub Release 自动生成：

[下载 AgentDeck v0.1.1](https://github.com/ShiYioo/agent-deck/releases/tag/v0.1.1)

安装器支持：

- 自定义安装目录；
- 仅为当前用户安装；
- 为所有用户安装；
- 自动创建开始菜单入口；
- 使用新的 AgentDeck 应用图标。

运行 Deck 运行器和各 CLI harness 时，需要在本机安装 Node.js，并让对应 CLI 可以从 PATH 找到。

## 它能做什么

### 一个窗口管理多个运行器

| 运行器 | 用途 |
| --- | --- |
| `opencode` | OpenCode CLI 或 OpenCode Server/ACP |
| `zcode` | ZCode CLI 及其模型配置 |
| `codex` | Codex CLI / App Server |
| `deck` | AgentDeck 内置的 pi 运行时和工具集 |

每轮任务会记录实际使用的运行器、模型、权限、工作目录、会话句柄和执行结果。运行器名称只是路由入口，后续协作可以由其他运行器接手。

### 自动理解和分工

自动分工是 AgentDeck 的默认行为，不是一个需要打开的可选开关。

普通请求会先由当前选中的运行器理解，然后直接执行。明确提出“让 OpenCode 指挥 ZCode”“让 Codex 检查 Deck 的成果”“让两组任务并行”等要求时，平台会生成结构化任务图，并启动真实的运行器执行。

任务图支持：

- 顺序执行；
- 多个独立并行组；
- 多组指挥链同时运行；
- 依赖汇合；
- 指挥方规划、执行方实施、指挥方验收；
- 限定轮数的返工；
- 版本化成果和验收绑定；
- 失败节点、阻塞节点和取消节点的独立处理。

四个运行器都可以承担指挥方或执行方。协作通过 AgentDeck 的本地编排层完成，不依赖 MCP 才能让运行器互相指挥。

### 会话接力和上下文恢复

一个 AgentDeck 聊天对应一个逻辑会话，内部可以拥有多个运行器的原生会话绑定。

- A → B → A 时，A 会恢复自己的原生会话，并接收 B 留下的公开成果；
- 新的用户要求始终优先于历史资料；
- 用户原话、共享目标、约束、决策和成果版本持久化保存；
- 长历史使用本地恢复档案和分页读取，不把全部历史一次塞进模型上下文；
- 运行器自己的自动压缩不会被误判为任务完成；
- Codex 手动压缩完成后，会在原线程继续执行，只有继续执行的 turn 真正完成才结束任务；
- 重启后的运行任务不会静默重放命令，必须先核对遗留进程和工作区。

不同运行器的上下文压缩能力不完全相同。平台因此保存可恢复的任务契约和阶段检查点，但不宣称可以无损迁移供应商内部的私有推理或缓存。

### 文件工作区和改动审阅

任务详情中可以直接打开项目目录树和文件：

- 文本、代码、Markdown、JSON、YAML、XML、HTML、SVG、CSV、日志；
- 图片、PDF、音视频；
- DOCX、PPTX、ODT、ODP；
- XLSX、XLSM、ODS；
- ZIP 和其他二进制的有界预览。

文件查看器支持语法高亮、行号、全文查找、复制、目录树、标签页、外部打开和在文件夹中显示。大型文件使用后端稀疏索引和按视口读取，不把整个文件长期加载到前端。

每轮任务下方会显示文件改动和 diff：

- 文件按普通改动和生成文件分组；
- diff 按需读取并虚拟化渲染；
- 每个文件保留运行器和模型执行上下文；
- 结果可以打开到完整文件工作区；
- 在满足快照、哈希和 Git 基线条件时，可以安全撤销本轮改动；
- 冲突、脏基线、文件被外部修改和旧记录会明确拒绝不安全撤销。

运行器和模型是执行上下文记录，不被伪装成逐行作者证明。

### 运行控制和安全边界

- 任务可以停止、排队、续发和取消；
- 工具审批按 `taskId + toolCallId` 定位；
- 跨运行器接力不会自动扩大权限；
- 只读、计划和验收阶段不会允许执行写入；
- 每个协作阶段有自己的任务 ID 和执行证据；
- Git 协作使用隔离 worktree 和固定基线；
- 非 Git 协作使用声明的输入、输出和哈希版本；
- 同一个工作目录由租约保护，避免多个 AgentDeck 任务同时写入；
- 应用数据目录使用单实例锁，避免两个 AgentDeck 实例竞争同一数据库；
- 删除运行中或需要恢复确认的聊天会被阻止；
- 失败启动、异常退出和迟到事件不会留下永久运行状态。

## 一个典型工作流

用户可以直接输入：

> 让 OpenCode 规划支付模块重构，交给 ZCode 实现，再由 OpenCode 检查结果；同时让 Codex 检查文档，Deck 运行测试。

AgentDeck 会把它解析成多个真实节点，展示指挥和依赖关系，并按可用并行度执行：

```text
OpenCode（规划）
        │
        ▼
ZCode（实施） ─────► OpenCode（验收 / 返工）

Codex（文档检查） ─► Deck（测试）
```

执行期间可以查看每个节点的阶段、运行器、模型、工作目录、报告、文件产出、验收结论和成果版本。

## 架构

```text
┌─ Tauri 2 桌面应用 ─────────────────────────────┐
│ React + TypeScript + CodeMirror                 │
│ 对话时间线 · 目录树 · 文件预览 · Diff · 协作图   │
└───────────────────────┬────────────────────────┘
                        │ IPC / task-event
┌─ Rust 编排与持久化层 ──────────────────────────┐
│ SQLite 会话账本、任务图、租约、恢复、成果版本   │
│ 上下文投影、权限边界、阶段验收、撤销校验         │
└───────────┬────────────┬────────────┬──────────┘
            │            │            │
       Codex adapter  OpenCode     ZCode     Deck sidecar
       App Server     Server/ACP   CLI       pi runtime
```

运行器适配器将各自的事件协议映射为统一事件，保留文本、思考、工具调用、工具结果、错误、审批、压缩状态和终态。平台不会把一个运行器的私有历史文件直接交给另一个运行器。

## 外部控制

AgentDeck 运行后，具有 shell 访问权限的运行器可以通过本地 `runnerctl` 提交和观察协作任务：

```bash
pnpm runnerctl tasks
pnpm runnerctl submit --source TASK_ID --nodes-file plan.json --parallel 2
pnpm runnerctl runs --source TASK_ID
pnpm runnerctl wait RUN_ID --source TASK_ID
pnpm runnerctl cancel RUN_ID --source TASK_ID --node api
```

这条接口用于本机控制当前 AgentDeck 实例，不是远程服务，也不替代权限和工作目录租约。

## 本地开发

### 前置环境

- Windows 10/11；
- Node.js 20 或更高版本；
- pnpm 10；
- Rust stable，Windows 使用 MSVC 工具链；
- 需要使用的 ZCode、Codex 或 OpenCode CLI；
- WebView2 Runtime（Windows 通常已预装）。

### 启动和测试

```bash
pnpm install

# 浏览器预览，只用于查看界面；没有 Tauri IPC，不能执行真实任务
pnpm dev

# 真实桌面开发模式
pnpm tauri dev

# 前端构建
pnpm build

# 构建内置 Deck / Native sidecar
pnpm bundle:sidecar

# JavaScript 运行时与适配器测试
pnpm test:runtime

# Playwright UI 回归
pnpm test:ui

# 控制接口测试
pnpm test:control

# Rust 单元测试
cd src-tauri
cargo test

# Rust 格式和静态检查
cargo fmt --all -- --check
cargo clippy -- -D warnings
```

`pnpm dev` 只提供浏览器页面预览，会显示运行器未连接。需要执行真实任务时请使用 `pnpm tauri dev`。

### 打包 Windows 安装器

```bash
pnpm tauri build
```

安装器生成在：

```text
src-tauri/target/release/bundle/nsis/
```

Tauri 配置位于 [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)，Windows NSIS 配置支持自定义目录和当前用户 / 所有用户安装模式。

## GitHub Actions

`.github/workflows/ci.yml` 在 Windows runner 上执行：

- pnpm 依赖安装；
- sidecar 构建；
- Rust 格式检查、测试和 Clippy；
- 前端类型检查和构建；
- Windows NSIS 安装器构建；
- 安装包 artifact 上传。

向 `main` 推送或提交 Pull Request 会触发 CI。推送 `v*` tag 会触发 `.github/workflows/release.yml`，构建并发布 Windows 安装包到 GitHub Release。

发布前应确保：

1. `package.json` 版本和 `src-tauri/tauri.conf.json` 版本一致；
2. tag 使用 `v<version>` 格式；
3. CI 通过后再将安装包交给用户。

## 文档索引

- [平台工作流](docs/WORKFLOWS.md)：默认分工、计划协议、并行任务和模型绑定。
- [命令链与协作](docs/COMMAND-COLLABORATION.md)：多组指挥链、隔离 DAG 和 `runnerctl`。
- [上下文恢复](docs/CONTEXT-RECOVERY.md)：跨运行器接力、上下文预算和压缩恢复。
- [运行与对话契约](docs/RUNTIME.md)：任务生命周期、权限、取消和恢复语义。
- [文件查看器](docs/FILE-PREVIEW.md)：目录树、文件类型和大文件性能策略。
- [对话内变更审阅](docs/TURN-REVIEW.md)：diff、产出分组和安全撤销。
- [性能约定](docs/PERFORMANCE.md)：时间线、扫描、虚拟化和基准测试。
- [设计系统](docs/DESIGN.md)：视觉、布局、动效和交互约束。
- [协作实施记录](docs/COLLABORATION_IMPLEMENTATION.md)：当前落地范围和已知边界。

## 当前边界

AgentDeck 当前优先保证本地 Windows 桌面执行的可追溯性和安全恢复：

- 不保证不同供应商的原生上下文可以无损互相导入；
- 不把 MCP、ACP 或 A2A 宣称成跨模型共享记忆；
- 不提供远程多用户协作服务；
- 不在没有验证结果时自动覆盖外部修改；
- 不把模型名称模糊匹配成另一个模型；
- OpenCode 可提问服务端模式、附件能力和具体 CLI 版本取决于本机安装版本；
- 四个真实运行器的所有组合仍需要在目标机器上完成供应商登录和端到端验证。

## 许可证

Apache-2.0。

executor 适配逻辑参考了 [vibe-kanban](https://github.com/BloopAI/vibe-kanban) 的相关设计，遵循其 Apache-2.0 许可。
