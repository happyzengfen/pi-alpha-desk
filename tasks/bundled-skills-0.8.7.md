# Bundled Skills 整理与 0.8.7 版本任务

> 状态：已完成
> 日期：2026-08-11
> 基线：`0.8.6-f` → `0.8.7`

## 目标

将适合桌面端默认交付的 Skills 整理为可追溯、可验证、可安全更新的 Electron 内置资源，并同步重建应用版本信息。

## 候选结论

| 处理 | Skills | 理由 |
| --- | --- | --- |
| 继续内置 | `guizang-ppt-skill`、`office-viewer`、`pdf`、`windows-word-docx` | 直接覆盖演示文稿、Office/PDF 读取和 Windows 离线 DOCX；资源完整，来源可记录 |
| 不默认内置 | `aihot`、`brave-search`、`tavily-search`、Futu 系列 | 绑定外部 API、账号、实时网络或特定业务域 |
| 不默认内置 | `bird`、OpenCLI 系列、微信工具、`x-content-archiver` | 需要额外 CLI、Bun/Chrome、登录态或较大依赖树 |
| 保留为用户选装 | `cangjie-skill`、`edge-tts` 及其他个人方法论 Skills | 有价值，但不是 Pi Alpha Desk 的最小办公交付面 |

## 执行清单

- [x] 盘点本机 Pi agent 实际 Skills 及仓库内置机制。
- [x] 确定四个默认 bundled skills，不引入新的网络凭据或运行时要求。
- [x] 删除 Skill 运行时不需要的上游仓库级杂项，保留许可证和来源声明。
- [x] 为四个 Skills 补齐或校正 `agents/openai.yaml` UI 元数据。
- [x] 生成 `bundled-skills/manifest.json`，记录应用版本、来源、许可证、平台和内容 SHA-256。
- [x] 将 `package.json`、`package-lock.json` 与 README 当前基线同步到 `0.8.7`。
- [x] 验证 Skill frontmatter、manifest 新鲜度、Electron 安装/保留行为、TypeScript、Lint 和 diff check。

## 验收标准

1. Electron 包中只有 manifest 列出的四个 Skills，每个都有合法的 `SKILL.md` frontmatter。
2. manifest 与 `package.json` 版本及实际 Skill 内容哈希一致；内容变更后检查必须失败，直到重建 manifest。
3. 已安装但用户修改过的 Skill 仍被保留；未修改的应用管理副本可更新。
4. 当前版本的单一来源仍是 `package.json`；Next.js 与 Electron 产物继续从该值注入/命名。

## 验证命令

```bash
npm run skills:manifest:check
uv run --with pyyaml python /Volumes/WorkSSD/workzf/codex-data/skills/.system/skill-creator/scripts/quick_validate.py bundled-skills/<skill>
node --test electron/bundled-skills.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
git diff --check
```

完成结果：四个 Skill 规范检查通过；manifest 与 `0.8.7` 及内容哈希一致；完整测试 364 项通过；TypeScript、Lint 和 `git diff --check` 通过。

## 回滚

可独立回退 bundled skill 内容整理、manifest/校验脚本和 `0.8.7` 版本同步；不需要改动 session、SDK、SSE 或桌面 UI 路径。
