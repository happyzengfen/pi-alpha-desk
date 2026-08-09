# CLAUDE.md

## 项目定位

Pi Alpha Desk（npm 包名 `@happyzengfen/pi-alpha-desk`）是面向 pi coding agent 的 Electron-first 桌面客户端，基于上游 pi-web `v0.7.16` 分化开发。

核心能力包括：

- 本地 pi 会话浏览、分支、Fork 与实时 SSE 对话
- 模型、认证、插件和技能管理
- 项目文件浏览、搜索、预览、Git 状态与 diff
- Git worktree 管理
- pi / PI-TUI JSON 主题适配
- Electron 无边框窗口、托盘与原生目录选择
- 英文与简体中文界面

本仓库不是上游镜像。优先保持本项目的桌面产品体验，同时选择性吸收上游的 SDK 兼容、安全、正确性和可靠性修复。

## 技术栈

- Node.js `>=22.19.0`
- Next.js `16.3.0`（App Router）
- React `19.2.x`
- TypeScript 5，`strict: true`
- Tailwind CSS 4
- Electron 43 + electron-builder 26
- 四个直接 pi SDK 依赖的 registry fallback 为 `0.84.0`；本地同步还会安装同 commit 的 `pi-client` 和 `pi-protocol` 内部包
- npm（registry 依赖以 `package-lock.json` 为准；`.local-pi/` 快照不写入 lockfile）
- Node 内置测试运行器，测试文件为共置的 `*.test.mjs`

## 目录职责

```text
app/
  api/                  Next.js Route Handlers；Agent、会话、文件、Git、模型、认证、插件、技能、主题、worktree
  globals.css           Tailwind v4、全局样式和主题 CSS 变量
  layout.tsx            字体、主题和语言的 hydration 前初始化
  page.tsx              应用入口
components/             客户端 React UI
hooks/                  会话、主题、i18n、音频、拖拽、快捷键和布局 hooks
lib/                    SDK 封装、会话解析、文件安全、Git、Markdown、主题、i18n 等共享逻辑
lib/i18n/               locale registry、格式化与 en / zh-CN 消息目录
electron/               Electron main/preload、窗口、托盘、Next.js 服务生命周期
bin/                    npm CLI 入口和启动参数解析
scripts/                构建与发布脚本
docs/                   worktree 文档、主题示例和截图
public/                 图标、字体相关静态资源、Catppuccin 文件图标
```

关键入口：

- `components/AppShell.tsx`：主布局、URL 状态、侧栏、聊天和文件标签
- `components/ChatWindow.tsx`：消息区、SSE、流式状态与会话交互
- `components/ChatInput.tsx`：输入、模型、工具、thinking 和 slash controls
- `components/MessageView.tsx` / `ProcessGroup.tsx`：消息和过程步骤展示
- `components/FileViewer.tsx`：源码、diff、图片、音频、PDF、DOCX 预览
- `lib/rpc-manager.ts`：`AgentSessionWrapper` 生命周期与全局 registry
- `lib/session-reader.ts`：JSONL 会话读取、上下文构建和缓存
- `lib/file-access.ts`：文件访问 allow-list
- `lib/request-security.ts` / `proxy.ts`：Host、Origin 和 Basic Auth 边界
- `electron/main.js`：桌面窗口、托盘和本地 Next.js 服务启动

## 开发命令

先安装依赖：

```bash
npm install
```

常用命令：

```bash
npm run dev                 # Web 开发服务，127.0.0.1:30141，Webpack
npm run dev:turbo           # Turbopack 开发服务
npm run electron:dev        # Electron 开发模式
npm run pi:sync-local       # 从默认兄弟目录 ../pi 构建并安装本地 pi 快照
npm run pi:sync-local -- --source /absolute/path/to/pi
node --test                 # 全部 *.test.mjs 测试
node --test path/to/x.test.mjs
./node_modules/.bin/tsc --noEmit
npm run lint
```

发布相关：

```bash
npm run build
npm run electron:build
npm run release:green
npm run release
```

除非用户明确要求构建或发布，开发过程中不要运行 `npm run build` / `next build`。它会写入 `.next/`，可能干扰正在运行的 dev server。`release:green` 还会执行 dedupe、prune、Electron 打包并重装依赖，属于高影响发布流程。

当前 `package.json` 没有 `test` script；测试命令是 `node --test`。README/AGENTS.md 中出现的 `npm test` 或 Turbopack 默认描述可能已经过时，应以 `package.json` 为准。

### 本地 pi 快照

