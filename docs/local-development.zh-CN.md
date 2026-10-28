# pi-alpha-desk 本地开发与使用手册

本文面向第一次在本机运行、调试或二次开发 `pi-alpha-desk` 的开发者，覆盖 Web、Electron 桌面壳、本地 Pi SDK 快照、模型认证、质量检查、局域网访问和常见故障。

文中的命令默认在仓库根目录执行。项目当前的权威版本与脚本来源是 [`package.json`](../package.json) 和 [Quality CI](../.github/workflows/quality.yml)；历史更新记录中的旧版本号不应替代当前配置。

## 1. 先选一种运行方式

| 目标 | 推荐命令 | 实际行为 |
| --- | --- | --- |
| 只开发 Web UI / API | `npm run dev` | 使用 Webpack，监听 `127.0.0.1:30141` |
| 快速运行完整桌面应用 | `npm run electron:dev` | Electron 复用现有健康服务，否则自动启动 Turbopack 开发服务 |
| 分开看 Web 与 Electron 日志 | 先 `npm run dev`，健康检查通过后再 `npm run electron:dev` | Electron 复用已经运行的 Webpack 服务 |
| 使用 registry 版 Pi SDK | 正常安装后直接启动 | 当前 fallback 版本以 `package.json` 为准 |
| 联调本地 Pi 源码 | `npm run pi:sync-local -- --source <pi 路径>` | 构建并替换 `node_modules` 中的六个 Pi 包 |

如果你只是想尽快看到界面：

```bash
npm ci
npm run dev
```

然后打开 <http://127.0.0.1:30141>。

这组命令只解决“界面跑起来”。在选择真实项目或发送第一条消息前，请先阅读第 4 节并决定是否隔离 Pi 数据与工作区。

如果你需要原生目录选择器、托盘、窗口控制等桌面能力：

```bash
npm ci
npm run electron:dev
```

## 2. 环境要求

### 2.1 必需软件

- Node.js `>=22.19.0`。项目 CI 当前使用 Node.js `22.22.0`，希望最大程度复现 CI 时建议使用该版本。
- npm。仓库包含 npm lockfile，未锁定某个精确 npm 版本。
- Git。启动应用本身不强制依赖 Git，但 Git 状态、diff 和 worktree 功能需要它。
- 可访问 npm registry 的网络，用于首次安装依赖。
- 运行 Electron 时需要图形桌面环境。

项目直接在 Next.js 服务进程中调用 Pi SDK，不依赖外部 `pi` 进程，因此不要求额外全局安装 Pi CLI。已有 Pi CLI 配置可以直接复用。

先检查环境：

```bash
node --version
npm --version
git --version
```

`node --version` 必须不低于 `v22.19.0`。

如果尚未安装或版本过低：

- macOS / Linux：使用你已经信任的 Node 版本管理器，或安装官方 Node.js `22.22.0`，然后重新打开终端。
- Windows：安装同版本的官方 x64/arm64 安装包，架构应与系统一致，然后重新打开 PowerShell。
- Git 也应从官方安装包或系统包管理器安装。
- Windows 如果仅因 PowerShell 的 `npm.ps1` 策略阻止执行，可在当前终端改用 `npm.cmd`，例如 `npm.cmd ci`。不要为了运行本项目全局关闭脚本安全策略。

### 2.2 可选软件

- Windows 上安装 Microsoft Office 或 WPS，可获得 DOCX/PPTX 转 PDF 的高保真预览。
- 未安装 Office/WPS 时，应用仍可使用文本或大纲回退，不影响普通源码开发。
- Linux 无图形环境时不能直接交互式运行 Electron；自动化场景需要类似 Xvfb 的显示服务。
- Linux CI 额外安装 `libopenjp2-tools` 与 `xvfb`，其中 Xvfb 只用于无头 smoke。普通桌面缺少动态库时，应按发行版补齐 Electron 报告的系统库，不要把 `root + --no-sandbox` 当作日常开发方案。
- 某些 Linux 桌面环境默认不显示托盘图标。窗口隐藏后若没有托盘入口，可回到启动终端按 `Ctrl+C`，或在确认进程身份后使用系统任务管理器结束开发进程。

## 3. 获取代码与安装依赖

已有仓库时直接进入仓库根目录；否则可以执行：

```bash
git clone https://github.com/happyzengfen/pi-alpha-desk.git
cd pi-alpha-desk
npm ci
```

安装方式的选择：

- 新 clone、CI 复现、依赖异常恢复：使用 `npm ci`。
- 主动添加或升级依赖：使用 `npm install <package>`，并审查 `package.json` 与 `package-lock.json` 的变更。
- 不要为普通项目安装使用 `--ignore-scripts`，Electron 和原生依赖可能需要安装脚本。

安装完成后可做一个只读检查：

```bash
npm ls --depth=0
```

如果命令报告缺失依赖，先解决安装问题再启动应用。少量 `extraneous` 提示可能来自平台可选依赖；是否可接受应结合 `npm test`、类型检查和实际启动判断。

## 4. 先决定是否隔离 Pi 数据

这是本地开发最重要的选择之一。

### 4.1 两种模式

