# 本地 pi 快照更新记录（2026-08-03）

## 更新目标

Pi Web Desktop 的四个直接 pi SDK 依赖仍以 registry `0.83.0` 作为默认回退。本文记录的本机开发和 macOS 桌面构建在执行同步命令后，使用了 `/Volumes/WorkSSD/项目/pi` 构建的 commit-stamped 快照；fresh clone 或普通 `npm install` 仍使用 registry 版本。

这样既能选择性使用尚未发布的最新 pi 代码，也避免把本机绝对路径或 workspace symlink 写入项目依赖。

## 来源版本

| 项目 | 值 |
| --- | --- |
| 源目录 | `/Volumes/WorkSSD/项目/pi` |
| 分支 | `main` |
| 完整 commit | `2e95584dab802ae2f7c8d1a4994d6e0e9f67ec09` |
| Git describe | `v0.83.0-189-g2e95584da` |
| 基础包版本 | `0.83.0` |
| 相比发布标签 | `v0.83.0` 之后 189 个提交 |
| 源工作树 | 同步时为 clean |

本次安装的包版本均带构建元数据：

```text
0.83.0+local.2e95584da
```

实际快照包括：

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-protocol`
- `@earendil-works/pi-client`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

`pi-client` 和 `pi-protocol` 是最新 `pi-coding-agent` 新增的内部依赖，因此必须与原有四个直接依赖一起安装，防止 npm 从 registry 嵌套安装旧版 `0.83.0`。

## 与 Pi Web Desktop 相关的主要更新

### AI 与 provider

- 修复 nullable `anyOf` / `oneOf` 工具参数在校验时把 `null` 错误转换为其他 primitive 的问题。
- 保留 Gemini 3 的 provider tool-call ID，降低多轮工具调用的关联错误。
- Google adapters 会重试 transient provider error。
- 保留 Anthropic 初始 stream block 内容，以及 Google history 中带签名的空 text/thinking block。
- OpenAI-compatible provider 可声明 stream 没有 `finish_reason`，由 pi 在流结束时推断 stop/tool-use。
- Bedrock provider error 保留结构化错误码和 request id。
- 更新 GPT-5.6 Terra/Luna 定价以及部分 provider/model 路由元数据。

这些修复会直接作用于 Web Desktop 的模型测试、AgentSession streaming、工具调用和上下文回放。

### 模型与认证

- `AuthStorage` 会检测外部进程修改后的 `auth.json`，并在读取时刷新缓存。
- 并发或卡住的 model availability refresh 不再阻塞后续强制刷新。
- 较慢的旧 refresh 不能覆盖较新的 model snapshot。
- provider login 后的 catalog refresh 增加 15 秒有界超时，并继承客户端取消信号。
- catalog refresh failure 能标识具体失败 catalog。

这些变化与 `app/api/auth/**`、`app/api/models/**`、`ModelsConfig` 和 provider 状态展示相关。

### Coding Agent 与 extension runtime

- 畸形 package resource 数组不再导致 session startup 崩溃。
- extension 触发的 compaction、handoff 和 Q&A model call 统一走 coding-agent `ModelRuntime`，保留自定义 provider 和认证选项。
- `AI_AGENT` 环境变量会注入 coding-agent 启动的命令环境。
- custom editor 继承 `autocompleteMaxVisible`。
- `setToolsExpanded(false)` 在已经折叠时不再产生重复状态通知。
- 新增 chainable `pi.registerMarkdownTransformer()` API。

Markdown transformer 目前属于 pi interactive transcript 的展示扩展。本次只升级底层运行时，没有自动把该 API 映射为 Web Desktop 的 React Markdown pipeline。

### TUI 与实验功能

本地 pi 新增 fullscreen/alternate-screen TUI、sticky dock、scroll view、scrollbar、布局组件和导航快捷键。这些属于终端 UI 能力，Pi Web Desktop 有独立 React/Electron UI，因此本次不移植对应界面。

同时新增 experimental runtime-neutral session client 和 Unix transport。当前 Web Desktop 仍使用进程内 `createAgentSessionServices()` / `createAgentSessionFromServices()`；没有迁移到远程 client/server 架构。

### Agent harness session storage

`pi-agent-core` 的 Unreleased breaking changes把新 harness session persistence 改为：

- caller-owned `SessionStore`
- non-owning `SessionRepository`
- repository 创建 `Session` aggregate
- store 需要在 harness/session work drain 后异步 dispose

Pi Web Desktop 当前使用 `@earendil-works/pi-coding-agent` 的 `SessionManager` 读取和维护 JSONL 会话，并不直接构造 agent-core harness `Session`，因此这项 breaking change没有触发当前会话层迁移。

## API 兼容性检查

当前项目使用的以下根导出在本地 pi HEAD 中仍然存在：

- `SessionManager`
- `createAgentSessionServices`
- `createAgentSessionFromServices`
- `ModelRuntime`
- `DefaultResourceLoader`
- `Theme` / `initTheme`
- `SettingsManager`
- `ProjectTrustStore` / `hasTrustRequiringProjectResources`
- `parseFrontmatter`
- `ThinkingLevel`
- `getSupportedThinkingLevels`
- `completeSimple`
- `KeybindingsManager` / `TUI_KEYBINDINGS`

`Theme` 新增可选 `scrollbarThumb` 背景色并回退到 `selectedBg`。Pi Web Desktop 的 `PlainTextTheme` 传入空背景表仍可通过兼容 fallback 工作，最终以 TypeScript 和构建验证结果为准。

## 本地同步方式

默认源目录是项目的兄弟目录 `../pi`：

```bash
npm run pi:sync-local
```

显式指定目录：

```bash
npm run pi:sync-local -- --source /Volumes/WorkSSD/项目/pi
```

同步脚本会：

1. 校验 pi monorepo、所需 package 和干净的 Git 工作树；dirty source 会被拒绝。
2. 仅当 `<pi-source>/node_modules` 不存在时执行 `npm ci --ignore-scripts`；不完整或陈旧的依赖目录需人工重装。
3. 缺少 provider model data 时执行 `npm run hydrate:model-data`。
4. 按依赖顺序构建六个 pi package，并在构建后再次确认源工作树干净。
5. 在临时副本中写入 `0.83.0+local.<commit>` 版本和精确内部依赖。
6. 保留 coding-agent 的 upstream shrinkwrap，仅更新快照版本和五个内部 pi 依赖，避免重新解析不同的 transitive graph。
7. 将 tarball 和 SHA-256 写入 `.local-pi/snapshots/<commit>/manifest.json`。
8. 在临时隔离目录中用 `dependencies` + `overrides` 和 nested install strategy 安装六个 tarball，再原子替换项目中的六个实体包；各包保留自己锁定的 runtime dependencies。
9. 验证六包 commit marker、tarball checksum、直接依赖解析和无嵌套旧版 pi package。

同步可能访问 npm registry：pi 源缺少依赖时需要 `npm ci`，隔离安装也需要解析非 pi runtime dependencies。完全离线运行要求 npm cache 完整且 model data 已 hydration。

每个安装包只包含可安全分发的稳定来源信息；绝对源路径和生成时间仅保留在 Git 忽略的外部 `manifest.json`：

```json
{
  "commit": "<40-character commit>",
  "shortCommit": "<9-character commit>",
  "describe": "v0.83.0-N-g<commit>",
  "package": "@earendil-works/pi-coding-agent",
  "snapshotVersion": "0.83.0+local.<commit>"
}
```

已有快照可在 npm 改写 `node_modules` 后恢复并验证：

```bash
npm run pi:sync-local -- --restore
npm run pi:sync-local -- --verify
```

Windows release 流程会在 `npm dedupe`、`npm prune` 和开发依赖恢复后自动恢复并验证快照，并按目标 `win32`/当前 CPU 解析 optional dependencies。

## 本次生成的本地快照

```text
.local-pi/snapshots/2e95584da/
  earendil-works-pi-agent-core-0.83.0+local.2e95584da.tgz
  earendil-works-pi-ai-0.83.0+local.2e95584da.tgz
  earendil-works-pi-client-0.83.0+local.2e95584da.tgz
  earendil-works-pi-coding-agent-0.83.0+local.2e95584da.tgz
  earendil-works-pi-protocol-0.83.0+local.2e95584da.tgz
  earendil-works-pi-tui-0.83.0+local.2e95584da.tgz
  manifest.json
```

`.local-pi/` 已加入 `.gitignore`，不会提交 tarball。同步脚本与本文档可以提交，以便在同目录结构或指定 `--source` 时复现。

## 验证记录

已完成：

- 六个包均安装为 `0.83.0+local.2e95584da`。
- 六个包的 `pi-local-source.json` 均指向 commit `2e95584dab802ae2f7c8d1a4994d6e0e9f67ec09`。
- 安装目录均为真实 `node_modules` 目录，不是指向 pi workspace 的 symlink。
- `pi-coding-agent/node_modules/@earendil-works` 下没有嵌套旧版 pi package。
- pi 源仓库在构建和 model-data hydration 后仍保持 Git clean。

继续验证结果：

- `./node_modules/.bin/tsc --noEmit`：通过。
- `npm run build`：通过；Next.js 16.2.12 production build 完成。仍有既有的 Turbopack NFT tracing warning（`next.config.ts` → Git status route）。
- `npm run dev:turbo`：通过；首页、`/api/home`、`/api/auth/providers`、`/api/models` 均成功响应。
- `npm run electron:build`：通过；生成 `release/Pi Web-0.7.16-arm64.dmg`。
- Electron bundle 内六个 pi package 均为 `0.83.0+local.2e95584da`，commit marker 一致。
- `hdiutil verify`：DMG checksum valid。
- `git diff --check`：通过。

未全部通过的既有检查：

- `node --test`：189 项中 185 通过、4 失败。与本次 pi 升级直接相关的 `PlainTextTheme` 启动崩溃已修复；剩余失败为：
  - macOS `/var` 与 `/private/var` realpath 断言差异；
  - Node 直接执行 `app/api/models-config/test/route.ts` 时无法解析 extensionless `next/server`；
  - 两个 Git fixture 测试同样受 macOS `/var` 与 `/private/var` canonical path 差异影响。
- `npm run lint`：10 个既有 React Compiler `react-hooks/preserve-manual-memoization` 错误，位于 `ChatInput.tsx`、`ChatMinimap.tsx` 和 `useAgentSession.ts`；本次未改动这些区域。

## 已知限制

- 本地 pi package 的基础 `package.json` 版本仍是 `0.83.0`，快照版本通过 build metadata 标记 commit；UI 中显示的 pi 版本会是 `0.83.0+local.2e95584da`。
- 普通 `npm install` / `npm ci` 会依据 `package.json` 和 lockfile 恢复 registry `0.83.0`。之后需重新运行 `npm run pi:sync-local`。
- model data 首次缺失时需要网络 hydration。生成的数据由 pi 的 `.gitignore` 管理，本次没有修改 pi 的受跟踪源文件。
- 快照用于本机开发和打包，不作为 npm 发布依赖。
- 最新 pi 中新增的 TUI fullscreen、Markdown transformer 和 remote session client 不等于 Web UI 功能已自动接入。

## 回滚

恢复 registry `0.83.0`：

```bash
npm install
```

或进行 lockfile 严格重装：

```bash
npm ci
```

如不再需要缓存，可删除被忽略的 `.local-pi/`。项目源码和 `package-lock.json` 不依赖该目录。
