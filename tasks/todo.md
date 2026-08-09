# 数字化 AI 助手优化任务清单

> 对应计划：[`tasks/plan.md`](./plan.md)  
> 状态：T0–T6 已完成本机实施与验证

## C0：健康基线

- [x] 记录当前 Git 状态并保护已有 Electron 未提交改动。
- [x] 固化只选择源码 `*.test.mjs` 的跨平台测试入口。
- [x] 修复 `app/api/agent/new/route.test.mjs` 的 macOS realpath 假失败。
- [x] 清理 `scripts/electron-diag.js` 和 `scripts/pill-test-main.js` 的 3 个 Lint 错误。
- [x] 处理 `scripts/tmp-md-test.mjs` 的未使用变量或明确临时脚本边界。
- [x] 连续两次执行源码测试并确认结果一致。
- [x] 执行 `tsc --noEmit`、Lint、`git diff --check`。
- [x] 同步 README 的应用版本和 Pi SDK 基线。
- [x] 记录 Node / Next / Electron / Pi SDK / OS / arch 基线。
- [x] 评审 C0 结果。

## C1：核心用户旅程

- [x] 启动：冷启动、热启动、已有服务、默认端口占用、服务失败。
- [x] 生命周期：单实例、隐藏到托盘、恢复、窗口重建、完整退出和子进程回收。
- [x] 首次使用：选择 cwd、取消选择、默认 cwd、最近工作区恢复。
- [x] 会话：草稿、切换、重命名、删除、Fork、会话内分支、导出。
- [x] Worktree：创建、切换、脏目录删除确认、已移除目录回退。
- [x] Agent run：文本、图片、`@file`、模型、Thinking、工具预设。
- [x] 流恢复：刷新、后台、离线、SSE 半开、旧事件、abort、steer/follow-up。
- [x] 文件：索引、搜索、预览、本地 Markdown 图片、Git diff、外部拖入。
- [x] 设置：模型/Auth、技能、插件、主题、语言、项目 trust。
- [x] 为每条旅程记录正常、失败、恢复路径和用户可见不变量。
- [x] 选出并评审首批 3 个 P0/P1 用户旅程问题。

说明：T1 的真实模型调用、OAuth/API Key 写入、外部上传和打包应用 smoke 没有在隔离审计中执行；对应行为由现有自动测试覆盖，真实凭据/外部传输与打包平台验证保留到 C5。T1 未把这些未执行项写成真实运行证据。

## C2：安全与数据边界

- [x] 检查 BrowserWindow 安全选项、导航和新窗口策略。
- [x] 建立全部 preload/IPC 方法的参数与授权边界表。
- [x] 验证 `showItemInFolder` 不能接受 allow-list 外的任意 Renderer 路径。
- [x] 检查 Host / Origin / Sec-Fetch-Site / Basic Auth / LAN / SSE。
- [x] 检查 Electron readiness 与安全响应状态的兼容性。
- [x] 检查文件 realpath、符号链接、UNC、Windows 大小写和上传体积。
- [x] 检查项目 trust 是否覆盖扩展、插件、Prompt、Skills 的执行入口。
- [x] 检查 API Key、OAuth、日志、bash、路径、Base64 和系统提示词泄漏。
- [x] 检查 Fork、并发启动锁、原子写、JSONL 重写和进程退出完整性。
- [x] 为每个高风险入口补一个负向测试设计。
- [x] P0 安全/数据问题单独评审并先行处理。

说明：规范扫描报告位于 `docs/security-scan-2026-08-09/`；当前工作树完整依赖审计为 0 vulnerabilities。

## C3：性能与可观测性

- [x] 定义参考机器、固定测试项目和典型/长会话夹具。
- [x] 测量 Electron 冷/热启动到可交互时间。
- [x] 测量典型与长会话的加载、滚动和分支切换。
- [x] 测量高频流式更新、Markdown、代码高亮、Mermaid/KaTeX。
- [x] 测量大工具输出和流程步骤展开/折叠。
- [x] 测量大项目文件索引、搜索、Git status/diff 和 Worktree 切换。
- [x] 执行 30 分钟固定负载并观察定时器、registry、缓存与内存回收。
- [x] 使用 Profiler/trace 区分组件复杂度和真实渲染瓶颈。
- [x] 冻结第一轮性能预算和 10% 回归上限。
- [x] 评审 Langfuse 的必要性、隐私、成本、opt-in、fail-open 与 flush。

## C4：垂直优化切片

- [x] 切片 1：测试/Lint/版本文档门禁。
- [x] 切片 2：桌面启动、动态端口、托盘/退出、IPC 边界。
- [x] 切片 3：SSE、run id、reconciliation 与 JSONL 最终一致性。
- [x] 切片 4：项目恢复、文件/Git/Worktree 的体验、性能和授权。
- [x] 切片 5：长会话、流式 Markdown、流程步骤和大工具输出。
- [x] 切片 6：模型/Auth、技能、插件、trust 的状态与错误反馈。
- [x] 切片 7：仅拆分已有稳定边界的高耦合组件/hook。
- [x] 切片 8：可选的本地结构化指标或 Langfuse 接入。
- [x] 每个切片先有失败测试或 before 基准。
- [x] 每个切片通过测试、TypeScript、Lint 和 diff check。
- [x] Electron 切片完成打包应用 smoke；跨平台切片完成平台矩阵。
- [x] 每个切片记录风险、回滚方式和验证结果。

说明：本机实际 smoke 为 macOS arm64；Windows x64 由 CI 中的纯函数/结构测试与 Windows runner workflow 负责，未在 macOS 上虚构 Windows 运行证据。

## C5：CI 与发布

- [x] 新增 PR 级快速 CI，不在每次 PR 生成安装包。
- [x] 让本地和 CI 使用一致、跨平台的测试选择方式。
- [x] 保留并增强 Windows x64 实际打包目录 smoke test。
- [x] 覆盖默认端口被占用时的 packaged app 启动。
- [x] 增加 macOS 快速检查；评估未签名打包 smoke。
- [x] 记录安装包/解压体积、启动时间和关键版本。
- [x] 演练服务启动失败、Renderer 崩溃和日志采集。
- [x] 完成一次发布候选验证并评审 C4。

## C6：Markdown 文档交付

- [x] 创建 `docs/desktop-assistant-optimization.zh-CN.md`。
- [x] 写执行摘要和 Top 10 优化机会。
- [x] 写版本、架构、核心旅程和健康基线。
- [x] 写 P0/P1/P2 发现表及证据、投入、风险、验收。
- [x] 写安全边界、性能基准与性能预算。
- [x] 写 Now / Next / Later 路线和垂直提交切片。
- [x] 区分已实施、已验证、建议、暂缓状态。
- [x] 链接现有架构、上游同步和 Langfuse 文档，消除冲突事实。
- [x] 校验文档中的版本、命令和本地文件链接。
- [x] 提交最终报告供人工评审。
