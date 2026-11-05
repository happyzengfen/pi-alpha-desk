# Agent Autoloop 集成执行记录

目标：完成 [集成计划](../docs/agent-autoloop-integration-plan.zh-CN.md) 的首版 P0–P5；P6 是计划明确列出的后续扩展。用户已授权实施。普通聊天和现有桌面资产必须保持可用。

- [x] P0：本机与目标平台的 Node/SQLite、编译资源、Pi 无页面执行及恢复通过；`57deb42` 的真实 macOS 自动化 CI 已补齐同一运行代码的最终平台验证。
- [x] P1：hub、原生 Pi、事件、outbox 与目录互斥主链路通过；异步启动锁、并发 viewer/repair 模式切换与关闭中拒绝新执行已修复并通过独立复审及最终回归。
- [x] P2：持久卡片、同会话回答、会话变化暂停、认证等待、已开始异常分流与原业务结果核实通过最终真实 SDK/Hub 和浏览器闭环。
- [x] P3：周期/预约、取消排序、持久互斥、十次退避上限、真实一分钟超时、预算与无进展保护通过最终回归。
- [ ] P4：原生默认关闭/启用、关窗后台问答、同窗口恢复、Quit/重开及同会话回答均通过，主题/双语/键盘/最小化/缩放也已实测。`fd71599` 修复快捷键退出重入并通过新版原生复测；托盘恢复和标题栏拖拽经用户手动确认通过。位置对照中两条通知已提交并收到系统 show，通知中心实际显示/点击定位仍待手动核验。
- [x] P5：故障、备份、打包与性能验证通过；六轮原生启动及关闭/空闲/并发聊天采样完成。`fd71599` 本地 Electron 38/38、真实 Cmd+Q 与增量 CI 七个实际作业全部通过，含 ia32 资源/Hub/Renderer；P4 的通知正向验收仍未完成，完整首版不标为已全部验收。

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

除另有注明外，以下打包运行使用 `e3e744b`；ia32 的最终复测使用 `6c3195f`。它们不等同于本机原生交互验收，也不覆盖后续恢复策略修复。

| 平台 | 结果 | 证据 |
| --- | --- | --- |
| Linux x64 | 完整包资源检查、内置 Electron SQLite/Hub 启停、实际 Renderer 加载、AppImage 生成与上传通过 | [job 126731262672](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262672) |
| Linux arm64 | 同上，通过实际 arm64 runner 与包内运行时验证 | [job 126731262677](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262677) |
| macOS arm64 | 包资源、内置 SQLite/Hub、实际 Renderer 加载与 DMG 校验/上传通过 | [job 126731262467](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262467) |
| macOS x64 | 包资源、内置 SQLite/Hub、实际 Renderer、DMG 校验与上传步骤均成功；顶层状态接口暂滞后 | [job 126731262470](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874361357/job/126731262470) |
| Windows x64 | 所有实际步骤成功：构建、包检查、内置 SQLite/Hub、启动、动态端口、真实 Renderer 和产物上传；顶层状态接口暂滞后 | [job 126729605739](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41874351247/job/126729605739) |
| Windows ia32 | `6c3195f` 的实际 ia32 构建、包结构、包内 SQLite/Hub、真实 Renderer 和产物上传全部步骤成功；此前 Next WASM `__dirname` 问题已通过包级复测 | [job 126746189627](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41878977020/job/126746189627) |

## 待完成验证

真实业务闭环、故障/重启恢复、Windows x64/ia32 与 Linux 的运行结论、打包与全部回归均不得仅以源码或模拟测试代替。未取得证据前保持未完成。

## 逐项补审与后续闭环

