# 自动化集成：本地生产验证记录

> 日期：2026-11-05  
> 结果：隔离生产构建、服务端生命周期及 12 轮服务端性能采样通过；原生桌面验证受锁屏阻止。

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

## 原生桌面验证限制

已准备临时 Electron.app、打包资源布局和独立 userData，并尝试加载真实主页。CUA 返回“Mac is locked and automatic unlock could not unlock it”；该尝试未产生主进程校验日志或 BrowserWindow 加载记录，真实 HTTP 文档等待超时后已清理测试进程。

因此，本次仍未验证：原生桥接的默认关闭与启用、托盘隐藏后执行、Electron Quit 清理、系统通知投递及点击聚焦，以及主进程/Renderer RSS、帧间隔和界面流式响应性。需在 Mac 解锁后补做；本记录也不提供 Windows、ia32 或 Linux 的实际平台结论。

## 原始本地证据

以下文件保存在本次隔离临时目录，未进入发布包；临时目录被清理后需重新准备验证环境。

- [环境、版本、测量方法及汇总 JSON](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/production-verification-summary.json)
- [12 轮原始采样、Provider 时间与退出记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/server-matrix-results.json)
- [生产生命周期、卡片恢复及同会话接续记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/server-lifecycle-results.json)
- [原生启动阻塞记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/native-blocker.json)
- [本次临时服务端校验脚本](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/server-proof.mjs)
- [5764e1f 定点生产 API 复测记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-5764e1f-receipt.json)、[对应生产构建日志](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-5764e1f-build.log)
- [3fde111 定点生产 API 复测记录](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-3fde111-receipt.json)、[对应生产构建日志](/var/folders/rp/vlhgt2yj19v0wpz56zm5czrw0000gn/T/pi-automation-release-oi9ut2ug/desktop-proof-hny5hysf/api-3fde111-build.log)
