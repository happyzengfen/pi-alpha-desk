# GitHub Actions：Windows x64 构建指南

## 概览

本项目使用 GitHub Actions 在云端 Windows 环境中自动完成：

1. 安装依赖 → 运行测试 → TypeScript 检查 → Lint
2. 构建 Windows x64 安装包（NSIS installer + portable .exe）
3. 验证构建产物为合法 x64 PE 可执行文件
4. 烟雾测试：启动打包后的应用，等待 `/api/home` 就绪
5. 上传 artifacts（所有触发方式均执行）
6. 创建 GitHub Release 并附上安装包（仅 tag 触发时执行）

---

## 触发方式

### 方式一：手动触发（推荐用于测试）

1. 打开 [Actions 页面](https://github.com/happyzengfen/pi-alpha-desk/actions)
2. 左侧选择 **Windows x64**
3. 点击 **Run workflow** → 选择 `main` 分支 → **Run workflow**
4. 等待约 20–40 分钟
5. 构建完成后，在该次运行页面底部的 **Artifacts** 区域下载 `windows-x64.zip`

### 方式二：推送版本 tag（自动发布 Release）

```bash
# 1. 更新 package.json 中的版本号
npm version patch --no-git-tag-version   # 例如 0.7.16 → 0.7.17

# 2. 提交版本变更
git add package.json package-lock.json
git commit -m "chore: bump version to v0.7.17"

# 3. 打 tag 并推送
git tag v0.7.17
git push origin main
git push origin v0.7.17
```

推送 tag 后，Actions 自动触发构建。构建成功后会在
[Releases 页面](https://github.com/happyzengfen/pi-alpha-desk/releases)
创建一个新 Release，并附上：

| 文件 | 说明 |
|------|------|
| `数字化AI助手 Setup X.X.X.exe` | NSIS 安装程序（推荐） |
| `数字化AI助手-X.X.X-portable.exe` | 免安装便携版 |
| `latest.yml` | electron-updater 自动更新清单 |

---

## 构建产物说明

| 产物 | 用途 |
|------|------|
| `*Setup*.exe` | 标准 Windows 安装程序，含注册表项和开始菜单快捷方式 |
| `*portable.exe` | 单文件便携版，无需安装，双击即用 |
| `*.blockmap` | 差量更新块映射（供自动更新使用） |
| `latest.yml` | 自动更新元数据 |

---

## 查看构建日志

1. 进入 [Actions](https://github.com/happyzengfen/pi-alpha-desk/actions) → 找到对应的运行记录
2. 点击 **build-and-smoke-test** Job
3. 展开各步骤查看详细日志

常见耗时步骤：

| 步骤 | 预计耗时 |
|------|---------|
| Install dependencies | 3–8 分钟（有 cache 更快） |
| Build Windows x64 packages | 10–20 分钟 |
| Smoke test | 最长 90 秒 |

---

## 常见问题

### 构建失败：测试不通过

查看 **Run tests** 步骤的输出，在本地复现：

```bash
npm test
```

### 构建失败：TypeScript 错误

```bash
./node_modules/.bin/tsc --noEmit
```

### 烟雾测试超时

日志中会打印 `%APPDATA%\pi-web-server.log` 的最后 200 行。常见原因：

- Next.js 构建产物不完整（检查 **Build Windows x64 packages** 步骤是否有报错）

### Release 没有被创建

Release 只在 **tag 触发**时创建，手动 `Run workflow` 不会创建 Release。
确认 tag 格式以 `v` 开头（如 `v0.7.17`），且已推送到远端：

```bash
git push origin v0.7.17
```

---

## 无需配置任何 Secrets

工作流使用 `secrets.GITHUB_TOKEN`，这是 GitHub 为每次 Actions 运行自动注入的令牌，
**无需在仓库 Settings 中手动添加任何 Secret**。