| 模式 | 做法 | 适用场景 | 风险 |
| --- | --- | --- | --- |
| 复用现有数据 | 不设置 `PI_CODING_AGENT_DIR` | 想直接读取日常 Pi 会话和配置 | 开发测试会修改真实设置、会话、插件、Skills 与 trust 状态 |
| 隔离开发数据 | 将 `PI_CODING_AGENT_DIR` 指向独立绝对路径 | 会话、模型、认证和 agent package/plugin 的功能测试 | 仍不会隔离真实项目文件或 `~/.agents/skills` |

建议默认使用隔离目录；只有明确需要验证与现有 Pi 数据兼容时才复用 `~/.pi/agent`。

### 4.2 macOS / Linux 设置隔离目录

```bash
umask 077
export PI_CODING_AGENT_DIR="$HOME/.pi-alpha-desk-dev/agent"
mkdir -p "$PI_CODING_AGENT_DIR"
chmod 700 "$PI_CODING_AGENT_DIR"
npm run dev
```

环境变量和 `umask 077` 只对当前终端及其子进程生效。该 umask 可让随后创建的 session、日志和配置默认只对当前用户开放；打开新终端后需要重新设置。

### 4.3 Windows PowerShell 设置隔离目录

```powershell
$env:PI_CODING_AGENT_DIR = Join-Path $HOME ".pi-alpha-desk-dev\agent"
New-Item -ItemType Directory -Force $env:PI_CODING_AGENT_DIR | Out-Null
npm run dev
```

该目录位于当前用户 profile 下并继承 Windows ACL。不要把它放到公共共享目录。如果使用双终端开发，两个终端必须设置相同的 `PI_CODING_AGENT_DIR`。

### 4.4 `.env.local` 的适用边界

Next.js 会读取仓库根目录的 `.env.local`，而 `.env*` 已被 Git 忽略。Web-only 开发可以写入：

```dotenv
PI_CODING_AGENT_DIR=/absolute/path/to/pi-alpha-desk-dev/agent
```

但 Electron 主进程本身不会依赖 Next.js 去加载 `.env.local`。以下逻辑直接读取 Electron 进程环境：

- 内置 Skills 的安装目标；
- 独立 Node runtime 的选择；
- Electron 自己启动的服务环境。

因此运行 `npm run electron:dev` 时，应在启动 Electron 的终端显式设置 `PI_CODING_AGENT_DIR`，不要只依赖 `.env.local`。

不要在 `.env.local` 中设置 `PI_WEB_PASSWORD` 后再让 Electron 自己启动服务。Electron 只能从继承的父进程环境中移除这个变量，Next.js 随后仍会重新加载 `.env.local`；readiness 请求不携带 Basic Auth，最终可能因收到 `401` 而启动失败。LAN 密码应只在独立 Web 终端中临时设置。

不要把 API Key、OAuth token 或其他密钥提交到仓库。即使 `.env.local` 已被忽略，也应控制本机文件权限与备份范围。

### 4.5 Pi 数据会写到哪里

未设置 override 时，主要数据位于 `~/.pi/agent/`：

| 路径 | 内容 |
| --- | --- |
| `auth.json` | 内置 provider 的 API Key / OAuth 凭据，敏感文件 |
| `models.json` | 自定义 provider 和模型配置，可能包含密钥引用或原始密钥 |
| `settings.json` | 默认模型、thinking level、插件与 package 等设置 |
| `sessions/<encoded-cwd>/*.jsonl` | 完整会话、工具参数与结果、分支、摘要 |
| `trust.json` | 项目信任决定 |
| `skills/` | 全局 Skills；Electron 也会安装缺失的内置 Skills |
| `themes/` | 全局主题 |
| `{npm,git}/` | 全局 package/plugin 安装内容 |

此外，Pi runtime 会独立加载 `~/.agents/skills/`。这个目录不受 `PI_CODING_AGENT_DIR` 影响，Skills 设置也可能修改其中的内容。

项目自身还可能读取或写入：

```text
<project>/.pi/settings.json
<project>/.pi/themes/
<project>/.pi/skills/
<project>/.agents/skills/
<project>/.pi/{npm,git}/
```

项目信任后，项目提供的扩展、packages、prompts 和 Skills 可能被加载或执行。只信任你确认过来源和内容的项目。

`PI_CODING_AGENT_DIR` 只隔离 agent 数据，不会保护当前工作区文件。Agent 工具仍可以在所选项目中读取、编辑、创建或删除文件。进行删除、迁移、插件执行或恶意输入测试时，应另外使用 disposable clone、临时 worktree 或“快速工作区”，不要选择日常工作的真实仓库。

当前还有几个与 `PI_CODING_AGENT_DIR` 有关的例外：

- 模型设置中的路径标签可能仍显示 `~/.pi/agent/models.json`；实际服务端读写路径以有效的 `PI_CODING_AGENT_DIR` 为准。
- 全局主题扫描与 Electron 的“打开主题目录”仍使用默认 `~/.pi/agent/themes/`。需要完全隔离主题实验时，优先使用 `<project>/.pi/themes/`。
- Pi runtime 与 Skills 设置仍会读取或写入 `~/.agents/skills/`；界面中的全局 Skills 路径标签也可能仍显示默认路径。进行 Skill 写入测试前先备份真实全局 Skills，或使用可丢弃的系统用户/容器环境。

