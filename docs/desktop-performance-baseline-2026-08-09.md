# 数字化 AI 助手性能基线（2026-08-09）

> 参考机器：Apple M4 / 10 logical CPU / 16 GiB / macOS arm64 / Darwin 25.5.0  
> 运行时：Node 22.22.3 / Electron 43.2.0 / Next 16.3.0  
> 脚本：`scripts/benchmark-desktop.mjs`

## 1. 复现命令

```bash
# 核心夹具 + 隔离 Electron 启动
npm run benchmark:desktop

# 只跑核心夹具
node --expose-gc scripts/benchmark-desktop.mjs --no-electron

# 30 分钟内存趋势
node --expose-gc scripts/benchmark-desktop.mjs --soak-minutes=30
```

脚本只使用临时 session/Git/profile，不发送模型请求、不读取真实凭据、不上传遥测。Electron/Chromium 指标仅在 `PI_WEB_BENCHMARK=1` 的隔离子进程中启用。

## 2. 固定夹具

| 夹具 | 规模 |
| --- | ---: |
| 典型会话 | 200 messages |
| 长会话 | 5,000 messages，thinking 延迟加载 |
| 分支切换 | 长会话中间 2,500-message leaf |
| Markdown | 80 sections，含 GFM、链接、数学和 TypeScript code fence |
| 大工具结果 | 约 4.8 MB 文本，默认折叠预览 |
| 文件索引 | 50,000 files |
| Git | 1,000 tracked files / 100 dirty files |
| 流式更新 | 同步 enqueue 100,000 个完整快照 |

## 3. 核心结果

| 测量 | samples | p50 | p95 | 预算 |
| --- | ---: | ---: | ---: | ---: |
| session context / 200 messages | 12 | 0.08 ms | 0.09 ms | p95 ≤ 1 ms |
| session context / 5,000 messages | 8 | 0.90 ms | 4.08 ms | p95 ≤ 8 ms |
| branch switch / 2,500-message leaf | 8 | 0.50 ms | 1.55 ms | p95 ≤ 5 ms |
| JSONL read / 5,000 messages | 6 | 5.32 ms | 7.27 ms | p95 ≤ 10 ms |
| complete Markdown initial render / 80 sections | 6 | 53.40 ms | 84.95 ms | p95 ≤ 100 ms |
| streaming Markdown initial render / 80 sections | 6 | 85.56 ms | 144.27 ms | p95 ≤ 160 ms |
| collapsed tool result / 4.8 MB | 10 | 0.19 ms | 0.31 ms | p95 ≤ 2 ms |
| file index build / 50,000 files | 8 | 52.66 ms | 55.32 ms | p95 ≤ 65 ms |
| file search / 50,000 entries | 20 | 9.66 ms | 10.44 ms | p95 ≤ 15 ms |
| stream coalesce / 100,000 updates | 10 | 0.31 ms | 1.41 ms | one commit, p95 ≤ 3 ms |
| Git status / 1,000 files / 100 dirty | 5 | 20.08 ms | 37.45 ms | p95 ≤ 50 ms |

测量预算统一采用同机同夹具 p50/p95 最大回退 10%。表内绝对预算向上留出小幅机器噪声，但不能替代相对回归判断。

## 4. Electron 启动

### 4.1 开发态

| 阶段 | 首轮 | 热缓存轮 |
| --- | ---: | ---: |
| server ready | 5.13 s | 3.36 s |
| renderer load | 9.05 s | 7.08 s |
| renderer interactive（load 后两帧） | 9.19 s | 7.28 s |

热缓存轮的 Chromium 指标：

- `JSHeapUsedSize`：17,178,852 bytes（约 16.4 MiB）
- `ScriptDuration`：121 ms
- `LayoutDuration`：33 ms
- `TaskDuration`：169 ms
- DOM nodes：115

结论：开发态主要成本是 dev server 与页面编译/导航，不是初始 DOM 布局。

### 4.2 macOS arm64 生产目录包

| 场景 | server ready | interactive | 端口 |
| --- | ---: | ---: | ---: |
| 默认端口可用 | 0.68 s | 1.14 s | 30141 |
| 30141 被占用（最终包） | 0.66 s | 1.21 s | 62494 |

占端口场景由真实 TCP listener + 新打包应用完成，不是纯函数模拟。解压 `.app` 约 832 MiB；本轮未生成 DMG，未测压缩安装包体积。

## 5. 解释边界

- `renderToStaticMarkup` 测的是 80-section 消息首次出现的冷渲染上界，不代表每个 token 都重渲染全部内容。
- 实际流式路径由 stable-part interning、`React.memo`、未闭合 code fence 的纯文本展示和 30 updates/s scheduler 共同保护。
- 100,000 次同步更新只提交一次，说明合并器符合设计；不能据此替代浏览器中的长时间交互 trace。
- 4.8 MB 工具结果只生成约 500 字节的折叠 HTML，现有截断策略有效。
- 5,000-message 上下文和 JSONL I/O 明显低于 Markdown 初次渲染，因此不应因 `useAgentSession.ts` 文件较大就把它认定为性能瓶颈。

## 6. 30 分钟内存趋势

受管 soak 对 1,000-message 会话执行 175,300 轮上下文构建，每分钟记录一次 RSS、heap、external，共得到 30 个样本；负载结束后显式 GC 并空闲 5 秒。

| 指标 | 首样本 | 末样本 | 区间峰值 | GC + 空闲后 |
| --- | ---: | ---: | ---: | ---: |
| RSS | 173.66 MiB | 62.98 MiB | 173.66 MiB | 84.88 MiB |
| heap used | 62.65 MiB | 54.26 MiB | 62.65 MiB | 43.77 MiB |
| external | 3.71 MiB | 3.81 MiB | 3.84 MiB | 3.81 MiB |

RSS 的相邻样本中有 13 次上升、15 次下降、1 次持平，最长连续上升仅 2 个采样周期；末值比首值低 110.67 MiB。heap 虽有正常分配波动，但末值比首值低 8.40 MiB，GC 后又回落 10.49 MiB。external 全程只在 3.71–3.84 MiB 间变化。结论：本夹具下未观察到随时间持续单调增长，负载停止后的可回收 heap 低于全部逐分钟样本，稳定性预算通过。

## 7. 后续触发条件

- streaming Markdown p95 超过 160 ms：用 React Profiler 定位具体 block/插件，不先拆整个聊天组件。
- 文件搜索 p95 超过 15 ms或连续输入出现主线程延迟：评估 Worker/增量索引。
- 生产启动超过 1.5 秒：分别检查 server ready 与 navigation，不用开发编译时间替代产品指标。
- soak 在停止负载和 GC 后仍高于稳定峰值或继续增长：检查 session registry、SSE timer、图片 URL 和 Markdown cache 的持有关系。
