# 数字化AI助手

<p align="center">
  <img src="./public/favicon.svg" alt="数字化AI助手" width="128" />
</p>

<p align="center">
  An Electron-first desktop client for the <a href="https://github.com/earendil-works/pi">pi coding agent</a>.
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a>
  ·
  <a href="https://github.com/happyzengfen/pi-alpha-desk/releases">Releases</a>
  ·
  <a href="https://github.com/happyzengfen/pi-alpha-desk/issues">Issues</a>
</p>

## Overview

数字化AI助手 (`@happyzengfen/pi-alpha-desk`) is a desktop-focused derivative of upstream [pi-web](https://github.com/agegr/pi-web) `v0.7.16`. It provides a visual workspace for local pi sessions while preserving compatibility with pi's session storage, models, authentication, skills, plugins, and theme formats.

This repository is not an upstream mirror. It prioritizes its own desktop experience and selectively adopts upstream SDK compatibility, security, correctness, and reliability improvements.

### Current baseline

| Area | Version |
| --- | --- |
| Application | `1.0.0` |
| Node.js | `>=22.19.0` |
| Next.js | `16.3.0` |
| React | `19.2.x` |
| Electron | `43.x` |
| pi SDK registry fallback | `0.87.1` |

The 2026-09-23 update upgrades the Pi SDK from `0.85.1` to `0.87.1`, adapts tool-free prompts and session history, and updates source snapshot builds. The macOS arm64 package was rebuilt and checked in a running Electron window. See the [changelog](./docs/CHANGELOG.md#pi-0871-升级与-macos-arm64-重新构建2026-09-23) and [release guide (Chinese)](./docs/release.md).

## Highlights

- **Local session workspace** — browse, rename, delete, fork, branch, export, and resume pi JSONL sessions.
- **Real-time conversations** — per-session SSE streaming, reconnect and running-state recovery, compaction support, tool output, thinking display, and process timelines.
- **Desktop-first shell** — frameless window, custom title bar, native folder picker, system tray, single-instance behavior, and automatic local-port fallback.
- **Project and Git tools** — file explorer, fuzzy file search, Git status and diff views, quick changes, and Git worktree management.
- **Rich file preview** — source code, diffs, images, audio, PDF, and DOCX files.
- **Model and authentication management** — configure models, test providers, manage API keys, and complete supported OAuth or device-code login flows.
- **Skills and plugins** — inspect loaded resources, search and install skills, manage package plugins, and protect project resources with a trust gate.
- **Rich Markdown** — GitHub-flavored Markdown, syntax highlighting, Mermaid diagrams, KaTeX math, and sanitized embedded HTML.
- **Themes and localization** — pi / PI-TUI JSON themes, dark/light/system modes, English, and Simplified Chinese.

## Screenshots

Main workspace (dark and light modes):

![Main workspace: sessions, projects, and file explorer](./docs/screenshots/home.png)

Chat with multi-step process groups:

![Chat with process groups](./docs/screenshots/chat.png)

Process steps grouped by tool call:

![Multi-step process groups](./docs/screenshots/blocks.png)

File diff preview:

![File diff preview](./docs/screenshots/diff.png)

## Install and run

### Windows x64 desktop app

Download the NSIS installer or portable executable from [GitHub Releases](https://github.com/happyzengfen/pi-alpha-desk/releases):

- `数字化AI助手 Setup <version>.exe` — standard installer
- `数字化AI助手-<version>-portable.exe` — portable executable

The Windows release workflow targets x64. The manually triggered **Desktop packages** workflow also builds macOS DMGs and Linux AppImages for arm64 and x64.

Unsigned development builds may trigger Windows SmartScreen. Verify the download source before choosing **More info → Run anyway**.

### macOS Apple Silicon desktop app

On an Apple Silicon Mac, build the native arm64 package in a checkout without an active development server:

```bash
npm ci
npm run icons
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --publish never
node scripts/verify-macos-package.mjs --dir release/mac-arm64 --arch arm64
hdiutil verify release/*.dmg
```

This produces `release/数字化AI助手-1.0.0-arm64.dmg` and `release/mac-arm64/数字化AI助手.app`. Quit an existing installation before opening the DMG and dragging the app to Applications. These local builds have no Developer ID signing or notarization. See the [release guide (Chinese)](./docs/release.md) for isolated build directories, installation, and runtime checks.

### Run from source

Requirements:

- Node.js `>=22.19.0`
- npm
- An existing pi configuration, or provider credentials configured from the application

```bash
npm install
npm run dev
```

Open [http://localhost:30141](http://localhost:30141). The default development command uses Webpack; Turbopack is available with `npm run dev:turbo`.

To run the Electron shell in development:

```bash
npm run electron:dev
```

## Desktop behavior

- The Electron app serves its UI only on `127.0.0.1`.
- If the default port `30141` is already occupied, a packaged app automatically selects another available local port.
- Closing the window hides it to the tray. Use the tray's **Quit** action to exit completely.
- Startup diagnostics are written to `pi-web-server.log` in the Electron application-data directory.
- Five general-purpose Pi plugins are bundled as exact application dependencies: subagents, MCP, web access, structured questions, and goals. Their versions and npm integrity values are recorded in `bundled-plugins/manifest.json`.
- Bundled starter skills are copied to `~/.pi/agent/skills/` when missing. Existing user copies are preserved. The current skill list, source, license, platform, and content hashes are recorded in `bundled-skills/manifest.json`.

## Data, sessions, and project access

- **Agent data directory** — defaults to `~/.pi/agent/`; set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Session files** — stored under `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` by default.
- **Model configuration** — the Models panel reads and writes `models.json` in the active pi agent directory.
- **Fork vs branch** — Fork creates a new `.jsonl` session file; **Edit from here** creates another branch inside the same session file.
- **File access** — browsing and preview are restricted to session working directories, resolved project roots, generated `~/pi-cwd-*` directories, and explicitly allowed roots.
- **Project trust** — project extensions, packages, prompts, and `.agents/skills` resources must be trusted before the SDK loads or executes them.
- **Git worktrees** — sessions from a main checkout and linked worktrees remain grouped by project root. See [Worktrees in pi-web](./docs/worktrees.md).

## Themes

数字化AI助手 reads pi-compatible theme JSON files from:

```text
~/.pi/agent/themes/       # global themes
<project>/.pi/themes/     # project themes
```

See the [official pi theme documentation](https://pi.dev/docs/latest/themes) for the complete schema and color definitions.

Themes are grouped by base name. Pair `-dark.json` and `-light.json` files to provide matching variants:

```text
gruvbox-dark.json
gruvbox-light.json
```

A single `<theme-name>.json` file is also supported. If the requested variant is missing, the application falls back to the single file or the opposite variant.

Example theme pairs are available in [`docs/themes/`](./docs/themes/):

- `gruvbox-dark.json` / `gruvbox-light.json`
- `solarized-dark.json` / `solarized-light.json`

## Web and LAN access

The web server listens on `127.0.0.1` by default. Do not expose it to an untrusted network.

For an intentional LAN setup:

```bash
PI_WEB_PASSWORD='replace-with-a-strong-password' npm run dev:lan
```

Basic Auth uses username `pi` and the value of `PI_WEB_PASSWORD` as the password. HTTP Basic Auth does not encrypt credentials, so use HTTPS termination or a trusted VPN. Host and browser-origin checks remain enforced; use `PI_WEB_ALLOWED_HOSTS` for additional explicit hostnames when necessary.

Common runtime variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port; default `30141` |
| `PI_WEB_HOSTNAME` | Bind and allowed hostname; CLI default `127.0.0.1` |
| `PI_WEB_ALLOWED_HOSTS` | Additional comma-separated allowed hostnames |
| `PI_WEB_PASSWORD` | Enables Web/LAN Basic Auth |
| `PI_WEB_NO_OPEN` | Prevents the npm CLI from opening a browser |
| `PI_CODING_AGENT_DIR` | Overrides the pi agent data directory |
| `SKILLS_API_URL` | Overrides the skills search API |

The npm CLI also accepts `--port` / `-p`, `--hostname` / `-H`, and `--no-open`.

## Development

### Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js development server on `127.0.0.1:30141` using Webpack |
| `npm run dev:turbo` | Next.js development server using Turbopack |
| `npm run electron:dev` | Electron development mode |
| `npm test` | Run the explicit cross-platform source `*.test.mjs` suite |
| `./node_modules/.bin/tsc --noEmit` | Type-check the project |
| `npm run lint` | Run ESLint |
| `npm run build` | Create the Next.js production build |
| `npm run electron:build` | Build and package Electron for the current platform |

Avoid `next build` / `npm run build` while a development server is active. It writes to `.next/` and can interfere with the running dev server.

### Local pi snapshots

The four direct pi SDK dependencies are pinned to registry version `0.87.1`; `npm ci` installs the supported SDK and its locked dependencies. For source development, the snapshot script uses upstream's complete `build:offline` workspace order, then packs the six supported runtime packages: chord, pi-tui, pi-telemetry, pi-ai, pi-agent-core, and pi-coding-agent. This workflow is validated against Pi `v0.87.1` and does not change `package.json` or `package-lock.json`.

```bash
# Uses the default sibling directory ../pi (must be a compatible clean checkout)
npm run pi:sync-local

# Or choose an explicit source checkout
npm run pi:sync-local -- --source /absolute/path/to/pi
```

Restore the most recent cached snapshot, or select a specific commit. Verification defaults to the installed snapshot's commit:

```bash
npm run pi:sync-local -- --restore
npm run pi:sync-local -- --verify
# Pin a particular snapshot when multiple commits are cached
npm run pi:sync-local -- --restore --snapshot <commit>
```

Normal `npm install`, `npm ci`, or `npm dedupe` restores the registry fallback. Windows release builds restore a snapshot only when the installed SDK has a local source marker, and preserve that exact commit. Cached snapshots cannot silently replace a registry build. The [older snapshot notes](./docs/local-pi-update-2026-08-03.md) are historical records.

## Windows x64 packaging and CI

Build on Windows x64 when possible so npm resolves the correct native dependencies:

```bash
npm ci
npm run electron:win:x64
```

The command creates and verifies `release/win-unpacked/`, then produces the NSIS installer and portable executable from that verified directory. To create only the unpacked directory:

```bash
npm run electron:win:x64:dir
```

The **Windows x64** GitHub Actions workflow runs tests, TypeScript checks, lint, package verification, and a packaged-app smoke test against `/api/home`. Manual runs upload artifacts; tags matching `v*` also create a GitHub Release.

See [GitHub Actions: Windows x64 build guide](./docs/github-build-windows.md) for the complete release workflow and troubleshooting steps.

## Project structure

```text
app/                  Next.js App Router, global styles, and API route handlers
components/           Desktop React UI, chat, settings, sidebars, and file views
hooks/                Session, theme, i18n, audio, drag/drop, and layout hooks
lib/                  SDK integration, session parsing, security, Git, files, and Markdown
lib/i18n/             Locale registry, formatting, and en / zh-CN message catalogs
electron/             Electron main process, preload bridge, tray, and server lifecycle
bin/                  npm CLI entry point and launch-option parsing
scripts/              Local pi sync, release build, and package verification
bundled-skills/       Starter skills included with packaged desktop builds
docs/                 Worktree, release, local SDK, theme, and screenshot documentation
public/               Icons, fonts-related assets, and Catppuccin file icons
```

Key entry points:

- [`components/AppShell.tsx`](./components/AppShell.tsx) — main layout, URL state, sidebars, chat, and file tabs
- [`components/ChatWindow.tsx`](./components/ChatWindow.tsx) — messages, streaming, reconciliation, and session interaction
- [`components/ChatInput.tsx`](./components/ChatInput.tsx) — prompt input, model, tools, thinking, and slash controls
- [`components/FileViewer.tsx`](./components/FileViewer.tsx) — source, diff, image, audio, PDF, and DOCX preview
- [`lib/rpc-manager.ts`](./lib/rpc-manager.ts) — `AgentSessionWrapper` lifecycle and global registry
- [`lib/session-reader.ts`](./lib/session-reader.ts) — JSONL session parsing and branch context
- [`lib/file-access.ts`](./lib/file-access.ts) — file-access allow-list boundary
- [`electron/main.js`](./electron/main.js) — desktop window, tray, local server, and native integration

## Relationship to upstream

This project began from upstream pi-web `v0.7.16` but now deliberately diverges as an Electron-first desktop product. Upstream remains a source for compatible security, SDK, data-integrity, authentication, SSE, and reliability fixes. UI components are adapted selectively rather than replaced wholesale.

Complete feature parity or release-by-release synchronization with upstream pi-web is not guaranteed.

## License

[MIT](./LICENSE)