## 5. Web 开发模式

### 5.1 启动

```bash
npm run dev
```

该脚本固定执行：

```text
next dev -H 127.0.0.1 -p 30141 --webpack
```

浏览器打开：

```text
http://127.0.0.1:30141
```

如果某个问题只在 Turbopack 出现，可改用：

```bash
npm run dev:turbo
```

同一端口不能同时运行 Webpack 与 Turbopack。

### 5.2 健康检查

macOS / Linux：

```bash
curl -fsS http://127.0.0.1:30141/api/home
```

预期返回类似：

```json
{"home":"/Users/example"}
```

Windows PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:30141/api/home
```

只要 `/api/home` 返回 2xx，Electron 开发模式也会将它视为可复用的本项目服务。

### 5.3 第一次进入应用

1. 在工作区选择器中选择项目目录。
2. Web 浏览器无法弹出 Electron 原生目录选择器，因此“选择文件夹”会要求输入服务器本机路径。支持绝对路径、相对路径、`~` 和 `~/...`。
3. 也可以使用“快速工作区”，服务端会创建 `~/pi-cwd-YYYYMMDD`。
4. 打开右上角“设置” → “模型”。
5. 添加 provider，完成 API Key、OAuth 或自定义模型配置。
6. 如果出现项目 trust 提示，先审查项目资源，再决定是否信任。
7. 新会话最初只是本地草稿；发送第一条消息时才会真正启动 Pi Agent 并创建 session 文件。

## 6. 模型与凭据配置

### 6.1 复用已有 Pi 配置

不设置 `PI_CODING_AGENT_DIR` 时，应用默认读取现有 `~/.pi/agent`。如果已有有效的 `auth.json`、`models.json` 和 `settings.json`，启动后通常可以直接看到可用模型。

### 6.2 在应用中添加内置 provider

进入“设置” → “模型” → “添加提供商”：

- API Key provider：选择提供商、输入密钥并保存。
- OAuth provider：按界面打开登录页、输入 device code，或粘贴回调 URL / 验证码。
- 点击断开连接只会删除 `auth.json` 中匹配类型的凭据；来自环境变量或 `models.json` 的密钥不会因此消失。

内置 provider 凭据写入有效 agent 目录下的 `auth.json`。服务端的状态接口不会把原始密钥返回给前端；POSIX 系统上新建文件会使用受限权限。

### 6.3 添加 OpenAI / Anthropic 兼容端点

添加自定义 provider 后，通常需要填写：

- provider 名称；
- Base URL；
- API 类型；
- API Key 或密钥解析方式；
- 至少一个 Model ID。

当前支持的 API 类型包括：

```text
openai-completions
openai-responses
anthropic-messages
google-generative-ai
```

自定义 provider 的 API Key 字段支持：

- 环境变量名称；
- `!shell command`；
- 原始密钥。

优先填写环境变量名称，避免把原始密钥保存到 `models.json`。`!shell command` 没有额外沙箱，会以 Next.js 服务的 OS 用户身份、工作目录和继承环境通过默认 shell 执行；点击连接测试和正常模型请求都可能触发它。不要复制未逐字审计的命令，也不要把密钥直接写进命令参数。

例如将 `models.json` 中的 API Key 字段写成 `MY_PROVIDER_API_KEY`，并在启动实际 Next.js 服务前设置它。

macOS / Linux，可通过隐藏输入避免把密钥写进 shell history：

```bash
printf 'Provider API key: '
IFS= read -r -s MY_PROVIDER_API_KEY
printf '\n'
export MY_PROVIDER_API_KEY
npm run dev
```

Windows PowerShell：

```powershell
$credential = Get-Credential -UserName "provider" -Message "Enter provider API key as the password"
$env:MY_PROVIDER_API_KEY = $credential.GetNetworkCredential().Password
npm run dev
```

Web-only 开发也可以把变量放进被忽略的 `.env.local`，但它仍是本机明文文件。修改变量后必须重启实际 Next.js 服务。

“内置 provider 状态接口不会返回原始密钥”不等于所有模型配置都不含密钥。自定义 `models.json` 会被模型配置接口返回给当前 Renderer；若保存了原始 key，它也会进入该响应，并可在 DevTools Network 中看到。这也是优先使用环境变量名称、避免不受保护 LAN 的原因。

“测试模型连接”会真实调用 provider，可能产生少量费用。测试请求超时后不会自动重试。

## 7. Electron 桌面开发

### 7.1 单终端快速启动

```bash
npm run electron:dev
```

开发态 Electron 的行为是：

1. 创建加载窗口。
2. 最多等待 2 秒，检查 `127.0.0.1:<PORT>/api/home`。
3. 如果接口已经返回 2xx，直接复用该服务。
4. 如果没有可用服务，自动 fork 一个 Next.js Turbopack 开发服务。
5. 服务就绪后加载主窗口。

这种模式最省事，也能使用热更新。Electron 自己启动 Web 服务时，Web 与 Electron 日志都会出现在同一终端；如果它复用了先前已经运行的服务，Web 日志仍在那个服务所属的终端。

### 7.2 双终端开发

需要更清晰的日志，或希望 Electron 使用 Webpack 时，采用双终端模式。

终端 A：

```bash
npm run dev
```

先等待健康检查成功：

```bash
curl -fsS http://127.0.0.1:30141/api/home
```

Windows PowerShell 使用：

```powershell
Invoke-RestMethod http://127.0.0.1:30141/api/home
```

终端 B：

```bash
npm run electron:dev
```

不要在 Web 服务尚未 ready 时立刻启动 Electron。Electron 只等待 2 秒；如果探测失败，它会尝试自己占用同一端口，可能产生 `EADDRINUSE`。

双终端模式下：

- Web 日志查看终端 A；
- Electron 主进程与 Renderer 崩溃信息查看终端 B；
- 退出 Electron 不会停止终端 A 中的外部 Web 服务；
- 还需要在终端 A 按 `Ctrl+C` 才能释放端口。

### 7.3 桌面生命周期

- 关闭窗口只会隐藏到系统托盘，不代表进程已经退出。
- 需要从托盘菜单选择 **Quit** 才能完整退出。
- 应用有单实例锁；再次运行命令时通常只会唤醒已有窗口。
- 使用 `F12` 或 `Ctrl+Shift+I` 可以切换 DevTools。
- 修改 `electron/main.js`、`electron/preload.js` 或 Electron 原生生命周期代码后，需要从托盘完整退出并重新启动。

### 7.4 热更新边界

| 变更类型 | 通常需要的动作 |
| --- | --- |
| React 组件、Hooks、CSS | 等待 Next.js HMR；必要时刷新页面 |
| API route、普通服务端模块 | 等待服务重编译；状态型全局对象可能需要重启 |
| `electron/main.js`、preload、窗口配置 | 完整 Quit Electron 后重启 |
| `package.json` / 依赖 | 停止服务，重新安装，再启动 |
| Pi SDK 本地源码 | 形成干净 commit，重新同步快照，再重启服务 |
| `PI_CODING_AGENT_DIR`、provider 环境变量 | 停止实际 Next.js 服务，并用新环境重新启动 |

如果 Electron 复用了旧的 Web 服务，仅重启 Electron 不会让服务端读取新的环境变量。

## 8. 自定义端口与端口冲突

### 8.1 源码 Web 脚本的限制

`npm run dev` 和 `npm run dev:turbo` 已把端口写死为 `30141`。仅设置 `PORT=30142` 不会覆盖脚本中的 `-p 30141`。

需要自定义 Web 开发端口时，直接运行 Next CLI：

```bash
npx next dev -H 127.0.0.1 -p 30142 --webpack
```

如果还要让 Electron 复用它：

macOS / Linux：

```bash
PORT=30142 npm run electron:dev
```

Windows PowerShell：

```powershell
$env:PORT = "30142"
npm run electron:dev
```

同样要先确认 `http://127.0.0.1:30142/api/home` 已返回 2xx。

