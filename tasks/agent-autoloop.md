# Agent Autoloop 集成执行记录

目标：完成 [集成计划](../docs/agent-autoloop-integration-plan.zh-CN.md) 的首版 P0–P5；P6 是计划明确列出的后续扩展。用户已授权实施。普通聊天和现有桌面资产必须保持可用。

- [ ] P0：本机 Node/SQLite、Pi 无页面执行与扩展隔离已验证；其他目标平台待 runner 验证。
- [x] P1：hub、原生 Pi worker、事件、结果、outbox 与跨会话目录互斥已实现并验证。
- [x] P2：持久卡片、同会话回答接续、至多两次无工具回执修复已验证。
- [x] P3：周期/预约、later、取消代次、全局/目录互斥、有限重试、每日预算与限定无进展停机已验证。
- [ ] P4：桌面宿主与 UI 已实现，浏览器真实闭环、恢复入口及生产服务生命周期通过；原生 Electron 的托盘、通知点击与退出仍待实机验证。
- [ ] P5：故障/备份/重放、本机编译后 hub 探针和服务端性能比较已通过；生产 Electron、Renderer 指标和其他平台仍待验证。

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
- 2026-11-05，运行提交 `3fde111` 的本地门禁：Node24 普通套件 **470/470**；官方 SHA256 校验的 Node22.22 普通套件 **470/470**；独立 Node24 自动化套件 **45/45**。普通测试发现中没有直接导入 hub 的 Node24-only 集成文件。
- 当前 TypeScript（应用与 sidecar）均通过；Lint 0 errors，3 条原有 `PdfViewer.tsx` 警告；相对集成前基线的 `git diff --check` 通过。打包产物目录从源码 lint 中排除，未修改用户的 `outputs/`、`release-ia32/` 内容。
- `.github/workflows/automation.yml` 配置三平台 Node24 检查和真实 Windows ia32 运行时探针。首轮远端 Ubuntu 的普通及自动化套件、Node/Electron hub 启停通过；Windows runner 找到短路径/长路径不一致，已统一 `realpathSync.native` 并为项目 trust 写入/读取/reload 使用同一目录键。实际 ia32 Electron 支持 SQLite，移除了“32 位必定不支持”的错误预设，仍保留运行时能力不足时的降级行为。

## 复审闭环与发布验证

