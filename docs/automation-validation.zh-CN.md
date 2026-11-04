# 自动化集成：本地生产验证记录

> 日期：2026-11-05  
> 结果：非原生验收完成，包括三平台 CI、ia32 实际包、五个强杀窗口、12 轮服务端性能及两条浏览器闭环。原生桌面验收按用户要求后置。

## 版本与环境

- 基线：[d588f0e8a01c3d13c6b6df502918b2165b4b6cad](https://github.com/happyzengfen/pi-alpha-desk/commit/d588f0e8a01c3d13c6b6df502918b2165b4b6cad)。
- 测试实现对照：[7f7557df0419e045d32d3214ebebe9027f4c3e0d](https://github.com/happyzengfen/pi-alpha-desk/commit/7f7557df0419e045d32d3214ebebe9027f4c3e0d)。生产拷贝在提交前制作，运行逻辑与该提交一致；生命周期复测前已刷新包含 IPC 退出修复的 Hub 编译产物。
- 后续提交，包括 `890f755` 的类型修正、`db7b21a` 的测试超时调整及 `e3e744b` 的路径相关改动，未重复本轮生产构建、生命周期或性能验证。其独立测试结果见[实施记录](../tasks/agent-autoloop.md)，不归入本报告的数据。
- 本机：Apple M4 / Mac16,10，10 核，16 GiB，arm64，macOS 26.5.2（25F84）。
- 服务运行时：Node v24.15.0、Next.js 16.3.0。Electron 43.2.0 仅尝试启动，未取得原生窗口验证结果。
- 生产 Build ID：基线 `iVpcT1mb2Bjz6c38CF7Lt`；当前实现 `ZY4kvBAAT4YeiLTVN1psa`。

## 方法与范围

基线和当前实现分别在本地临时目录构建生产 `.next`，通过 `node_modules` 链接复用现有依赖安装。当前实现的 `npm run build` 成功，保留已有 session export 动态依赖警告。用户工作区 `.next` 和开发服务 30141 未参与验证。

每轮使用新的私有 Agent 配置、项目目录、用户数据目录及动态 loopback 端口，设置 `PI_OFFLINE=1`。模型请求全部进入本机模拟 OpenAI Provider，走真实 Pi SDK 与 SSE 链路；未调用付费模型。模拟文本按约 32ms 间隔分片输出。

最终采样在其他本地构建、测试停止后顺序执行：基线、自动化关闭、已配置规则但空闲、自动化执行，各 3 次。服务就绪指 `/api/home` 返回 2xx；HTML 完成指实际主页 HTTP 响应读取完毕。RSS 由 `ps` 在普通聊天开始前读取；首文本与分片间隔由真实聊天 SSE 采集。执行场景中，自动化与聊天使用不同的已授权项目目录，原始 Provider 时间记录确认两者重叠运行。

这是服务端测量。**HTML 响应完成不能替代 BrowserWindow 加载、React 渲染或 Renderer 响应性验证。** 操作系统文件缓存已预热，样本量较小；RSS 含共享映射页，不能直接相加视为实际物理内存总量。

## 性能结果

以下均为每组 3 次的中位数；内存单位为 MiB。

| 场景 | 服务就绪 ms | HTML 完成 ms | Next RSS | Hub RSS | SSE 首文本 ms | SSE 分片间隔 p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 基线 | 274 | 281 | 237.3 | — | 41 | 35 |
| 当前实现，自动化关闭 | 274 | 281 | 244.5 | — | 41 | 36 |
| 当前实现，自动化空闲 | 276 | 283 | 266.8 | 76.5 | 38 | 36 |
| 当前实现，自动化执行 | 274 | 281 | 273.4 | 77.2 | 8 | 35 |

各组最大 SSE 分片间隔为 50–51ms。关闭自动化时，服务就绪及首文本中位数与基线相同，Next RSS 中位数增加约 7.3 MiB；开启后需计入独立 Hub 进程。执行场景的 8ms 首文本包含运行时预热影响，不能解释为自动化使聊天加速。这组固定本机负载未观察到服务端 SSE 节奏明显退化，结论不覆盖真实远端 Provider、长会话或原生 Renderer。

## 生产生命周期结果

在当前实现的生产 Next 与编译后 Hub 上完成以下路径：

1. 未启动 Hub 时，API 显示 `automation-disabled`；启动后 worker 与 Hub 连接成功，本次耗时 88ms。
2. 触发任务后断开客户端 SSE，服务端继续执行并持久保存问题卡片；当前轮次结束，worker 不再持有活动模型调用。
3. worker 排空返回 `stopped: true`，随后停止 Next 与 Hub。Next 的预期 SIGTERM 退出码为 143，Hub 退出码为 0，无遗留的自有进程。
4. 重启后恢复同一卡片（id 1、version 1）；回答后沿同一 Pi 会话完成第二轮，两轮均为 `done`，待处理卡片清空。
5. 最终再次排空、停止，Next 与 Hub 自有进程均已退出。12 轮性能采样也逐轮检查了进程清理。

验证过程中发现连接 IPC 的 Hub 在 SIGTERM 后仍保持进程存活；应用 IPC 断开修复后，以上生产生命周期复测通过。这里验证的是服务进程的排空与停止，不能替代 Electron 菜单 Quit 的端到端验证。

## 5764e1f：API 错误身份定点生产复测

2026-11-05，将 [5764e1fd31662c20a7eceaa6e2d560e77c3fa39d](https://github.com/happyzengfen/pi-alpha-desk/commit/5764e1fd31662c20a7eceaa6e2d560e77c3fa39d) 的 `lib/automation/runtime.ts` 与 `app/api/automations/route.ts` 同步到原隔离副本，重新运行 `npm run build`，构建成功，Build ID 为 `XeL3jTWFeLtOSfSvVcjhR`；仅保留已有 export 动态依赖警告。

使用全新私有 Agent 目录和随机 loopback 端口启动该生产 Next，未启动 Hub。`save_config` 的无效 timeout 返回 **400 / Invalid timeout**；未选择的 cwd 返回 **400 / Automation directory is outside the selected workspaces**。本机 Provider 哨兵请求数为 **0**。验证后 Next 按预期 SIGTERM 退出（143），无遗留自有进程。

此次仅覆盖上述生产错误路径，未重跑性能、桌面生命周期或其他套件，不改变前述 12 轮数据的版本归属。旧性能构建的 `.next` 与 `dist` 已保留在本地证据目录的 `perf-build-7f7557d/`。

## 3fde111：Next 配置兼容修复定点生产复测

2026-11-05，仅将 [3fde1116f7f4c053ce4439a8abe85fc7a1f94baa](https://github.com/happyzengfen/pi-alpha-desk/commit/3fde1116f7f4c053ce4439a8abe85fc7a1f94baa) 的 `next.config.ts` 同步到上述已含 `5764e1f` API 修复的隔离副本，再次完成生产构建，Build ID 为 `qzNEqnnMwkARvQ0XZpNQd`。新私有 Agent 目录下的两个错误路径仍均返回 **400**，Provider 哨兵请求数为 **0**，未启动 Hub；Next 以预期 SIGTERM 退出（143），无遗留自有进程。未重跑性能、生命周期或全套测试，工作区 `.next` 未参与。

另一个验证代理提供的 [Next 配置加载矩阵记录](/tmp/pi-next-config-wasm.76xD3K/receipt.json) 使用 Next 16.3.0 与同版本 Wasm，在不同 cwd 下调用真实生产 `loadConfig`：原配置的 Wasm 路径因 `__dirname` 不存在而失败；修复后的 native SWC、Wasm 和原生 TypeScript 路径均通过，返回的 headers、externals、env 与 webpack 行为均与原 native 配置深相等。此记录证明配置加载兼容性，不代表 Windows 或其他平台上的生产运行验证。

## 6c3195f：真实 Pi SDK 硬杀故障矩阵

2026-11-05，从 [6c3195f1ff7f18af4286aff4de003b0d1a3d8991](https://github.com/happyzengfen/pi-alpha-desk/commit/6c3195f1ff7f18af4286aff4de003b0d1a3d8991) 的全新 `git archive` 在工作区外构建生产包，Build ID 为 `jkyrLBFL8WMdOr7aNGGkM`；仅链接现有依赖安装，未改源码或工作区 `.next`。实验运行真实 Pi SDK、生产 Next 和编译后 Hub，Provider 全部为本机 HTTP fixture。通过持久状态、API ack、实际请求或响应屏障确定窗口，再发送 **SIGKILL**；未用定时等待推测崩溃时机，也未替换 SDK 执行器。

| 硬杀窗口 | 重启后的实际结果 | Provider 请求总数 |
| --- | --- | ---: |
| worker 已暂停，触发事件已持久为 `queued`，尚未领取；杀 Next 与 Hub | 原事件仅执行一次，结果为 `done`，checkpoint 清空 | 1 |
| Pi 请求已到达 Provider，`running` checkpoint 已保存；杀 Next | worker 显示 `execution-needs-review`，保留 owner，连续三个心跳不再请求模型；确认旧 PID 已死后才人工 reconcile | 1 |
| 卡片回答 API 已返回 200，接续轮次已 `queued`，worker 仍暂停；杀 Next 与 Hub | 回答仅接续一次，两轮使用同一 Pi session，问题卡片清空 | 2（提问、接续各一次） |
| Hub 已接受结果，但代理扣住 200 响应；确认 `suspended=true` 且 `activeRun=1` 后杀 Next 与 Hub | 重启只补交持久 outbox；原结果 body hash 相同，Hub 返回 `duplicate:true`，问题卡片 id/version 不变 | 1 |
| 真实 `read` 工具已发出执行开始事件，在无 writer 的私有 FIFO 上阻塞，三个心跳后仍未结束；杀 Next | 旧 PID 已退出，FIFO 非阻塞 writer 打开返回 `ENXIO`；重启保持待核实，核实后 reconcile，未重做读取或请求模型 | 1 |

待核实实验中，Hub 的 run 仍为 `claimed`，待核实标志来自 worker 的持久 `running` checkpoint；未等待五分钟租约转换，不能写成已实测 Hub 的 `unknown` 超时。读取实验使用内建工具，没有子进程，只证明硬杀时的进程与 FIFO 清理，不证明协作取消或任意工具的子进程清理。首次带 writer 的 FIFO 尝试因 SDK MIME sniff 返回 `ESPIPE`，未命中阻塞窗口，原始失败记录保留；上表读取结果来自后续独立的无 writer 实验。

四项必测窗口和额外读取窗口均通过。包括首次 fixture 尝试在内的 20 个自有 Next/Hub PID 均已退出，付费模型调用为 0。此结论仅归属 `6c3195f`，不覆盖随后修改的 worker/session 恢复路径，也不重归属前述性能数据。

## 4f6995f：冻结源码最终生产复核

2026-11-05，从 [4f6995f3bba8a5494daddcc3cabcdf457513a933](https://github.com/happyzengfen/pi-alpha-desk/commit/4f6995f3bba8a5494daddcc3cabcdf457513a933) 的全新 `git archive` 制作隔离副本并完成 `npm run build`，Build ID 为 `x06Cvi8lO9QZHdBnrTP5L`，仅有原 session export 动态依赖警告。仍使用本机 Node 24.15.0、Next 16.3.0、真实 Pi SDK 和私有 loopback Provider，未替换执行器。工作区 `.next`、用户 30141 服务及真实 Agent 数据均未参与。

五个 SIGKILL 窗口全部通过，屏障及 ack、owner、checkpoint、会话与 digest 证据保存在原始 receipt：

| 窗口 | 最终源码上的恢复结果 |
| --- | --- |
| `queued` 尚未领取时杀 Next/Hub | 重启仅调用 Provider 一次，原 run 完成，checkpoint 清空 |
| 真实 Pi 请求已开始后杀 Next | 重启保持 owner 与待核实状态；三个心跳内请求数保持 1，核实后显式触发新代次才增加至 2 |
| 回答 API 已 ack、接续 run 尚未领取时杀 Next/Hub | 只接续一次，同一 Pi session 完成两轮，Provider 共 2 次，问题卡片清空 |
| Hub 已 commit 结果、代理扣住响应，且 drain 为 `suspended=true` / `activeRun=1` 时硬杀 | 重启仅补交原 outbox；body hash 一致，Hub 返回 `duplicate:true`，卡片 id/version 不变，Provider 保持 1 次 |
| 真实 `read` 在无 writer 的私有 FIFO 上阻塞时杀 Next | 旧 PID 退出且 FIFO 返回 `ENXIO`；重启保留待核实，三个心跳无新增请求，核实后显式新代次才增加至 2 |

两项待核实实验都先实际读取原 JSONL，核对 session header/id/cwd、managed 标记和已完成消息/工具步骤，检查 binding 无暂停墓碑并确认旧 PID 已死，再提交 `confirmedStopped:true` 与 `confirmedSessionReviewed:true`。ack 前后 JSONL hash 不变，binding 只采纳此次已复核的 SDK 追加字节；随后 generation 2 的显式新任务成功。这里的第二次请求属于人工新任务，不属于自动重跑。待核实 run 在这些窗口仍为 `claimed`，本轮也未等待五分钟 `unknown` 转换。

在停止其他本地构建和测试后，另完成 **12 次新采样**：基线、关闭、空闲和执行各 3 次。基线复用 `d588f0e` 的不可变生产包（Build ID `iVpcT1mb2Bjz6c38CF7Lt`），重新启动私有进程采样；当前实现均来自上述 `4f6995f` 构建。硬件、分片节奏、就绪/HTML/RSS/SSE 定义与前述方法相同，三次执行场景均有真实 Provider 时间记录确认与不同 cwd 的普通聊天重叠。

| 场景 | 服务就绪 ms | HTML 完成 ms | Next RSS MiB | Hub RSS MiB | SSE 首文本 ms | SSE 分片间隔 p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 本轮基线 `d588f0e` | 274 | 281 | 236.9 | — | 41 | 36 |
| `4f6995f`，自动化关闭 | 278 | 286 | 243.9 | — | 42 | 36 |
| `4f6995f`，自动化空闲 | 276 | 283 | 268.4 | 77.0 | 40 | 36 |
| `4f6995f`，自动化执行 | 276 | 283 | 274.1 | 77.9 | 8 | 35 |

表中为各组三次的中位数；各组最大 SSE 分片间隔为 47–52ms。关闭场景相对本轮基线的服务就绪中位数增加 4ms，Next RSS 增加 7.0 MiB。执行场景 8ms 首文本仍包含预热影响，不能视为加速结论。样本量、缓存与 RSS 共享映射限制仍适用；服务端结果不能替代 Renderer 或原生 Electron 验证。

五个故障实验和 12 轮性能采样的 **36 个自有 Next/Hub PID**，以及两个 harness PID，均再次检查已退出，`remainingOwned=[]`，付费模型调用为 0。该服务端实验阶段 IAB 检查返回不可用，未进行原生/UI 操作；后续主代理浏览器复验单独记录如下。以上结果只归属 `4f6995f`，早期版本与性能表保持原归属。

## 4f6995f：最终浏览器操作与恢复复验

主代理随后成功创建隔离 IAB 页面，使用同一 `4f6995f` 生产包及 Build ID，新建私有 Agent/Hub/项目与动态 loopback 端口。子代理只准备后端 fixture 和只读核验；下列点击、刷新和查看会话均由主代理通过 CUA 执行，没有以 API 调用代替界面动作。

1. 打开自动化待决定卡片 #1，刷新页面后重新打开仍为同一卡片；点击“蓝色 推荐”，待决定归零。执行记录显示两轮完成；后端核验两轮使用同一 Pi session，恰好两次本地 Provider 请求，owner 与 checkpoint 均清空。
2. 真实业务完成后，损坏回执触发无工具修复；第二次 HTTP 请求已到达 Provider、`running` checkpoint 已保存原业务结果时，硬杀 Next。确认旧 PID 已退出后重启，界面呈现待核实。点击“查看会话”，实际核对原业务结论、损坏回执与仅修复格式的后续消息，再点击“已核实停止并复核会话”。原 run 记为 `done`，原 summary/session 与输入 100、输出 30 的用量保留，待核实、执行中和排队数均为零；只生成固定回执复核通知，不执行损坏回执的后续工作。

第二条路径的绑定摘要在崩溃前后确有变化；此次界面复核持久记录 `reviewedRun=3` 并采纳已检查的 SDK 追加摘要。`desktopReconcile` 事实保留原结果及用量，owner/checkpoint 清空。该路径仅有原业务与修复两次请求，核实未新增模型调用；两条路径合计 4 次本地请求，付费调用为 0。

三张 CUA 原始截图及 SHA256、实际 API/事实、旧 PID 的 SIGKILL/ESRCH 和摘要证据收录在[最终浏览器收据](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-browser-backend-EHGVYz/receipt.json)。自有 harness、Hub、旧/新 Next 四个 PID 均已退出，`remainingOwned=[]`，Provider 已关闭，主代理临时标签页已关闭。此结果不替代原生 BrowserWindow、托盘、通知或 Quit 验收。

## 4f6995f：远端最终代码检查

以下结论只归属代码提交 `4f6995f`。随后仅记录证据的文档提交不改变该代码版本。

- [Quality](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896640865) 三平台实际步骤全部成功。各平台 Node22.22 共 485 项，484 通过、1 项预期跳过；TypeScript、Lint 与差异检查通过，Lint 仅有 3 条原有 PDF 警告。
- [Ubuntu 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807808995) 实际 166/166 通过；[Windows 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807809597) 共 166 项，165 通过、1 项 POSIX 专用检查按设计跳过。严格 400/409、显式会话复核与新增 RPC 竞态均通过，Node24 与 Electron 内置运行时实际 SQLite/Hub 启动通过。
- [Windows ia32](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807809492) 完整 unpacked 构建、包结构、包内 Electron24.18 SQLite/Hub 与实际 Renderer 加载、证据上传全部成功，`renderer-interactive` 为 7793.24ms；该启动指标不替代原生交互或性能对比。
- [macOS 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41896641320/job/126807809586) 在原快照（2026-11-04 19:38:56 UTC）为 `queued`、runner 未分配、steps 为空；后续复核其最终为 `cancelled`，仍无执行步骤，日志返回 404。该旧 job 没有执行，不能记为通过或将整个旧 Automation run 记为全绿。下面 `57deb42` 的真实 macOS 运行补齐同一运行代码的验证；未手动重跑或取消旧 job。

各 job 直链、测试计数、运行时探针与实际完成步骤保存在[最终 CI 收据](/tmp/pi-alpha-final-ci-4f6995f3.json)。未重跑、取消、合并或发布。

## 57deb42：非原生验收收口

2026-11-05，复核文档提交 `57deb42fc99c8f614b5853ad65d18daede95e75a` 自动触发的 [Quality](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390861) 与 [Automation](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390849)：两个 run、七个 job 的实际步骤均已完成并成功，包含完整日志与 `Complete job`。`git diff --name-only 4f6995f..57deb42` 仅为本报告和执行记录两个 Markdown 文件，运行代码未变；此前生产、浏览器与本地回归的证据继续有效。

| 检查 | 实际结果 |
| --- | --- |
| Quality：Ubuntu、macOS、Windows | 各 Node22.22.0，485 项中 484 通过、1 项 Node24 专用检查预期跳过；TypeScript、Lint、差异检查通过，Lint 仅 3 条原有 PDF 警告 |
| [Ubuntu 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390849/job/126817436324) | Node24.22.2，166/166 通过；严格 400/409、显式会话复核与 RPC 竞态通过；Node24 与 Electron24.18 的 linux x64 SQLite/Hub 实际启停通过 |
| [macOS 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390849/job/126817436493) | Node24.22.1，166/166 通过；相同 API/恢复/竞态检查通过；Node24 与 Electron24.18 的 darwin arm64 SQLite/Hub 实际启停通过 |
| [Windows 自动化](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390849/job/126817436340) | Node24.22.2，166 项中 165 通过、1 项 POSIX 检查预期跳过；相同 API/恢复/竞态检查及 win32 x64 运行时探针通过 |
| [Windows ia32 完整包](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/41899390849/job/126817436113) | unpacked 构建、包资源检查、两轮 Electron24.18 ia32 SQLite/Hub 探针及实际 Renderer 均通过；可交互时间 7627.91ms，启动证据 artifact `13357733069` 上传成功 |

[完整收据](/tmp/pi-alpha-final-ci-57deb42f.json) 保留精确提交、各 job 直链、计数、跳过原因、探针 JSON 和 Renderer 指标。未通过版本推测平台能力，也没有将旧 `4f` 未执行的 macOS job 改写为成功。此后仅更新证据文档，不改变已验证的运行代码，无需重复生产故障、性能或浏览器实验。

范围复核确认：P0–P5 中可独立进行的非原生验证均已完成，P6 仍属后续。用户已明确“先完成其余验证”，本轮没有尝试本机原生桌面，也未再次请求解锁；完整首版仍保留下面的原生验收项。

## 原生桌面验证限制

已准备临时 Electron.app、打包资源布局和独立 userData，并尝试加载真实主页。CUA 返回“Mac is locked and automatic unlock could not unlock it”；该尝试未产生主进程校验日志或 BrowserWindow 加载记录，真实 HTTP 文档等待超时后已清理测试进程。

因此，本次仍未验证：原生桥接的默认关闭与启用、托盘隐藏后执行、Electron Quit 清理、系统通知投递及点击聚焦，以及主进程/Renderer RSS、帧间隔和界面流式响应性。需在 Mac 解锁后补做；这次本机原生尝试不提供 Windows、ia32 或 Linux 的原生交互结论。

最终服务端性能验证后，主代理再次调用原生应用库存，仍返回 `apps=[]` 和 Mac 锁屏错误，见[最新原生阻塞收据](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/native-blocker-latest.json)。后续浏览器复验仅证明 IAB 界面闭环；上述原生交互、标题栏/窗口控制回归与 Main/Renderer 性能仍保持未验收。前文远端平台段落提供独立的包级结论，不改变本段原生范围。

## 原始本地证据

以下文件保存在本次隔离临时目录，未进入发布包；临时目录被清理后需重新准备验证环境。

- [环境、版本、测量方法及汇总 JSON](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/production-verification-summary.json)
- [12 轮原始采样、Provider 时间与退出记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/server-matrix-results.json)
- [生产生命周期、卡片恢复及同会话接续记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/server-lifecycle-results.json)
- [原生启动阻塞记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/native-blocker.json)
- [本次临时服务端校验脚本](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/server-proof.mjs)
- [5764e1f 定点生产 API 复测记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-5764e1f-receipt.json)、[对应生产构建日志](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-5764e1f-build.log)
- [3fde111 定点生产 API 复测记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-3fde111-receipt.json)、[对应生产构建日志](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-3fde111-build.log)
- [6c3195f 硬杀矩阵汇总及全部 PID 退出证据](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-crash-production-vwzfzhuz/production-crash-summary.json)、[生产构建日志](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-crash-production-vwzfzhuz/production-build.log)
- [四项必测结果及首次 FIFO 尝试的原始记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-crash-production-vwzfzhuz/crash-matrix-receipt.json)、[独立真实 read 阻塞硬杀记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-crash-production-vwzfzhuz/read-tool-receipt.json)
- [临时硬杀校验脚本](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-crash-production-vwzfzhuz/crash-proof.mjs)、[独立 read 校验脚本](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-crash-production-vwzfzhuz/read-tool-proof.mjs)；每个场景子目录保留 Next/Hub、代理和 Provider 日志。
- [4f6995f 最终版本、硬件、性能及全部 PID 汇总](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/production-verification-summary.json)、[对应隔离生产构建日志](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/production-build.log)
- [4f6995f 五个真实硬杀窗口、JSONL 复核与双确认 ack](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/crash-matrix-receipt.json)、[12 轮原始性能及 Provider 重叠记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/server-matrix-results.json)
- [最终硬杀 harness](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/crash-proof.mjs)、[最终服务端性能 harness](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/server-proof.mjs)、[IAB/原生阻塞状态](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-final-production-dnbnpyya/browser-blocker.json)；各场景目录保留独立进程、代理与 Provider 日志。