### 8.2 查看端口占用

macOS / Linux：

```bash
lsof -nP -iTCP:30141 -sTCP:LISTEN
```

Windows PowerShell：

```powershell
Get-NetTCPConnection -LocalPort 30141 -State Listen
```

判断原则：

- 如果 `/api/home` 返回正确 JSON，可以让 Electron 复用该服务。
- 如果端口属于其他程序，停止那个程序或换端口。
- 不要因为端口占用就直接结束未知进程；先确认 PID 与进程来源。

打包后的 Electron 与开发态不同：未显式设置 `PORT` 时，默认端口被占用会自动选择本地空闲端口；开发态不会自动换端口。

## 9. 联调本地 Pi 源码

### 9.1 什么时候需要

只有在修改 `pi` monorepo 本身，或需要验证尚未发布的 SDK commit 时，才需要本地快照。普通 UI/API 开发直接使用 lockfile 中的 registry 版本即可。

本地同步不是 symlink 或源码热更新模式。每次 Pi 源码变化都需要重新构建和安装快照。

### 9.2 同步前检查

```bash
git -C /absolute/path/to/pi status --short
git -C /absolute/path/to/pi describe --tags --always
```

Windows PowerShell：

```powershell
git -C "C:\src\pi" status --short
git -C "C:\src\pi" describe --tags --always
```

同步脚本要求：

- 源目录必须是 `pi-monorepo`；
- 必须包含脚本声明的六个 Pi package；
- 源工作树在构建前和构建后都必须 clean；
- 若要联调未提交修改，需要先形成可复现的 commit；
- 源码 package 版本应与你想验证的目标一致，不能只看当前分支名称。

使用默认相邻目录前，至少比较一次 registry fallback 与本地源码基础版本：

```bash
node -p "require('./package.json').dependencies['@earendil-works/pi-coding-agent']"
node -p "require('../pi/packages/coding-agent/package.json').version"
```

两者不同不一定是错误，但意味着同步后会切换 SDK 基础版本。先更新本地 Pi checkout，或明确接受该版本变化，再继续。

### 9.3 构建并安装快照

默认读取项目相邻目录 `../pi`：

```bash
npm run pi:sync-local
```