- 普通聊天与自动化在规范化目录上的执行占用已覆盖两种先后顺序、普通 SDK 工具调用、取消清理、真实未知 owner、侧车消失及重启；其他目录保持可用。独立审查通过这些实现闭环，不等同于完整发布验收。
- `worker.recoveryRun` 立即呈现 claimed 孤儿任务的核实入口；hub 明确记录已核实后，崩溃留下的 running/result checkpoint 自动清理。真实浏览器恢复验证：重启 hub → 已核实旧记录自动清理 → 未核实 claimed 记录刷新后仍可确认 → UI 确认取消与清理 → 新一代任务仅一次本地假 provider 请求完成。证据目录 `pi-automation-recovery-ui-LpiRsR`。
- 限定的无进展保护已实现：三个相同的纯 timer 后续结论/预约内容触发原子停用与单张通知；时间戳不参与比较，新事件/回答/变化/代次重置，重放/重启保留计数。5 个专门测试通过。
- 隔离基线和当前版本的生产 Next 构建均通过；当前版本生产服务与编译 hub 验证断开 SSE 后仍完成、保存问题、清理退出、重启恢复同一卡片、回答接续同一 Pi 会话、所有自有子进程退出。真实生命周期还发现并修复了连接 IPC 导致 hub 不能正常退出的问题，新增 POSIX SIGTERM/跨平台 IPC 断开回归。
- 原生 Electron 的 WindowServer/托盘/通知和 renderer 性能验证被 macOS 锁屏阻止，自动解锁失败，已请求用户解锁；不得将生产服务验证当作原生界面验证。服务端基线/关闭/空闲/执行的性能比较独立进行。
- 发布构建与性能验证均使用工作区外隔离副本，未在工作区执行生产 `next build`。
- 服务端 12 轮对比（每场景 3 轮）及生产生命周期方法、数据和限制见 [验证报告](../docs/automation-validation.zh-CN.md)。自动化关闭的服务就绪中位数与基线均为 274ms，Next RSS 为 244.5/237.3MiB；空闲 hub 额外约 76.5MiB。该结果不能替代原生 Renderer/主进程性能验收。
- 聚焦提交：`23ab7b9`（固定内核/宿主）、`3b2bc91`（Pi/桌面生命周期）、`9a740ed`（UI/文档）、`7f7557d`（跨平台包验证/CI）；工作分支 `codex/agent-autoloop-integration`。远端结果与剩余原生验证完成后继续更新本记录。
- 草稿 PR：[#13](https://github.com/happyzengfen/pi-alpha-desk/pull/13)。`0bf6d11` 的 Windows 实际诊断确认：schema/目录校验正常拒绝请求，但 runtime 与 route 的错误类身份不同，导致预期 400 被分类成 503。`5764e1f` 使 route 从 runtime 取得其实际使用的错误类，保留 `instanceof`，不按错误文案兜底；新增真实 Hub 的 stale answer/resolve 409、卡片版本保留和正确版本回答回归，本地 API 5/5、双类型检查通过。运行实现现为 `3fde111`，远端 400/409 与 ia32 包级复测随 [PR checks](https://github.com/happyzengfen/pi-alpha-desk/pull/13/checks) 跟踪。此前 e3 的 Ubuntu/Windows Quality 与 Ubuntu Automation 已通过，后被相同工作流新版替代而取消其余排队任务，不能将整个旧 run 当作全绿。
- `3fde111` 修复配置目录在 CommonJS/ESM 两种运行方式下的解析。真实 Next 16.3 + exact `@next/swc-wasm-nodejs@16.3.0` 已重现旧 `__dirname` 异常；修复后的 native SWC、WASM 与 native TypeScript 三种完整 `loadConfig` 均与旧 native 配置逐项一致，覆盖安全 headers、16 个 externals、版本和 Webpack 行为，且从异 cwd 验证。常规回归不引入 WASM 或联网依赖；[隔离 receipt](/tmp/pi-next-config-wasm.76xD3K/receipt.json)。真实 ia32 包级复测仍待完成。

## 远端打包结果

以下运行使用 `e3e744b`，不等同于本机原生交互验收。

| 平台 | 结果 | 证据 |
| --- | --- | --- |
| Linux x64 | 完整包资源检查、内置 Electron SQLite/Hub 启停、实际 Renderer 加载、AppImage 生成与上传通过 | [job 126731262672](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262672) |
| Linux arm64 | 同上，通过实际 arm64 runner 与包内运行时验证 | [job 126731262677](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262677) |
| macOS arm64 | 包资源、内置 SQLite/Hub、实际 Renderer 加载与 DMG 校验/上传通过 | [job 126731262467](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262467) |
| macOS x64 | 包资源、内置 SQLite/Hub、实际 Renderer、DMG 校验与上传步骤均成功；顶层状态接口暂滞后 | [job 126731262470](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262470) |
| Windows x64 | 所有实际步骤成功：构建、包检查、内置 SQLite/Hub、启动、动态端口、真实 Renderer 和产物上传；顶层状态接口暂滞后 | [job 126729605739](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874351247/job/126729605739) |
| Windows ia32 | 同运行代码的 `0bf6d11` 通过实际 ia32 SQLite/Hub、包结构与包内探针；真实 Renderer 发现 Next WASM 配置加载的 `__dirname` 问题，`3fde111` 已修复并通过本地真实三种 loader，待包级复测 | [job 126733938536](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41875578690/job/126733938536) |

## 待完成验证

真实业务闭环、故障/重启恢复、Windows x64/ia32 与 Linux 的运行结论、打包与全部回归均不得仅以源码或模拟测试代替。未取得证据前保持未完成。