- `6c3195f` 的 Windows Node24 自动化严格 400/409、Node/Electron SQLite/Hub 及 ia32 包结构、包内 Hub、真实 Renderer 和产物上传步骤已通过：[Windows 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41878977020/job/126746189991)、[ia32 工作区](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41878977020/job/126746189627)。Ubuntu Quality/Automation、Windows Quality 和 macOS Automation 也已有成功步骤证据；这不替代之后恢复修复的验证。
- `990ebef` 新增 8 项真实 Hub/HTTP/SQLite 回归：同 key 预约改期/取消、取消与已到期/已回答入队的四种顺序、重启与新代次隔离、十次退避上限，以及全部物理投影表/SQL 视图/事实与 HTTP 状态重建等价。新增真实一分钟超时回归已观测 SDK 流式请求被中止、等待 settled、释放会话与目录资源且无第二次调用。
- `6c3195f` 的生产 Next/Hub 真实强杀矩阵补齐：领取前、Pi 开始后、回答已确认未领取、排空等待结果响应时崩溃；额外验证真实 SDK `read` 阻塞期间硬杀。重启不盲跑、待核实保留 owner、同会话回答一次接续及 outbox 原样幂等补交均通过；20 个自有进程全部退出，见 [验证报告](../docs/automation-validation.zh-CN.md)。
- 计划 6.3/6.4 补审发现并正在修复的实现缺口：人工修改/删除会话未先暂停关联规则；会话文件损坏可能先被 SDK 重写；已开始后的未分类异常被当作普通 failed 重试；认证前置失败缺持久等待。修复必须保留非破坏校验、受限 fallback、原 owner 与 checkpoint，以及明确的人工恢复路径。
- SDK 真实 reload 会恢复 repair 的 active tools，单纯临时置空不足以证明无工具修复。正在改为 SDK 不可变空 allow-list，并验证真实 reload；普通聊天和普通自动化工具策略分别回归。
- 恢复策略修复的联合定点测试已通过，但独立复审进一步定位三处待封口边界：异步 pre-open 必须完整纳入已登记的单 start Promise，且修复模式不能复用并发 viewer 的读工具许可；executor 验证后的摘要须跨 shutdown/返回边界严格传给 worker，不能盲采随后改动；repair 的失败/未确认停止不能丢失已完成业务结果、误报 SDK 追加为外部改写或提前释放 owner。上述源码正在定点修补，首版保持未验收完成。
- 三处边界现已修复并通过有界独立复审。额外真实 SDK 竞态回归确认：metadata 等待期间旧实例转忙时拒绝模式替换；关闭等待期间拒绝新 round。成功、认证失败和普通失败均携带验证摘要跨 shutdown 交接，外部追加不会被盲采。修复未确认停止保留原业务结果与 owner，人工核实只记账原结论、用量和固定通知，失败不进入普通重试，旧代次与新 owner 隔离。
- 冻结实现的本地最终门禁：Node 24.15 与官方 SHA256 校验的 Node 22.22 普通套件各 **485/485**；fresh sidecar 编译后的 Node24 自动化套件 **103/103**，含真实一分钟超时。应用与 Hub TypeScript 均通过；Lint 无错误，仅 3 条原有 `PdfViewer.tsx` 警告；`git diff --check` 通过。两个过时源码断言按实际启动逻辑更新，真实 SDK 并发/资源回归保留。19 模块的编译包经本机 Node24.15 与 Electron 内置 Node24.18 实际启动 Hub 通过，源码摘要一致。最终提交的生产与平台验证尚待执行，不能将这些门禁记作原生验收完成。
- 最终代码提交 `4f6995f` 的隔离生产构建、五个真实 SIGKILL 窗口及 12 轮新性能采样全部通过，36 个自有 Next/Hub 与两个 harness PID 均退出。自动化关闭相对新采样基线就绪中位数增加 4ms、Next RSS 增加 7.0MiB，SSE p95 同为 36ms；这些均为服务端指标，见[最终验证报告](../docs/automation-validation.zh-CN.md)。
- 主代理通过实际 IAB/CUA 操作最终生产包：问题卡片刷新保留、回答后同会话完成；业务完成但修复中断时先查看原会话，再点击明确的复核按钮，仅补交原结论/用量和固定通知。两条路径共 4 次本地模型请求，没有业务重跑或付费请求，四个自有进程与临时标签页已清理，见[浏览器收据](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-browser-backend-EHGVYz/receipt.json)。
- `4f6995f` 的 [Quality 三平台](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896640865)、[Ubuntu 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807808995)、[Windows 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807809597) 和 [ia32 完整包/实际 Renderer](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807809492) 实际步骤全部成功。最后一次快照中[macOS 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807809586) 仍未分配 runner，不能写作整个 run 全绿。代码验证归属 `4f6995f`，后续仅证据文档的提交不改变运行实现。
- 最终范围复审未发现额外功能缺口；P6 外部来源/Goal 仍为后续。原生桥接、托盘持续执行、通知投递/点击、Quit/重开、标题栏与窗口控制回归及 Main/Renderer 性能保持未完成。不得以浏览器、服务端或 CI Renderer 启动证据替代这组验收。
- 2026-11-05 用户明确“先完成其余验证”。增量复核证实 `4f` 旧 macOS job 最终取消且没有执行，不能记为通过；文档提交 `57deb42` 自动触发的 [Quality](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390861) 和 [Automation](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390849) 两个 run、七个 job 的实际步骤全部成功，macOS/Ubuntu 自动化各 166/166，Windows 165 通过加 1 项预期跳过，ia32 完整包、包内探针和真实 Renderer 通过。`4f..57` 仅两个 Markdown 文件变化，运行代码相同，已补齐此前 macOS gate。详见[收据](/tmp/pi-alpha-final-ci-57deb42f.json)及[验证报告](../docs/automation-validation.zh-CN.md)。
- 增量范围复核未发现其他非原生验证缺项，非原生部分已验收；没有重跑已通过的本地/生产/浏览器实验，没有更改运行代码、合并或发布。本轮未尝试本机桌面，原生整组依用户要求后置，完整首版仍未标为全部完成。
- 完整目标恢复 active 后，原生库存一度可用，主代理实测 `4f` 隔离应用的默认关闭、真实桥接启用、关窗隐藏及后台持久 ask。激活已有隐藏窗口未恢复的问题被定位到 main 的 null-only 分支，独立范围复审确认属于 P4；`0df5739` 最小补齐 restore/show/focus，不启动新窗口/服务/owner。三个实际 VM 回归先红后绿，本地 Node22/24 各 488/488、Electron 37/37，[Quality](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41939682950) 与 [Automation](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41939682786) 全部七个 job 实际成功，见[收据](/tmp/pi-alpha-final-ci-0df5739f.json)。
- 旧通知尝试 OS 返回 UNError1，没有 shown/click，且 fixture 存在 bundle 未完成签名和启动时主动 isSupported 的观测副作用；旧尝试保留而不算通知通过。新建私有资源全部物化、无早期主动探测的独立包，完整 Electron 来源为 `0df`、Next 复用未变 `4f` BuildID；仅私有副本正常签名后严格 deep/strict 验证实际通过，外部源哈希不变。不是正式 DMG/notarization 证明。
- 新签名包启动前 Mac 再次锁屏，CUA 阻止启动，状态 events/prefs/descriptor 均空、Provider 0。已发送就绪后的解锁请求，继续等待；不借 VM/签名/旧 native 局部结果认定恢复、托盘/通知/退出或原生性能通过。详细方法、版本和限制见[验证报告](../docs/automation-validation.zh-CN.md)。

