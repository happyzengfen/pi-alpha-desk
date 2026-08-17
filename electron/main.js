"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell } = require("electron");
const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { installBundledSkills, resolveBundledSkillsTargetRoot } = require("./bundled-skills");
const { createMacEditMenuTemplate, handleMacEditShortcut } = require("./mac-edit-shortcuts");
const { prependExecutableDirectory, resolveServerNodeExecutable } = require("./node-runtime");
const { encodeFilePathForApi, isSafeExternalUrl, isTrustedRendererUrl } = require("./security");

const startupStartedAt = performance.now();
let port = Number(process.env.PORT || 30141);

// With asar:false, app.isPackaged returns false even in production.
// Detect dev vs production by checking if resources/ has app/ or app.asar.
const pkgRoot = path.join(process.resourcesPath, "app");
const asarRoot = path.join(process.resourcesPath, "app.asar");
const IS_DEV = !fs.existsSync(pkgRoot) && !fs.existsSync(asarRoot);

const HOSTNAME = "127.0.0.1";
let serverUrl = `http://${HOSTNAME}:${port}`;

// 启动加载页（服务就绪前显示的深色界面，消除黑屏等待）
const LOADING_HTML =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#1a1a1a;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif"><div style="text-align:center"><div style="font-size:26px;color:#e6e6e6;letter-spacing:2px">数字化AI助手</div><div style="font-size:13px;color:#8b949e;margin-top:10px">正在启动…</div></div></body></html>`,
  );

let mainWindow = null;
let serverProcess = null;
let serverLog = null;
let serverLogPath = null;
let serverLogTail = "";
let tray = null;
let serverNodeExecutable = null;

function emitStartupMetric(stage, details = {}) {
  if (process.env.PI_WEB_BENCHMARK !== "1") return;
  console.log(`PI_WEB_STARTUP_METRIC ${JSON.stringify({
    stage,
    elapsedMs: Number((performance.now() - startupStartedAt).toFixed(2)),
    ...details,
  })}`);
}

function recordServerOutput(source, chunk) {
  const text = chunk.toString();
  serverLogTail = `${serverLogTail}${text}`.slice(-6000);
  serverLog?.write(`[${source}] ${text}`);
  const output = source === "stderr" ? process.stderr : process.stdout;
  output.write(text);
}

function getStartupFailureMessage(error) {
  const details = serverLogTail.trim();
  const logHint = serverLogPath ? `\n\nServer log:\n${serverLogPath}` : "";
  const detailHint = details ? `\n\nLast server output:\n${details}` : "";
  return `Failed to start 数字化AI助手: ${error.message}${logHint}${detailHint}`;
}

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(`${serverUrl}/api/home`, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`Port ${port} responded with HTTP ${res.statusCode}`));
      }).on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 500);
        }
      });
    };
    check();
  });
}

function findAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: HOSTNAME, port: preferredPort, exclusive: true }, () => {
      const address = probe.address();
      const availablePort = typeof address === "object" && address ? address.port : preferredPort;
      probe.close((error) => error ? reject(error) : resolve(availablePort));
    });
  });
}

async function selectPackagedServerPort() {
  try {
    return await findAvailablePort(port);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || process.env.PORT) throw error;
    return findAvailablePort(0);
  }
}

function setServerPort(nextPort) {
  port = nextPort;
  serverUrl = `http://${HOSTNAME}:${port}`;
}

function isTrustedIpcSender(event) {
  if (!event.sender || event.sender.isDestroyed()) return false;
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false;
  return isTrustedRendererUrl(event.senderFrame?.url || event.sender.getURL(), serverUrl);
}

