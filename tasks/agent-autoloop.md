# Agent Autoloop 集成执行记录

目标：完成 [集成计划](../docs/agent-autoloop-integration-plan.zh-CN.md) 的首版 P0–P5；P6 是计划明确列出的后续扩展。用户已授权实施。普通聊天和现有桌面资产必须保持可用。

- [ ] P0：本机 Node/SQLite、Pi 无页面执行与扩展隔离已验证；其他目标平台待 runner 验证。
- [ ] P1：hub、原生 Pi worker、事件、结果与 outbox 已实现并验证；目录互斥复审修复中。
- [x] P2：持久卡片、同会话回答接续、至多两次无工具回执修复已验证。
- [ ] P3：周期/预约、later、取消代次、全局排他与预算已实现；补齐无进展停机与聊天目录互斥。
- [ ] P4：桌面宿主与 UI 已实现，浏览器真实闭环通过；原生生产启动/生命周期及恢复入口的最终复测待完成。
- [ ] P5：故障/备份/重放与本机编译后 hub 探针已通过；生产 Electron、性能和其他平台尚未完成验证。

## 已取得的证据

- 2026-11-04：本机系统 Node v24.15.0 和 Electron 43.2.0 内置 Node v24.18.0（darwin arm64）均通过 `node:sqlite`、事务提交、`json_extract` 实际探针。其他平台尚未验证。
- 上游基线固定为 `8f8e2eef3cfaa8f7a418818adc442450fe6bd884`；不运行安装脚本，不使用 `ref-repos/` 作为源码替代。
- 2026-11-05：真实 Pi SDK 的本地 OpenAI SSE fixture 执行读取工具、产生 ask、释放 wrapper、重开同一 JSONL 并完成；无 Goal/交互扩展、无默认模型偏好改写，无付费模型请求。证据：`lib/automation/native-integration.test.mjs`。
- 实际 Hub/worker 验证源事件/claim/回执/回答去重、前后两种丢包窗口、两次回执修复、预算、取消及未知执行占用。Node24-only 的 Hub/API/worker 测试位于 `automation-hub/integration/`，与普通 Node22 测试发现分开。
- `automation-hub/hub.test.mjs` 验证真实 SIGKILL、IPC 父进程消失、取消/result 排序、固定领取策略、原子停用、卡片版本与幂等核实。
- `automation-hub/tests/recovery-extra.test.mjs` 的 6 项验证覆盖完整离线备份/恢复、旧回执 token、投影重建、cron 补跑、时区/DST、重新启用与事件 hops 熔断。测试曾发现新 cron 未初始化到期表，已在配置事务中初始化并回归。
- 本机 Node 24.15 和 Electron 内置 Node 24.18 均真实启动并停止编译后的 hub，校验 19 个运行模块及 SQL/许可证/来源。源码与编译包均通过探针；复制包测试还捕获并修复了 macOS `/var` / `/private/var` 入口判断差异。
- 浏览器实际操作：新规则停用时不能运行 → 启用并手动运行 → ask → 刷新后卡片保留且模型调用未增长 → 回答 → 同一 Pi 会话完成、待决定数归零 → 打开会话与原因时间线。隔离 fixture 恰好两次本地假 provider 请求；用户 30141 服务未被用作测试。
- 浏览器证据保存在本机临时目录 `pi-automation-ui-GqfMyy` 的 `receipt.json` 和截图；fixture 进程、30149 端口与临时 `.next` 已清理。
- 阶段性门禁：Node24 全量测试 467 项通过；移出 Node24-only 测试后，官方 SHA256 校验的 Node22.22 二进制运行普通测试 455 项通过。后续互斥/恢复/无进展补丁完成后仍须重跑最终门禁，不能将这两个阶段性计数当作最终状态。
- 阶段性 TypeScript（应用与 sidecar）均通过；Lint 0 errors，3 条原有 `PdfViewer.tsx` 警告。打包产物目录从源码 lint 中排除，未修改用户的 `outputs/`、`release-ia32/` 内容。
- 新 `.github/workflows/automation.yml` 配置三平台 Node24 检查和真实 Windows ia32 能力降级探针；尚无远端 runner 执行结果。

## 复审后正在补齐

- 普通聊天与自动化在同一规范化目录上的执行占用，覆盖两种先后顺序与未知持有者。
- 通过 `worker.recoveryRun` 立即呈现 claimed 孤儿任务的核实入口；hub 明确记录已核实后，崩溃留下的 checkpoint 可自动清理。服务端与 UI 单独回归通过，正在补真实界面恢复操作。
- 对成功但反复预约的同一结论实施独立的无进展停机，不能只依赖每日轮数上限。
- 生产构建/启动与性能验证使用工作区之外的隔离发布副本，保护用户正在运行的 `.next/`。

## 待完成验证

真实业务闭环、故障/重启恢复、Windows x64/ia32 与 Linux 的运行结论、打包与全部回归均不得仅以源码或模拟测试代替。未取得证据前保持未完成。