显式指定路径更不容易混淆：

```bash
npm run pi:sync-local -- --source /absolute/path/to/pi
```

Windows PowerShell：

```powershell
npm run pi:sync-local -- --source "C:\src\pi"
```

脚本会：

1. 校验 Pi monorepo 和 Git clean 状态。
2. 必要时安装 Pi 源仓库构建依赖。
3. 必要时 hydrate provider model data。
4. 按上游根目录 `build:offline` 脚本构建完整 workspace，再选择 chord、pi-tui、pi-telemetry、pi-ai、pi-agent-core、pi-coding-agent 六个运行时包。
5. 创建带 commit 标记的 tarball。
6. 写入 `.local-pi/snapshots/<short-commit>/manifest.json` 与 SHA-256。
7. 分阶段替换当前项目 `node_modules` 中对应的六个包；失败时回滚已经完成的替换。
8. 验证包版本、commit marker、checksum 与依赖树。

同步完成后再次验证：

```bash
npm run pi:sync-local -- --verify
```

然后重新启动 Web 或 Electron 服务。

### 9.4 恢复最近一次快照

普通 `npm install`、`npm ci` 或 `npm dedupe` 会将 `node_modules` 恢复为 registry fallback。仍需本地快照时执行：

```bash
npm run pi:sync-local -- --restore
npm run pi:sync-local -- --verify
```

`--restore` 默认选择 `generatedAt` 最新的本地 manifest；可以用 `--restore --snapshot <commit>` 指定 commit。`--verify` 默认校验当前已安装快照的 commit，也支持 `--snapshot <commit>`。恢复前会先核对 tarball 的 SHA-256，避免损坏缓存替换可用包。Windows 发布脚本只恢复构建开始时已激活的快照，并固定该 commit；只有历史缓存而未启用快照时，继续使用 registry 版本。

跨平台恢复 optional dependencies 的示例：

```bash
npm run pi:sync-local -- --restore --os win32 --cpu x64
```

### 9.5 回到 registry 版本

```bash
npm ci
npm ls @earendil-works/pi-agent-core @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui
```

当前 registry fallback 版本必须以 [`package.json`](../package.json) 为准。`docs/local-pi-update-2026-08-03.md` 是一次历史更新记录，其中的旧版本号和当时测试结果不代表当前状态。

`.local-pi/` 已被 Git 忽略。manifest 会记录本机绝对源码路径和生成时间，不应随意分享。

## 10. 日常开发建议

一次常规开发循环可以是：

1. 确认 Node 版本满足要求。
2. 仅在 lockfile 变化或依赖异常时重新执行 `npm ci`。
3. 设置本次要使用的 `PI_CODING_AGENT_DIR`。
4. 启动 Web 或 Electron。
5. 在隔离 profile 中复现和验证功能。
6. 先运行与改动直接相关的测试。
7. 提交前执行完整门禁。
8. 用 `git status --short` 和 `git diff --check` 确认没有生成物、密钥或无关改动。

建议按功能选择开发入口：

- 纯 UI、API、会话读取、Markdown、文件预览：优先 `npm run dev`。
- 原生目录选择、窗口按钮、托盘、单实例、preload IPC：使用 `npm run electron:dev`。
- 安装包生命周期、动态端口、目标平台原生依赖：在目标平台执行打包验证。

## 11. 测试与质量检查

### 11.1 完整源码门禁

```bash
npm test
npx tsc --noEmit
npm run lint
git diff --check
```

这与项目 Quality CI 的核心顺序一致。

`npm test` 已明确限制测试目录和 `*.test.mjs`。不要用没有路径过滤的裸 `node --test` 代替它，否则可能误扫描 API 中名为 `test` 的 route、诊断脚本或生成目录。

### 11.2 运行单个测试

```bash
node --test lib/rpc-manager.test.mjs
node --test electron/main-lifecycle.test.mjs
```

选择与改动最接近的测试文件，之后再运行完整 `npm test`。

### 11.3 Manifest 检查

修改内置 Skills 或插件清单时额外运行：

```bash
npm run skills:manifest:check
npm run plugins:manifest:check
```

只有在确实要重新生成清单时，才运行不带 `:check` 的写入命令。

### 11.4 生产 Web 验证

先完整停止 `npm run dev` 和 Electron，再执行：

```bash
npm run build
npm run start
```

另一个终端执行：

```bash
curl -fsS http://127.0.0.1:30141/api/home
```