function isPathAuthorizedByServer(fullPath) {
  const encodedPath = encodeFilePathForApi(fullPath);
  if (!encodedPath) return Promise.resolve(false);

  return new Promise((resolve) => {
    const request = http.get(`${serverUrl}/api/files/${encodedPath}?type=authorize`, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(2_000, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function openExternalUrl(candidate) {
  if (!isSafeExternalUrl(candidate)) return;
  void shell.openExternal(candidate);
}

function startServer() {
  const pkgDir = path.join(__dirname, "..");

  serverLogPath = path.join(app.getPath("userData"), "pi-web-server.log");
  fs.mkdirSync(path.dirname(serverLogPath), { recursive: true });
  serverLog = fs.createWriteStream(serverLogPath, { flags: "w" });
  serverLogTail = "";

  // User-installed Pi packages are built by ordinary Node/npm. Prefer a
  // compatible standalone Node runtime so native addons keep the ABI they were
  // installed for; fork falls back to Electron's embedded Node when none exists.
  const nextBin = IS_DEV
    ? require.resolve("next/dist/bin/next", { paths: [pkgDir] })
    : path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");

  const args = IS_DEV
    ? ["dev", "-H", HOSTNAME, "-p", String(port), "--turbopack"]
    : ["start", "-H", HOSTNAME, "-p", String(port)];

  // Desktop always serves only the local BrowserWindow. Do not forward an
  // ambient PI_WEB_PASSWORD into that process: doing so would require exposing
  // credentials to Chromium or forcing an interactive Basic Auth challenge.
  const { PI_WEB_PASSWORD: _password, ...environment } = process.env;
  void _password;
  const baseEnv = IS_DEV
    ? { ...environment, ELECTRON_RUNNING: "1", PI_WEB_HOSTNAME: HOSTNAME }
    : { ...environment, NODE_ENV: "production", ELECTRON_RUNNING: "1", PI_WEB_HOSTNAME: HOSTNAME };
  const env = prependExecutableDirectory(baseEnv, serverNodeExecutable);

  serverProcess = fork(nextBin, args, {
    cwd: pkgDir,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env,
    ...(serverNodeExecutable ? { execPath: serverNodeExecutable } : {}),
  });

  serverProcess.stdout.on("data", (chunk) => recordServerOutput("stdout", chunk));
  serverProcess.stderr.on("data", (chunk) => recordServerOutput("stderr", chunk));

  serverProcess.on("error", (err) => {
    recordServerOutput("process", `Failed to start Next.js server: ${err.message}\n`);
    dialog.showErrorBox("Server Error", getStartupFailureMessage(err));
    app.quit();
  });

  serverProcess.on("exit", (code, signal) => {
    recordServerOutput("process", `Next.js server exited (code=${code}, signal=${signal}).\n`);
    if (app.isQuitting) return;

    const exitError = new Error(`Next.js server exited unexpectedly (code=${code}, signal=${signal})`);
    dialog.showErrorBox("Server Error", getStartupFailureMessage(exitError));
    app.isQuitting = true;
    app.quit();
  });

  serverProcess.on("close", () => {
    serverLog?.end();
    serverLog = null;
  });
}

function getIconPath() {
  // Windows keeps the .ico; macOS uses the rasterized Pi app icon. nativeImage
  // cannot load SVG, so icon-mac.png is rendered from public/icon.svg by
  // scripts/generate-icons.mjs (run automatically by electron:build).
  return path.join(__dirname, "..", "public", process.platform === "win32" ? "icon.ico" : "icon-mac.png");
}

function createTray() {
  // Windows keeps the existing tray icon; macOS uses the Pi template icon
  // (black + alpha) so the system adapts it to light/dark menu bars.
  const iconPath = process.platform === "darwin"
    ? path.join(__dirname, "tray-icon-mac.png")
    : path.join(__dirname, "tray-icon.png");
  const sourceIcon = nativeImage.createFromPath(iconPath);
  const trayIcon = process.platform === "darwin"
    ? sourceIcon.resize({ width: 16, height: 16, quality: "best" })
    : sourceIcon;
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip("数字化AI助手");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const iconPath = getIconPath();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    title: "数字化AI助手",
    icon: iconPath,
    // macOS: keep the native frame so the traffic-light buttons render, but
    // hide the title bar text (the renderer draws its own title bar).
    // Windows/Linux: unchanged frameless window with custom controls.
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 12, y: 11 } : undefined,
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl, serverUrl)) return;
    event.preventDefault();
    openExternalUrl(targetUrl);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  mainWindow.webContents.once("did-finish-load", async () => {
    emitStartupMetric("renderer-load");
    if (process.env.PI_WEB_BENCHMARK !== "1") return;
    try {
      let chromiumMetrics = null;
      try {
        mainWindow.webContents.debugger.attach();
        await mainWindow.webContents.debugger.sendCommand("Performance.enable");
      } catch {
        // Startup timing still works when another debugger is already attached.
      }
      const renderer = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          domNodes: document.getElementsByTagName('*').length,
          navigationMs: performance.getEntriesByType('navigation')[0]?.duration ?? null,
        })));
      })`);
      if (mainWindow.webContents.debugger.isAttached()) {
        const response = await mainWindow.webContents.debugger.sendCommand("Performance.getMetrics");
        const selectedNames = new Set([
          "Documents", "Frames", "JSEventListeners", "JSHeapUsedSize",
          "LayoutCount", "LayoutDuration", "ScriptDuration", "TaskDuration",
        ]);
        chromiumMetrics = Object.fromEntries(
          response.metrics
            .filter((metric) => selectedNames.has(metric.name))
            .map((metric) => [metric.name, metric.value]),
        );
        mainWindow.webContents.debugger.detach();
      }
      const memory = await process.getProcessMemoryInfo();
      emitStartupMetric("renderer-interactive", { renderer, chromiumMetrics, memory });
    } catch (error) {
      emitStartupMetric("renderer-metrics-error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      app.isQuitting = true;
      app.quit();
    }
  });

  // Sync the renderer's document.title to the native window title,
  // so the workspace name (set by AppShell) appears in the title bar.
  mainWindow.webContents.on("page-title-updated", (_event, title) => {
    mainWindow.setTitle(title);
  });

  // Keep macOS editing shortcuts working even if the native application menu
  // is hidden or unavailable in a packaged build.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (handleMacEditShortcut(event, input, mainWindow.webContents)) return;

    // Enable DevTools toggle with Ctrl+Shift+I / F12.
    if (input.type === "keyDown" && !input.isAutoRepeat) {
      const isDevToolsKey =
        (input.key === "F12") ||
        (input.control && input.shift && input.key === "I") ||
        (input.control && input.shift && input.key === "i");
      if (isDevToolsKey) {
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  const sendMaximizedState = () => {
    try {
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.webContents &&
        !mainWindow.webContents.isDestroyed()
      ) {
        mainWindow.webContents.send("window:maximized-changed", mainWindow.isMaximized());
      }
    } catch (err) {
      // A dead renderer must not let a maximize IPC error mask the real
      // crash cause — log it and move on.
      console.error("[Electron] sendMaximizedState failed:", err);
    }
  };
  mainWindow.on("maximize", sendMaximizedState);
  mainWindow.on("unmaximize", sendMaximizedState);

  // ── Renderer diagnostics ──────────────────────────────────────────────
  // Surface renderer crashes and console errors from the main process so
  // black screens / DevTools disconnects can be attributed from evidence
  // (reason + exitCode + console output) instead of guesswork.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      "[Electron] Renderer process gone:",
      JSON.stringify({ reason: details.reason, exitCode: details.exitCode, details }),
    );
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      "[Electron] did-fail-load:",
      JSON.stringify({ errorCode, errorDescription, validatedURL }),
    );
  });

  // `console-message` moved to an event-object API; the legacy positional
  // arguments are deprecated. Accept both so this works on any Electron.
  mainWindow.webContents.on("console-message", (event, ...legacyArgs) => {
    const [legacyLevel, legacyMessage, legacyLine, legacySourceId] = legacyArgs;
    const level = typeof event.level === "number" ? event.level : legacyLevel;
    const message = event.message ?? legacyMessage;
    const lineNumber = event.lineNumber ?? legacyLine;
    const sourceId = event.sourceId ?? legacySourceId;
    if (level >= 3) {
      console.error(`[Renderer console] ${message} (${sourceId}:${lineNumber})`);
    }
  });

  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("window:minimize", (event) => {
  if (!isTrustedIpcSender(event)) return;
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on("window:toggle-maximize", (event) => {
  if (!isTrustedIpcSender(event)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});

ipcMain.on("window:close", (event) => {
  if (!isTrustedIpcSender(event)) return;
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window:is-maximized", (event) => {
  if (!isTrustedIpcSender(event)) return false;
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

// Open the native OS folder-picker dialog. Used by the workspace selector's
// "Select folder" action so users browse instead of typing a path.
// Remember the last folder the user picked so the dialog reopens there next
// time instead of always landing on the Downloads folder (Electron's default).
let lastSelectedDirectory = null;

ipcMain.handle("dialog:select-directory", async (event) => {
  if (!isTrustedIpcSender(event)) return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, {
    title: "Select folder",
    defaultPath: lastSelectedDirectory ?? app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  lastSelectedDirectory = result.filePaths[0];
  return result.filePaths[0];
});

ipcMain.handle("shell:open-theme-folder", async (event) => {
  if (!isTrustedIpcSender(event)) return "Access denied";
  const themeDirectory = path.join(app.getPath("home"), ".pi", "agent", "themes");
  try {
    fs.mkdirSync(themeDirectory, { recursive: true });
    return await shell.openPath(themeDirectory);
  } catch (error) {
    console.error("[Electron] Failed to open Pi theme folder:", error);
    return error instanceof Error ? error.message : String(error);
  }
});

ipcMain.handle("shell:open-theme-docs", (event) => {
  if (!isTrustedIpcSender(event)) return;
  return shell.openExternal("https://pi.dev/docs/latest/themes");
});

// Reveal a file/folder in the system file explorer, selecting the item in its
// parent folder. Unlike openPath() it returns void, so existence is pre-checked
// here and the renderer gets a boolean it can trust. The path originates from
// the renderer's file explorer, which is already backed by the server-side
// allow-list; no new server API surface is introduced.
ipcMain.handle("shell:show-item-in-folder", async (event, fullPath) => {
  if (!isTrustedIpcSender(event)) return false;
  if (typeof fullPath !== "string" || fullPath.length === 0) return false;
  try {
    if (!fs.existsSync(fullPath)) return false;
    if (!await isPathAuthorizedByServer(fullPath)) return false;
    shell.showItemInFolder(fullPath);
    return true;
  } catch (error) {
    console.error("[Electron] Failed to reveal item in folder:", error);
    return false;
  }
});

async function bootstrap() {
  emitStartupMetric("bootstrap-start");
  // 启动优化：立即显示窗口（加载页），不等服务就绪——消除“黑屏等待”
  createWindow();
  mainWindow.loadURL(LOADING_HTML);
  const bundledSkillsRoot = IS_DEV
    ? path.join(__dirname, "..", "bundled-skills")
    : path.join(process.resourcesPath, "bundled-skills");
  const userSkillsRoot = resolveBundledSkillsTargetRoot({
    homeDirectory: app.getPath("home"),
    configuredAgentDir: process.env.PI_CODING_AGENT_DIR,
  });
  const agentDir = path.dirname(userSkillsRoot);
  if (process.platform === "darwin") {
    app.dock.setIcon(getIconPath());
  }
  serverNodeExecutable = resolveServerNodeExecutable({
    homeDirectory: app.getPath("home"),
    agentDir,
  });

  if (IS_DEV) {
    try {
      await waitForServer(2000);
    } catch {
      startServer();
      try {
        await waitForServer(60000);
      } catch (err) {
        dialog.showErrorBox("Startup Error", getStartupFailureMessage(err));
        app.quit();
        return;
      }
    }
  } else {
    try {
      setServerPort(await selectPackagedServerPort());
    } catch (err) {
      dialog.showErrorBox("Startup Error", getStartupFailureMessage(err));
      app.quit();
      return;
    }

    startServer();
    try {
      await waitForServer(60000);
    } catch (err) {
      dialog.showErrorBox("Startup Error", getStartupFailureMessage(err));
      app.quit();
      return;
    }
  }

  // 启动优化：服务就绪后再后台安装/校验 skill（不阻塞启动路径；
  // 首次安装的同步复制/哈希在用户已可用之后进行，后续启动走指纹快速路径）
  setImmediate(() => {
    installBundledSkills({ sourceRoot: bundledSkillsRoot, targetRoot: userSkillsRoot }).catch((error) => {
      console.error("[Electron] Failed to install bundled skills:", error);
    });
  });

  emitStartupMetric("server-ready", { serverUrl });
  createTray();
  // 服务就绪后加载主界面（窗口已提前创建，此处只是切换 URL）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(serverUrl);
  } else {
    createWindow();
  }
  emitStartupMetric("window-created");
}

// ── Single-instance lock ──────────────────────────────────────
// Prevent multiple copies of the app from running at the same time.
if (process.env.PI_WEB_BENCHMARK === "1" && process.env.PI_WEB_BENCHMARK_USER_DATA) {
  app.setPath("userData", process.env.PI_WEB_BENCHMARK_USER_DATA);
}
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  emitStartupMetric("single-instance-lock-rejected");
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to launch a second instance → restore the existing window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    emitStartupMetric("electron-ready");
    // Install explicit editing roles after Electron is ready. macOS depends on
    // these native menu roles for standard Command shortcuts; Windows/Linux
    // keep the existing menu-less frameless window.
    const applicationMenu = process.platform === "darwin"
      ? Menu.buildFromTemplate(createMacEditMenuTemplate())
      : null;
    Menu.setApplicationMenu(applicationMenu);
    return bootstrap();
  });
}

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
    mainWindow.loadURL(serverUrl);
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
