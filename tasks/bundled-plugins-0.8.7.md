# Bundled Plugins 同步与本机安装任务

> 状态：已完成
> 日期：2026-08-11
> 应用版本：`0.8.7`

## 目标

对齐仓库内置 package plugins、本机 Pi agent 插件和桌面包验证，避免重复工具、原生依赖和凭据绑定被默认带入每个安装包。

## 打包决策

| 处理 | 插件 | 理由 |
| --- | --- | --- |
| 继续随包 | `pi-subagents@0.37.0` | 通用子代理与并行任务 |
| 继续随包 | `pi-mcp-adapter@2.21.2` | 当前应用已验证的 MCP 连接层 |
| 继续随包 | `pi-web-access@0.20.0` | 通用 Web 搜索与内容访问，未配置凭据时不强制使用 |
| 继续随包 | `@juicesharp/rpiv-ask-user-question@2.4.0` | 结构化用户提问 |
| 继续随包 | `@narumitw/pi-goal@0.50.0` | 显式触发的目标执行 |
| 仅保留本机 | `@mammothb/pi-office@0.1.7` | `read_pdf` 与应用内置工具重名，默认打包会产生覆盖顺序风险 |
| 仅保留本机 | `pi-knowledge@0.8.1` | 含 `better-sqlite3`、Tree-sitter 和本地模型依赖，需要独立跨平台/体积验收 |
| 仅保留本机 | `pi-mcp-extension@1.5.0` | 与已随包的 `pi-mcp-adapter` 功能重叠，不同 MCP 配置体系不应默认并存 |
| 新安装到本机 | `@tifan/pi-inline-skills@1.0.5` | 无额外依赖，改善输入框中的 Skill 发现和显式调用 |
| 暂不安装 | `@gotgenes/pi-permission-system@25.0.0` | 会改变所有工具、Shell、MCP 和路径权限；需要先评审全局 policy |

## 执行清单

- [x] 盘点本机 `settings.json` 和 npm package 版本，不读取或输出凭据。
- [x] 确认五个现有 bundled plugins 与 `package.json` 精确版本一致。
- [x] 安装 `@tifan/pi-inline-skills@1.0.5` 到当前 Pi agent 环境。
- [x] 生成 `bundled-plugins/manifest.json`，记录应用版本、插件版本、许可证和 npm integrity。
- [x] 让 Windows、macOS 和 Linux 包验证要求插件 manifest 存在。
- [x] 验证插件加载、manifest、完整测试、TypeScript、Lint 和 diff check。

## 验证命令

```bash
npm run plugins:manifest:check
node --test lib/bundled-pi-packages.test.mjs
npm test
node_modules/.bin/tsc --noEmit
npm run lint
git diff --check
```

完成结果：五个 bundled plugins 均从 manifest 加载，精确版本与 `package-lock.json` integrity 一致；本机 `inline-skills@1.0.5` 安装成功；完整测试 364 项、TypeScript、Lint 和 diff check 通过。

## 回滚

仓库 manifest/打包验证可独立回退。本机新插件可用 `pi remove npm:@tifan/pi-inline-skills@1.0.5` 移除；本次未改动现有 Office、Knowledge 或 MCP 配置。