Windows PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:30141/api/home
```

不要在开发服务器运行时执行 `npm run build`。两者都会写 `.next/`，可能破坏正在运行的开发服务。

## 12. Electron 打包

本地功能开发通常不需要每次打包。只有涉及生产构建、资源包含、原生依赖、安装器或启动生命周期时才执行。

### 12.1 当前平台默认包

```bash
npm run electron:build
```

该命令依次生成图标、执行 Next.js production build，并调用 `electron-builder`。默认产物位于 `release/`：

- Windows：NSIS installer；
- macOS：DMG；
- Linux：AppImage。

项目包含原生依赖，正式包应尽量在目标 OS/CPU 上执行 `npm ci` 后构建。

### 12.2 Windows x64

推荐完整验证链：

```bash
npm ci
npm run electron:win:x64
```

只生成解包目录：

```bash
npm run electron:win:x64:dir
```

常规 Electron Builder 命令：

```bash
npm run electron:dir
npm run electron:portable
```

Windows release 脚本会处理 `release/`、生产依赖、解包目录验证和开发依赖恢复，不应与活动开发服务器并行运行。

### 12.3 包结构验证器

根据实际输出目录选择：

```bash
node scripts/verify-windows-package.mjs --dir release/win-unpacked
node scripts/verify-macos-package.mjs --dir release/mac-arm64 --arch arm64
node scripts/verify-macos-package.mjs --dir release/mac --arch x64
node scripts/verify-linux-package.mjs --dir release/linux-unpacked --arch x64
node scripts/verify-linux-package.mjs --dir release/linux-arm64-unpacked --arch arm64
```

本地/CI 构建通常未配置正式代码签名：Windows 可能触发 SmartScreen，macOS 可能触发 Gatekeeper。对外分发前需要在对应平台完成签名、公证和真实安装验证。

## 13. 局域网 Web 开发

默认服务仅监听 loopback，这是最安全的本地开发方式。只有明确需要其他设备访问时才使用 LAN 模式。

`dev:lan` 不会强制要求密码：`PI_WEB_PASSWORD` 为空时它仍会启动，并且完全没有认证。不要直接运行裸的 `npm run dev:lan`。

macOS / Linux，交互式隐藏输入并仅在密码非空时启动：

```bash
printf 'Temporary LAN password: '
IFS= read -r -s PI_WEB_PASSWORD
printf '\n'
export PI_WEB_PASSWORD
test -n "$PI_WEB_PASSWORD" && npm run dev:lan
```

Windows PowerShell，使用凭据对话框避免把密码写进历史：

```powershell
$credential = Get-Credential -UserName "pi" -Message "Temporary LAN password"
$env:PI_WEB_PASSWORD = $credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($env:PI_WEB_PASSWORD)) { throw "PI_WEB_PASSWORD is required" }
npm run dev:lan
```

说明：

- `dev:lan` 监听 `0.0.0.0:30141`。
- Basic Auth 用户名固定为 `pi`，密码为 `PI_WEB_PASSWORD`。
- HTTP Basic Auth 不加密任何流量。除了密码，会话、文件内容、模型配置和 API payload 也会以明文 HTTP 传输；必须配合 HTTPS 终止或可信 VPN。
- 不要直接暴露到公网。
- 使用自定义 hostname 时，通过 `PI_WEB_ALLOWED_HOSTS` 以逗号分隔显式允许。
- Host、Origin 和浏览器跨站请求检查仍会生效。

这不是只读页面。成功登录的远端操作者可以使用 Agent 工具执行 shell、读写工作区，并把服务账号有权访问的其他现有目录选为工作区。应把它视为“对单个受信任操作者开放的远程代码执行和主机文件权限入口”，而不是普通团队网站。

风险较高时还应使用独立 OS 用户、隔离的 `PI_CODING_AGENT_DIR` 和一次性工作区。Host/Origin 检查不是身份认证，不能替代密码、TLS 或 VPN。浏览器可能缓存 Basic Auth 凭据，不要在共享浏览器 profile 中登录。

建议按以下闭环操作：

1. 先在服务机访问 `http://127.0.0.1:30141`，确认浏览器要求 Basic Auth，并使用用户名 `pi` 登录。
2. 从系统网络设置或 `ipconfig` / `ifconfig` / `hostname -I` 查找服务机的私网 IPv4。
3. 只在操作系统防火墙的私有网络范围内允许 TCP `30141`。
4. 客户端访问 `http://<LAN-IP>:30141`，确认未认证时为 `401`、认证后才能进入。
5. 使用结束后停止服务，并清理临时密码。

macOS / Linux：

```bash
unset PI_WEB_PASSWORD
```

Windows PowerShell：

```powershell
Remove-Item Env:PI_WEB_PASSWORD
```

Electron 桌面服务固定只面向 `127.0.0.1`，并只会从继承的父进程环境中移除 `PI_WEB_PASSWORD`；如果 `.env.local` 又定义了它，Next.js 仍会重新启用认证并可能让 readiness 失败。LAN 访问应使用独立的 Web 模式，不要把 Electron 当作 LAN 服务入口。

## 14. 常用环境变量