## 解锁后的原生验收与退出增量

- 用户确认解锁后，主代理实际启动上述严格签名的 `0df5739` 隔离包，完成默认关闭、UI 启用、真实 Pi 请求、关窗隐藏后保存 ask、Finder 正常打开恢复同一窗口、实际应用菜单 Quit、重开恢复同卡，以及在原生 UI 选择蓝色后沿用原会话完成。仅两次本地 Provider 请求，没有重复资料核对；卡片完成，owner/checkpoint 清空。
- 两次已启用状态 Quit 各约 258ms；全部自有 Main/Next/Hub 和测试 Provider 均已退出，descriptor 删除。浅色英文、深色中文、Tab/Return、最小化/Finder 恢复及原生缩放均有实际操作收据。见[原生生命周期汇总](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-native-lifecycle-signed-K7xAyK/native-lifecycle-final-receipt.json)。
- 新签名包的三条系统通知仍被 OS 拒绝，没有 show/click；签名完整性通过不等于系统授予通知权限，拒绝的具体原因未定。原生收件箱 fallback 已通过，但不能替代通知正向验收。工具当时未能操作托盘或验证拖拽，两者的后续用户手动结果见下节。
- 基线 `d588f0e` 与集成包各三个全新配置的原生启动、普通聊天及自动化空闲/并发场景完成。帧间隔 p95 为 17.4–17.6ms，所采集流式区间没有超过 50ms 的帧间隔或 long task；实际界面持续增长且侧边栏可操作。RSS、采样窗口与限制见[原生性能汇总](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-native-perf-873lc9x8/native-performance-summary.json)，不把小样本解释为普遍性能保证。
- 性能期间发现 `0df5739` 在默认关闭时 Cmd+Q 关闭窗口但保留 Main。`fd71599` 将宿主停止后的第二次 Quit 延到下一事件循环，避免 Electron 原生回调微任务重入；保留原有 2500ms 有界停止。旧源码的定点回归实际失败，修复后定点 10/10、Electron 38/38、Lint/diff 通过，独立复审无阻断项。
- 在仅更新 Electron 文件、保留原 Next Build ID 的新私有配置中，主代理再次实际 Cmd+Q：默认关闭 136ms、启用后 149ms，Main、Renderer、Next 和 Hub 均退出。见[增量原生退出收据](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-native-perf-873lc9x8/incremental-native-quit-fd71599.json)。原性能数据仍归属 `0df5739`，不重写成新版本完整性能复测。
- `fd71599` 的 [Quality](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41953447027) 与 [Automation](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41953447033) 七个 job 实际全部成功。普通三平台各 489 项、488 通过及 1 项条件跳过；Node24 自动化 Mac/Linux 各 166/166，Windows 165 通过及 1 项 POSIX 跳过；三平台实际 Node/Electron Hub 探针及 ia32 包资源/Renderer 通过，见[完整收据](/tmp/pi-alpha-final-ci-fd71599.json)。最终全部 51 个记录的应用 PID、Provider 和测试端口均清理；未合并或发布。

