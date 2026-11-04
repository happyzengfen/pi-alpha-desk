# Agent Autoloop 集成执行记录

目标：完成 [集成计划](../docs/agent-autoloop-integration-plan.zh-CN.md) 的首版 P0–P5；P6 是计划明确列出的后续扩展。用户已授权实施。普通聊天和现有桌面资产必须保持可用。

- [ ] P0：本机 Node/SQLite、Pi 无页面执行与扩展隔离已验证；其他目标平台待 runner 验证。
- [x] P1：hub、原生 Pi worker、事件、结果、outbox 与跨会话目录互斥已实现并验证。
- [x] P2：持久卡片、同会话回答接续、至多两次无工具回执修复已验证。
- [x] P3：周期/预约、later、取消代次、全局/目录互斥、有限重试、每日预算与限定无进展停机已验证。
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
- 2026-11-05 本地当前门禁：Node24 普通套件 **467/467**；官方 SHA256 校验的 Node22.22 普通套件 **467/467**；独立 Node24 自动化套件 **43/43**。普通测试发现中没有直接导入 hub 的 Node24-only 集成文件。
- 当前 TypeScript（应用与 sidecar）均通过；Lint 0 errors，3 条原有 `PdfViewer.tsx` 警告；相对集成前基线的 `git diff --check` 通过。打包产物目录从源码 lint 中排除，未修改用户的 `outputs/`、`release-ia32/` 内容。
- 新 `.github/workflows/automation.yml` 配置三平台 Node24 检查和真实 Windows ia32 能力降级探针；尚无远端 runner 执行结果。

## 复审闭环与发布验证

- 普通聊天与自动化在规范化目录上的执行占用已覆盖两种先后顺序、普通 SDK 工具调用、取消清理、真实未知 owner、侧车消失及重启；其他目录保持可用。独立审查通过这些实现闭环，不等同于完整发布验收。
- `worker.recoveryRun` 立即呈现 claimed 孤儿任务的核实入口；hub 明确记录已核实后，崩溃留下的 running/result checkpoint 自动清理。真实浏览器恢复验证：重启 hub → 已核实旧记录自动清理 → 未核实 claimed 记录刷新后仍可确认 → UI 确认取消与清理 → 新一代任务仅一次本地假 provider 请求完成。证据目录 `pi-automation-recovery-ui-LpiRsR`。
- 限定的无进展保护已实现：三个相同的纯 timer 后续结论/预约内容触发原子停用与单张通知；时间戳不参与比较，新事件/回答/变化/代次重置，重放/重启保留计数。5 个专门测试通过。
- 隔离基线和当前版本的生产 Next 构建均通过；当前版本生产服务与编译 hub 验证断开 SSE 后仍完成、保存问题、清理退出、重启恢复同一卡片、回答接续同一 Pi 会话、所有自有子进程退出。真实生命周期还发现并修复了连接 IPC 导致 hub 不能正常退出的问题，新增 POSIX SIGTERM/跨平台 IPC 断开回归。
- 原生 Electron 的 WindowServer/托盘/通知和 renderer 性能验证被 macOS 锁屏阻止，自动解锁失败，已请求用户解锁；不得将生产服务验证当作原生界面验证。服务端基线/关闭/空闲/执行的性能比较独立进行。
- 发布构建与性能验证均使用工作区外隔离副本，未在工作区执行生产 `next build`。
- 聚焦提交：`23ab7b9`（固定内核/宿主）、`3b2bc91`（Pi/桌面生命周期）、`9a740ed`（UI/文档）、`7f7557d`（跨平台包验证/CI）；工作分支 `codex/agent-autoloop-integration`。远端结果与剩余原生验证完成后继续更新本记录。

## 待完成验证

真实业务闭环、故障/重启恢复、Windows x64/ia32 与 Linux 的运行结论、打包与全部回归均不得仅以源码或模拟测试代替。未取得证据前保持未完成。