- `npm run pi:sync-local` 默认读取兄弟目录 `../pi`；其他位置使用 `--source <absolute-path>`。
- 脚本构建并安装 `pi-tui`、`pi-ai`、`pi-agent-core`、`pi-protocol`、`pi-client` 和 `pi-coding-agent` 的同 commit 快照。
- 生成的 tarball 和 `manifest.json` 位于 `.local-pi/snapshots/<short-commit>/`，该目录被 Git 忽略。
- 快照版本使用 `0.84.0+local.<short-commit>` 形式，并在每个包的 `pi-local-source.json` 中记录源路径、完整 commit、describe 和 ISO 8601 生成时间。
- 本地安装先在临时隔离目录通过 `dependencies` + `overrides` 和 nested install strategy 解析六个 tarball，再原子替换项目中的实体包；不会修改 registry fallback 依赖、其他项目依赖或 `package-lock.json`。
- 普通 `npm install` / `npm ci` / `npm dedupe` 会恢复 registry 版本；使用 `npm run pi:sync-local -- --restore` 恢复最近快照，`--verify` 只做身份和 checksum 检查。
- dirty pi source 会被拒绝；快照保留 coding-agent shrinkwrap 的 transitive pins，并在外部 manifest 中记录每个 tarball 的 SHA-256。
- 不要直接 symlink pi workspace 包；Next.js、npm 依赖去重和 Electron 打包更适合实体 tarball 快照。
- 当前本地快照的来源、上游变更和验证记录见 `docs/local-pi-update-2026-08-03.md`。

## 代码约定

- 使用 `@/` 作为仓库根目录别名。
- API endpoint 放在 `app/api/**/route.ts`，导出 `GET` / `POST` / `PUT` / `PATCH` / `DELETE`。
- 使用 hooks 或浏览器 API 的组件保留 `"use client"`。
- 组件文件使用 PascalCase；hooks 使用 `useXxx`；`lib/` 工具文件通常使用 kebab-case。
- 测试与源码共置，使用 `node:test` + `node:assert/strict`；需要导入 TS/TSX 时沿用现有 `jiti` 模式。
- 注释解释“为什么”，不要复述代码。
- 匹配现有格式和实现方式；只修改与任务直接相关的代码。
- pi SDK 的服务端包若不应被 Next.js 打包，需要同步维护 `next.config.ts` 的 `serverExternalPackages`。
- Electron 主进程和 preload 直接运行 CommonJS；不要无故迁移为 ESM 或引入编译步骤。

## 产品与合并约束

### 保留桌面资产

以下文件是高冲突的桌面产品资产，只做针对性的行为修改，不要用上游文件整体覆盖：

- `components/AppShell.tsx`
- `components/SessionSidebar.tsx`
- `components/ChatWindow.tsx`
- `components/ChatInput.tsx`
- `components/MarkdownBody.tsx`
- `components/FileViewer.tsx`
- `app/globals.css`
- `hooks/useTheme.ts`

同时保留：无边框窗口和标题栏、桌面侧栏交互、IA Writer Quattro/Lilex 字体、主题系统、过程时间线、Markdown 展示、Phosphor/provider 图标以及 Electron 原生集成。

### 上游同步原则

- 优先迁移安全边界、Pi SDK/API 兼容、会话/模型/认证正确性、文件系统安全和 SSE 可靠性。
- 迁移“行为”，不要整块替换本地 UI 组件。
- 跨层功能要完整迁移。例如模型 scope 涉及 SDK 解析、API/cache、AgentSession 构造和 UI 反馈时，不要只改 selector。
- `ref-repos/` 只可作为本地只读比较材料：不提交、不整树复制、不作为替代源代码。
- 不要覆盖 `package.json`；必须保留 Electron 打包、字体、图标、CLI 和发布配置。

## 关键不变量

### AgentSession 与会话

- `lib/rpc-manager.ts` 中每个 session id 对应一个 `AgentSessionWrapper`；registry 和锁放在 `globalThis`，用于跨 Next.js hot reload 保存。
- wrapper 空闲 10 分钟后关闭；运行中的 prompt、compaction 或 bash 不能被空闲回收。
- `AgentSession.fork()` 会原地改变内部 session id。Fork 完成后必须立即销毁旧 wrapper，避免 registry 中旧 id 指向已 Fork 状态。
- Fork 会创建新的 `.jsonl` 文件；`navigate_tree` / BranchNavigator 是同一会话文件内的分支。不要混淆两种操作。
- pi 保存的 tool call 字段与 UI 类型不同；文件读取和流式事件都必须经过 `normalizeToolCalls()`。
- 会话文件默认位于 `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`；`PI_CODING_AGENT_DIR` 可更换 agent 目录。

### SSE 与流式状态

- 聊天事件以单会话 SSE 为主，running 状态和状态 reconciliation 用于补偿后台标签页、掉线或漏掉的结束事件。
- 修改 SSE 时保留断线重连、运行状态恢复、旧 run 事件隔离、compaction 新旧事件名兼容和 bash output 行为。
- SSE 事件只向客户端投影必要字段，不要直接透传 SDK 内部对象或未消费事件。

