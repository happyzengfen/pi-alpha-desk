# 构建、安装与发布说明

当前应用版本为 **1.0.0**，四个核心 Pi SDK 固定为 **0.87.1**。版本来源为 `package.json` 和 `package-lock.json`；应用版本与 SDK 版本分别管理。

## 构建前准备

- Node.js `>=22.19.0`、npm、Git；macOS 桌面包需要在 macOS 上构建。
- Apple Silicon 使用 `arm64`，Intel Mac 使用 `x64`。`uname -m` 可以查看本机架构。
- 在单独的 checkout 或源码副本中构建。生产构建会写入 `.next/`，不要在运行开发服务器的同一目录执行。
- 使用当前源码和锁文件；修改图标后必须重新运行 `npm run icons`。

在构建目录执行：

```bash
npm ci
npm test
npx tsc --noEmit
npm run lint
npm run plugins:manifest:check
npm run skills:manifest:check
git diff --check
```

`npm ci` 安装 registry 版 SDK。只有需要验证本地 Pi 源码时才使用 `pi:sync-local`；相关说明见 README 的“本地 pi 快照”。不要为普通打包手动恢复历史快照。

## Apple Silicon / macOS arm64

以下命令生成本地未配置 Developer ID 签名的安装包，不上传发布：

```bash
npm run icons
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
  --mac dmg --arm64 --publish never \
  --config.directories.output=release/macos-arm64
```

产物：

```text
release/macos-arm64/数字化AI助手-1.0.0-arm64.dmg
release/macos-arm64/mac-arm64/数字化AI助手.app
```

`directories.output` 可以替换为不同的日期目录，保留前次构建。不要误用 `npm run release` 来做本地打包：该命令还会修改应用版本并发布 npm 包。

构建机已经有完整、同版本、同架构的 Electron 时，可以在打包命令追加 `--config.electronDist=node_modules/electron/dist`，复用 npm 安装的 Electron。普通构建无需此参数。

### 验证安装包

```bash
node scripts/verify-macos-package.mjs \
  --dir release/macos-arm64/mac-arm64 --arch arm64
hdiutil verify release/macos-arm64/数字化AI助手-1.0.0-arm64.dmg
shasum -a 256 release/macos-arm64/数字化AI助手-1.0.0-arm64.dmg
```

包校验会检查 Mach-O 架构、主进程与 preload、Next/Pi 运行依赖、内置插件、技能和图标。还需要实际启动 `.app`，确认窗口和聊天输入区可用，检查会话浏览、模型设置和 HTML 导出。启动成功不代表所有 provider 或第三方插件已经完成端到端验证。

测试时可使用临时 `PI_CODING_AGENT_DIR`，避免混入日常会话和配置。项目 CI 另有独立 user-data 目录的启动验证；普通安装应使用默认配置。

### 安装与替换

1. 从应用菜单或托盘选择退出；仅关闭窗口会隐藏到托盘。
2. 保留现有 `.app` 的备份，打开 DMG，将新应用拖入“应用程序”。
3. 从“应用程序”启动，确认首页与现有会话可以加载。

应用默认数据目录为 `~/.pi/agent`，替换 `.app` 不需要删除它。需要回退时先退出应用，再恢复备份的 `.app`。本地构建未配置 Developer ID 签名和 Apple notarization；对外分发流程需另外配置签名、公证并验证安装。

## 其他平台与 GitHub Actions

- **Windows x64**：使用 `npm run electron:win:x64`；完整说明见 [Windows 构建文档](./github-build-windows.md)。
- **Desktop packages**：手动触发 `.github/workflows/macos-arm64.yml`，覆盖 macOS arm64/x64 DMG 与 Linux arm64/x64 AppImage，执行包校验和实际启动验证后上传 Actions artifacts。
- **Quality**：PR 和 `main` 推送运行 Ubuntu、Windows、macOS 的测试、TypeScript 和 lint 检查。

`release/`、`node_modules/`、`.next/` 和 `.local-pi/` 均不作为源码提交。推送代码与发布二进制安装包是不同操作；GitHub Release 资产需要单独发布。本地日志、测试账号目录和机器路径也不应加入公开文档。

## 2026-09-23 已验证构建

- 应用 **1.0.0** / Pi **0.87.1** / Electron **43.2.0**。
- 本机构建环境：Apple Silicon、macOS **26.5.2**、Node.js **24.15.0**。
- DMG 约 **311 MiB**；架构、运行资源和磁盘镜像校验通过。
- 实际 Electron 窗口、聊天输入区、目录选择桥接、主要接口及会话 HTML 导出通过。
- 构建中的会话导出动态 import 警告仍存在，实际导出返回 200；未进行真实模型调用或 Windows 实机测试。

本次更新内容与安装包 SHA-256 见 [CHANGELOG](./CHANGELOG.md#pi-0871-升级与-macos-arm64-重新构建2026-09-23)。