| 变量 | 适用范围 | 说明 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | Web、Electron、Pi SDK | 覆盖默认 agent 数据目录 |
| `PORT` | Electron、发布后的 `pi-web` CLI | `npm run dev*` 已写死端口，不受它覆盖 |
| `PI_WEB_HOSTNAME` | 发布后的 `pi-web` CLI、请求 allow-list | `npm run dev*` 和 Electron 都有自己的固定监听参数 |
| `PI_WEB_ALLOWED_HOSTS` | Web 请求安全 | 额外允许的 hostname，逗号分隔 |
| `PI_WEB_PASSWORD` | Web / LAN | 开启 Basic Auth；Electron 仅移除继承的环境值，Next 仍可能从 `.env.local` 重新加载 |
| `PI_WEB_NO_OPEN` | 发布后的 `pi-web` CLI | 禁止生产 CLI 自动打开浏览器；源码 dev 不会自动打开 |
| `SKILLS_API_URL` | Skills 搜索与更新 | 覆盖默认 Skills API |
| `PI_ALPHA_DESK_NODE` | Electron | 显式指定兼容的独立 Node 可执行文件 |
| `POWERSHELL_PATH` | Windows Office 预览 | 覆盖 `powershell.exe` 路径 |
| `DOCX_CACHE_DIR` | DOCX 预览 | 覆盖 DOCX 转换缓存目录 |
| `PPTX_CACHE_DIR` | PPTX 预览 | 覆盖 PPTX 转换缓存目录 |
| `PDF_PAGE_CACHE_DIR` | PDF 预览 | 覆盖 PDF 页面缓存目录 |

## 15. 日志与诊断入口

### 15.1 Web

- 编译、API route、SDK 和 provider 错误：查看运行 `npm run dev` 的终端。
- 浏览器渲染错误：查看浏览器 DevTools Console 与 Network。
- 健康端点：`GET /api/home`。

### 15.2 Electron

- Electron 主进程与 Renderer 崩溃诊断：查看启动 Electron 的终端。
- Electron 自己启动 Next 服务时，stdout/stderr 同时写入：

```text
<Electron app.getPath("userData")>/pi-web-server.log
```

- 启动错误框会包含日志路径和末尾服务输出。
- Electron 复用外部 `npm run dev` 时不会创建一份新的服务日志；此时查看外部 Web 终端。
- `F12` 或 `Ctrl+Shift+I` 打开 Renderer DevTools。

## 16. 常见故障排查

### 16.1 `EADDRINUSE: address already in use 127.0.0.1:30141`

1. 请求 `http://127.0.0.1:30141/api/home`。
2. 查看端口对应 PID。
3. 如果是已经运行的本项目服务，让 Electron 复用即可。
4. 如果是其他程序，先确认来源，再停止它或换端口。
5. 双终端模式一定要等 Web 健康检查成功后再启动 Electron。

### 16.2 关闭窗口后端口仍被占用

- Electron 关闭窗口只是隐藏到托盘；从托盘执行 **Quit**。
- 双终端模式还需要停止外部 `npm run dev`。
- 不要直接把单实例行为误判为残留僵尸进程。

### 16.3 修改环境变量后仍在使用旧配置

Electron 可能复用了已经运行的 Next 服务。完整停止实际 Web 服务，再用新环境启动。只重启浏览器窗口或 Electron Renderer 不够。

### 16.4 Web 模式无法弹出目录选择器

这是预期行为。浏览器模式需要输入服务端本机路径；Electron 模式才提供原生目录选择器。

### 16.5 模型列表为空

依次检查：

1. 当前服务进程实际使用的 `PI_CODING_AGENT_DIR`。
2. 所选 cwd 是否存在且为目录。
3. provider 认证状态。
4. `models.json` 是否为合法 JSON。
5. 项目是否需要 trust 才能加载 provider/extension 资源。
6. 服务端终端是否有 SDK 或配置错误。

`/api/models` 在加载失败时可能返回空模型集合，因此只看前端空列表不足以定位原因。

### 16.6 `models.json` 损坏

读取接口会将无效内容降级为空配置。此时不要急着在模型设置里保存，否则可能用空配置覆盖原文件。先备份有效 agent 目录中的 `models.json`，再使用 JSON 校验工具修复语法。

### 16.7 OAuth 提示 `No pending login for token`

登录回调 token 只保存在当前服务进程内存中。开发服务重启、热重载或 SSE 断开后，原 token 会失效；重新发起登录流程即可。

### 16.8 断开连接后仍显示 provider 已配置

凭据可能来自环境变量或 `models.json`。断开连接只删除 `auth.json` 中类型匹配的记录。清理其他来源后，重启实际 Next 服务。

### 16.9 本地 Pi 快照提示 dirty tree

同步脚本要求 Pi 源码在构建前后都 clean。它不适合直接打包未提交的工作树；先检查差异并形成可复现 commit，再同步。

### 16.10 `--restore` 提示没有 manifest

当前机器还没有成功生成过 `.local-pi/snapshots`。先完整执行一次：

```bash
npm run pi:sync-local -- --source /absolute/path/to/pi
```

### 16.11 执行 `npm ci` 后本地 Pi 修改消失

这是预期行为：lockfile 会恢复 registry 包。需要本地快照时重新执行：

```bash
npm run pi:sync-local -- --restore
npm run pi:sync-local -- --verify
```

### 16.12 Electron 原生插件 ABI 不兼容

Electron 会寻找同平台、同架构且满足项目最低版本的独立 Node runtime。必要时显式指定：

macOS / Linux：

```bash
PI_ALPHA_DESK_NODE=/absolute/path/to/node npm run electron:dev
```

Windows PowerShell：

```powershell
$env:PI_ALPHA_DESK_NODE = "C:\Program Files\nodejs\node.exe"
npm run electron:dev
```

路径必须指向实际 Node 可执行文件，并与当前 OS/CPU 匹配。