## 用户手动验收补充（2026-11-05）

- 对隔离 `Pi Perf current.app` 的“拖动标题栏 → 关闭窗口 → 托盘 Show 恢复”验证，用户回复“成功，跳过这个”。据此将标题栏拖动和托盘恢复记录为**用户确认的手动通过**，按用户要求跳过重复验证；代理此前的 CUA 尝试仍按原记录保留。
- 对可正常接收通知的签名构建或另一测试环境，用户回复“暂时没有”。通知显示与点击定位继续待验。P4 和完整首版仍未全部完成；运行代码未变。

## 通知客户端诊断与位置对照（2026-11-05）

- 精确限定自有进程和时间的公开日志确认：原临时目录包两次在授权回调中报错，`usernoted` 同时报客户端查找或验证失败。该包已有正确系统登记和匹配 CDHash，不能据此认定缺登记或某种签名是唯一原因。
- 保持签名、Bundle ID、私有数据和原始 JS closure 不变，将完整包以 APFS clone 放入唯一的用户应用目录。严格 deep/strict 校验仍通过；临时只登记该应用目录副本，原包保留为不可变代码依赖。实际原生“立即运行”产生新 ask，只有一次本地假模型请求、无 owner 或付费调用。
- 新包的两次通知提交均无错误，并收到两个系统 show；系统日志记录了成功识别客户端、投递通知和 `displayShared` 展示抑制。这是位置与登记状态对照，不能单独归因于临时目录标记。通知代码与当前 `fd71599` 字节一致，完整来源与观察边界见[验证报告](../docs/automation-validation.zh-CN.md)。
- CUA 对真实权限提示执行“允许”后，窗口已关闭；后续限定 Main PID 的公开日志确认 `didGrant:1 / hasError:0`，通知授权已成功。工具不支持 Fn 键，正常打开通知中心后读取仍超时。已请求用户点击测试通知，核对是否定位到“通知位置对照：确认结果”卡片；目前没有真实点击/定位证据。
- 当前为明确的待手动交接状态：测试副本及私有 Provider/Next/Hub 暂留供这一点击使用，打开卡片即可，无需回答；无运行 owner、自动周期任务或持续模型调用，已用一次、最多两次本地请求。原登记恢复及独立 Provider 清理仍由主代理负责，不能将应用 Quit 当作全部清理完成。见[当前尝试状态](/tmp/pi-notification-location-ab-K7xAyK/current-attempt-state.json)。
