# GitHub Pull Request 安全合并操作手册

本文记录 2026-08-19 将 [PR #12](https://github.com/happyzengfen/pi-alpha-desk/pull/12) 合并到 `main` 的实际操作，并整理为后续可复用的合并流程。

## 目标

- 在不影响当前开发分支和本地未推送提交的前提下审查 PR。
- 不绕过失败的 CI；先定位并修复根因。
- 只合并经过验证的精确 head SHA，避免检查完成后 PR 内容被替换。
- 合并后单独记录 merge commit、验证结果、已知限制和回退方式。
- 最终确认远端 `main` 和三平台 Quality 状态。

## 前置条件

```bash
gh --version
gh auth status
git status --short --branch
git remote -v
```

确认事项：

- `gh` 已登录，并具备仓库和 Actions 读取权限。
- 明确当前分支是否有未推送提交或未提交改动。
- 不在存在用户改动的工作树中直接切换、重置或合并 PR。
- 已确认 PR 的目标仓库、编号和目标分支。

## 操作步骤

### 1. 确认唯一目标 PR

```bash
gh pr list \
  --repo happyzengfen/pi-alpha-desk \
  --state open \
  --json number,title,headRefName,baseRefName,mergeable,statusCheckRollup,url

gh pr view 12 \
  --repo happyzengfen/pi-alpha-desk \
  --json title,body,author,baseRefName,headRefName,headRepository,commits,files,mergeable,mergeStateStatus,url
```

本次确认结果：

- 唯一开放 PR：`#12`。
- 来源分支：`m0rcy/agent/v11-preview-toolbar`。
- 目标分支：`happyzengfen/pi-alpha-desk:main`。
- 原始 head：`b736c1024cc89ff8a10ea816bb0448a4cf30c037`。
- PR 可合并，但 Ubuntu、macOS、Windows Quality 均失败。

### 2. 检查 CI 失败根因

先查看检查状态，再读取失败的 Actions 日志：

```bash
gh pr checks 12 --repo happyzengfen/pi-alpha-desk

gh run view <run-id> \
  --repo happyzengfen/pi-alpha-desk \
  --log-failed
```

本次三个平台的失败根因相同：

```text
'0.8.7' !== '1.0.0'
```

PR 只把 `package.json` 更新为 `1.0.0`，遗漏了：

- `package-lock.json`
- `bundled-skills/manifest.json`
- `bundled-plugins/manifest.json`

### 3. 创建隔离 worktree

先取得 `main` 和 PR head：

```bash
git fetch origin main pull/12/head:refs/remotes/origin/pr/12
```

创建临时目录和隔离分支：

```bash
merge_worktree="$(mktemp -d /tmp/pi-alpha-pr12.XXXXXX)"

git worktree add \
  "$merge_worktree" \
  -b codex/pr12-integration \
  origin/pr/12
```

后续审查、安装依赖、修改、测试和提交都在该 worktree 中进行。原工作区继续停留在原分支，因此不会覆盖本地提交。

### 4. 审查 PR 差异

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --find-renames origin/main...HEAD
```

除版本不一致外，本次审查还发现：

- 图片放大仍被 `maxWidth: 100%` 限制，超过 100% 不会真正变大。
- 新工具栏硬编码中文，没有接入现有英文/简体中文 i18n。
- DOC/DOCX COM 不可用时没有回退到原有 HTML/文本预览。
- 对用户已打开的 Word 文档直接调用 `SaveAs`，可能改变文档名称或关联状态。
- 图片预览没有刷新按钮，却仍启动文件变更轮询。

修复原则是只处理 PR 引入或直接暴露的问题，不重构相邻组件。

### 5. 应用聚焦修复

本次合并前修复包括：

- 将锁文件和两份 bundled manifest 同步到 `1.0.0`。
- 图片手动缩放模式使用 `maxWidth: none`。
- `PreviewToolbar` 接入 `useI18n()`，补齐中英文键。
- 工具栏没有刷新能力时停止文件变化轮询。
- `PdfViewer` 收到转换器 `501` 时允许 Word 预览回退到原有 HTML/文本路径。
- 用户已打开的 Word 文档使用 `ExportAsFixedFormat`；只有一次性磁盘副本可以回退到 `SaveAs`。
- 增加图片缩放、i18n、Word 回退和非破坏性导出的回归测试。

### 6. 在干净依赖环境验证

```bash
npm ci
npm test
node_modules/.bin/tsc --noEmit
npm run lint
git diff --check
```

本次本地结果：

- `npm test`：372/372 通过，共 13 个 suite。
- TypeScript：通过。
- lint：0 error；保留 `PdfViewer.tsx` 的 3 条既有 warning。
- `git diff --check`：通过。
- 未运行 `next build`，避免在开发工作区污染 `.next/`。

### 7. 只提交本次修复文件

不要在混合工作树中使用未经确认的 `git add -A`。显式列出目标文件：

```bash
git add \
  bundled-plugins/manifest.json \
  bundled-skills/manifest.json \
  components/FileViewer.tsx \
  components/PdfViewer.tsx \
  components/PreviewToolbar.tsx \
  components/PreviewToolbar.test.mjs \
  lib/docx-convert-tool.ts \
  lib/docx-convert-tool.test.mjs \
  lib/i18n/messages/en.ts \
  lib/i18n/messages/zh-CN.ts \
  package-lock.json

git commit -m "Fix PR 12 release consistency and preview fallbacks"
```

修复提交：

```text
c94e9f4e5e615fd4d3873ef76270dff01fafd290
```

### 8. 将修复推回 PR 来源分支

先确认 PR 允许 maintainer 修改：

```bash
gh api repos/happyzengfen/pi-alpha-desk/pulls/12 \
  --jq '{maintainer_can_modify: .maintainer_can_modify, head_repo: .head.repo.full_name, head_ref: .head.ref}'
```

然后将当前提交推送到来源分支：

```bash
git push <fork-remote> HEAD:agent/v11-preview-toolbar
```

本次来源仓库是 fork，因此没有把修复误推到目标仓库的临时分支。

### 9. 等待 PR 三平台检查

```bash
gh pr checks 12 \
  --repo happyzengfen/pi-alpha-desk \
  --watch \
  --interval 10
```

本次 PR Quality 结果：

- Ubuntu 24.04：通过，1 分 46 秒。
- macOS 15：通过，2 分 03 秒。
- Windows 2025：通过，3 分 21 秒。

### 10. 锁定精确 head SHA 后合并

重新读取 GitHub 上的实际 head SHA：

```bash
verified_head="$(gh pr view 12 \
  --repo happyzengfen/pi-alpha-desk \
  --json headRefOid \
  --jq .headRefOid)"
```

使用 `--match-head-commit` 防止合并未经检查的新提交：

```bash
gh pr merge 12 \
  --repo happyzengfen/pi-alpha-desk \
  --merge \
  --match-head-commit "$verified_head"
```

本次第一次命令手工填写了错误的完整 SHA，GitHub 返回 `Head branch was modified` 并拒绝合并。重新读取准确 SHA 后才成功执行。这说明 head 锁定保护按预期工作。

实际合并结果：

```text
verified head: c94e9f4e5e615fd4d3873ef76270dff01fafd290
merge commit: 3856ba3a6c245e46a16c96cbf4f7465db2788813
```

### 11. 获取实际 merge commit 并写同步记录

```bash
git fetch origin main

gh pr view 12 \
  --repo happyzengfen/pi-alpha-desk \
  --json state,mergedAt,mergedBy,mergeCommit,headRefOid,url
```

同步记录应至少包含：

- PR URL、来源分支和目标分支。
- 合并前基线、已验证 head 和 merge commit。
- 主要功能、合并前修复和版本变化。
- 本地验证和 GitHub Actions 结果。
- 未执行的实机验证与回退方式。
- 可复用的合并操作步骤。

本次同步记录提交：

```text
eac16d63fa14e55cf4bd64ad6c21b7ac309886f1
```

### 12. 验证最终 main

```bash
git ls-remote origin refs/heads/main

gh run list \
  --repo happyzengfen/pi-alpha-desk \
  --branch main \
  --workflow Quality \
  --limit 3

gh run watch <main-quality-run-id> \
  --repo happyzengfen/pi-alpha-desk \
  --exit-status
```

最终远端状态：

```text
main: eac16d63fa14e55cf4bd64ad6c21b7ac309886f1
```

[最终 main Quality run 32262747784](https://github.com/happyzengfen/pi-alpha-desk/actions/runs/32262747784) 三个平台全部通过：

- Ubuntu 24.04：1 分 43 秒。
- macOS 15：1 分 59 秒。
- Windows 2025：3 分 13 秒。

### 13. 清理临时 worktree

确认临时工作树没有未提交内容后清理：

```bash
git worktree remove "$merge_worktree"
git worktree list
```

删除临时分支前先确认其提交已经进入 `origin/main`：

```bash
git merge-base --is-ancestor codex/pr12-integration origin/main
```

只有该命令返回成功时，才删除自己创建的临时分支。不要删除用户原有分支。

## 最终检查清单

- [x] PR 目标、来源和唯一性已确认。
- [x] 当前工作区和未推送提交未被改写。
- [x] 失败 CI 的日志和根因已确认。
- [x] 修复范围只覆盖 PR 直接问题。
- [x] 本地测试、类型、lint 和空白检查已完成。
- [x] 修复提交已推回 PR 来源分支。
- [x] 三平台 PR Quality 全部通过。
- [x] 合并命令锁定精确 head SHA。
- [x] PR 状态和 merge commit 已复核。
- [x] 同步记录已单独提交到 `main`。
- [x] 最终 `main` 三平台 Quality 全部通过。
- [x] 临时 worktree 已清理。
- [x] 用户当前分支和原有提交保持不变。

## 已知限制

- 本机为 macOS，没有执行真实 Word/WPS COM 人工预览 smoke。
- Windows Quality 覆盖源码测试、类型、lint 和空白检查，但不能替代安装了 Microsoft Word 或 WPS 的实际交互验证。
- 本次没有构建 Electron 安装包，也没有执行正式发布流程。