### 16.13 `.next` 状态异常或页面持续报旧代码

先完整停止 Web 与 Electron，再确认当前目录确实是本仓库根目录：

```bash
git rev-parse --show-toplevel
```

macOS / Linux：

```bash
rm -rf .next
npm run dev
```

Windows PowerShell：

```powershell
Remove-Item -Recurse -Force .next
npm run dev
```

`.next` 是可再生构建目录；不要把相同做法套用到 `~/.pi/agent` 或其他用户数据目录。

### 16.14 DOCX / PPTX 预览只有文本或大纲

Windows 高保真转换依赖 PowerShell 和可用的 WPS/Office COM。检查 Office/WPS 是否安装、`POWERSHELL_PATH` 是否正确，以及服务端日志。无 COM 时回退预览属于预期行为。

### 16.15 LAN 访问返回 401 或 403

- `401`：检查 Basic Auth 用户名是否为 `pi`、密码是否与 `PI_WEB_PASSWORD` 一致。
- `403`：检查 Host/Origin、安全代理，以及自定义 hostname 是否加入 `PI_WEB_ALLOWED_HOSTS`。
- 不要通过关闭安全检查或使用通配 CORS 来绕过问题。

## 17. 安全恢复与重置

### 17.1 依赖恢复

```bash
npm ci
```

这会按 lockfile 重建依赖，并恢复 registry Pi SDK。若仍需要本地 Pi 快照，随后执行 `--restore` 与 `--verify`。

### 17.2 隔离 profile 重置

先从托盘完整 Quit Electron，并停止所有外部 Web 服务。然后核对你此前设置的 `PI_CODING_AGENT_DIR`，确认目标是隔离目录，绝不是日常使用的 `~/.pi/agent`。如果使用了隔离 profile，优先把目录改名保留：

macOS / Linux：

```bash
if [ -e "$HOME/.pi-alpha-desk-dev.backup" ]; then
  echo "Backup target already exists; choose another name."
else
  mv "$HOME/.pi-alpha-desk-dev" "$HOME/.pi-alpha-desk-dev.backup"
fi
```

Windows PowerShell：

```powershell
$sourceProfile = "$HOME\.pi-alpha-desk-dev"
$backupProfile = "$HOME\.pi-alpha-desk-dev.backup"
if (Test-Path $backupProfile) { throw "Backup target already exists; choose another name." }
Move-Item $sourceProfile $backupProfile
```

确认备份内容不再需要后，再自行决定是否清理。session 文件可能包含提示词、文件内容和工具输出，应按敏感数据处理。

### 17.3 不要随意重置的内容

- `~/.pi/agent/auth.json`；
- `~/.pi/agent/sessions/`；
- `~/.pi/agent/settings.json`；
- 项目内 `.pi/` 与 `.agents/`；
- 有未提交修改的 Git worktree。

## 18. 首次运行验收清单

- [ ] `node --version` 不低于 `22.19.0`。
- [ ] `npm ci` 成功完成。
- [ ] 已明确选择复用还是隔离 `PI_CODING_AGENT_DIR`。
- [ ] `GET /api/home` 返回 2xx 和正确 home 路径。
- [ ] 能选择一个存在的项目目录。
- [ ] 能在“设置 → 模型”看到或添加 provider。
- [ ] 模型连接测试符合预期，并知晓它会产生真实 API 请求。
- [ ] 发送第一条消息后，会话写入预期的 agent profile。
- [ ] Electron 功能开发时，原生目录选择、托盘和 DevTools 可用。
- [ ] `npm test`、`npx tsc --noEmit`、`npm run lint` 通过。
- [ ] `git diff --check` 通过，`git status --short` 中没有密钥或生成物。

## 19. 命令速查

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 严格按 lockfile 安装/恢复依赖 |
| `npm run dev` | Webpack Web 开发服务 |
| `npm run dev:turbo` | Turbopack Web 开发服务 |
| `npm run electron:dev` | Electron 开发模式 |
| `npm test` | 完整源码测试集 |
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm run skills:manifest:check` | 检查内置 Skills manifest |
| `npm run plugins:manifest:check` | 检查内置插件 manifest |
| `npm run pi:sync-local -- --source <path>` | 构建并安装本地 Pi 快照 |
| `npm run pi:sync-local -- --verify` | 验证当前本地 Pi 快照 |
| `npm run pi:sync-local -- --restore` | 恢复最近生成的本地 Pi 快照 |
| `npm run build` | Next.js production build；必须先停 dev |
| `npm run start` | 启动 production Web 服务 |
| `npm run electron:build` | 为当前平台构建 Electron 包 |
| `npm run electron:win:x64` | 完整 Windows x64 发布验证链 |

## 20. 相关文档

- [项目中文说明](../README.zh-CN.md)
- [架构与核心流程](./architecture-and-core-flows.zh-CN.md)
- [Worktree 使用说明](./worktrees.zh-CN.md)
- [本地 Pi 快照历史更新记录](./local-pi-update-2026-08-03.md)
- [桌面性能基线](./desktop-performance-baseline-2026-08-09.md)
- [Windows x64 构建说明](./github-build-windows.md)
- [项目开发约束](../AGENTS.md)