### 文件与项目安全

- `/api/files` 不是通用文件系统浏览器。可访问根目录来自会话 cwd、解析后的主项目根、`~/pi-cwd-*` 和显式 `allowFileRoot()` 注册的位置。
- 新建/选择 cwd 或 worktree 后，需要同步加入 allow-list。
- 保留路径规范化、Windows 路径处理、越界检查、bounded upload 和原子写入。
- 仓库资源（项目 extensions、packages、prompts、`.agents/skills`）在 SDK 导入或执行前必须经过 project trust gate；不要绕过 `lib/project-trust.ts`。

### 网络与认证安全

- 默认监听 `127.0.0.1`。不要为了 LAN 使用通配 CORS 或放宽 Host/Origin 校验。
- LAN 模式依赖显式 hostname/allowed hosts、`PI_WEB_PASSWORD`，并应配合 HTTPS 或可信 VPN。
- 修改 `PI_WEB_HOSTNAME`、`PI_WEB_ALLOWED_HOSTS`、`PI_WEB_PASSWORD`、Host/Origin 校验或响应状态时，必须同时验证 Electron 的 `/api/home` readiness 流程和 BrowserWindow 启动。
- Electron 本地子进程会剥离环境中的 `PI_WEB_PASSWORD`；不要把桌面本地密码暴露给 Chromium。
- 认证状态接口不得返回原始 API key。

### Electron

- `asar: false` 时不能依赖 `app.isPackaged`；当前通过 `resources/app` / `resources/app.asar` 判断 dev/production。
- 生产环境通过 `fork()` 启动 Next.js，因为 `process.execPath` 是打包后的应用程序而不是普通 Node 可执行文件。
- 窗口是 frameless；布局改动必须保留拖拽区域、窗口按钮和 workspace controls。
- 关闭窗口默认隐藏到托盘；真正退出由 tray Quit / app quitting 流程处理。

### 主题与 i18n

- 主题支持 `~/.pi/agent/themes/` 和项目 `.pi/themes/`，按 `name-dark.json` / `name-light.json` 组成 theme set。
- `app/layout.tsx` 在 hydration 前设置主题和语言，避免 Electron 中闪烁。不要把这段初始化简单移到 React effect。
- i18n 仅支持 `en` 和 `zh-CN`；调用侧使用 `useI18n()`。
- 修改消息目录时，保持英文/中文 key parity，并运行 `lib/i18n/*.test.mjs`。
- 保留旧 localStorage key 到新 key 的幂等、自清理迁移，除非明确结束对应旧版本支持。

## 环境变量

常见运行配置：

- `PORT`：服务端口，默认 `30141`
- `PI_WEB_HOSTNAME`：监听/允许的主机名，CLI 默认 `127.0.0.1`
- `PI_WEB_ALLOWED_HOSTS`：额外允许的 Host，逗号分隔
- `PI_WEB_PASSWORD`：Web/LAN Basic Auth 密码
- `PI_CODING_AGENT_DIR`：pi agent 数据目录（由 SDK 使用）
- `SKILLS_API_URL`：技能搜索 API 覆盖
- `PI_WEB_RELEASE_TARGET`：发布脚本 Electron target
- `GITHUB_TOKEN` / `GH_TOKEN`：发布或 GitHub 操作凭据

不要提交 `.env*`、凭据、会话数据或本地参考仓库。

## 验证要求

按改动范围选择最小但充分的验证：

1. 先运行直接相关的单个测试文件。
2. 逻辑或跨模块改动运行 `node --test`。
3. TypeScript 改动运行 `./node_modules/.bin/tsc --noEmit`。
4. React、Next.js 或通用代码改动运行 `npm run lint`。
5. Electron 启动、网络安全或 readiness 改动，至少手动验证 Electron 启动、窗口加载和关闭/托盘行为。
6. 主题或 i18n 改动验证 hydration 前状态、深浅色切换以及中英文 key parity。
7. 文件访问、worktree、认证、项目信任等安全边界改动必须补充或更新回归测试。

依赖未安装时，先报告并运行 `npm install`（不要把缺少 `node_modules` 误报为代码失败）。不要为了常规验证执行发布脚本。

## 文档来源优先级

遇到不一致时按以下顺序判断：

1. 当前代码与 `package.json`
2. 本文件中的项目级约束
3. `AGENTS.md` 的详细架构背景
4. `README.md` / `README.zh-CN.md` 的用户文档

如果行为发生变化，同时更新相关 README、docs、测试和本文件中受影响的约束；不要保留已确认过时的命令或架构描述。
