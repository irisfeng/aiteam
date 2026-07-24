const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

let mainWindow = null;
let connectWindow = null;
let tray = null;
let serverProcess = null;
let baseUrl = null;
let localBaseUrl = null;
let keepRunning = true;
let quitting = false;
let refreshTrayMenu = () => {};
// 远端工作区模式的持久化设置，启动时从 desktop-settings.json 加载；默认本机模式。
let settings = { mode: "local", remoteUrl: "" };

const rootDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
const serverEntry = path.join(rootDir, "server", "dist", "index.js");
const preload = path.join(__dirname, "preload.cjs");
const connectPreload = path.join(__dirname, "connect-preload.cjs");
const desktopUploadMaxBytes = Number(process.env.AITEAM_UPLOAD_MAX_BYTES || 20 * 1024 * 1024);
// 远端连通性探测超时：本地起服务很快，远端受公网延迟影响需要更宽松的窗口。
const remoteProbeTimeoutMs = 15000;
const bundledNode = process.platform === "win32"
  ? path.join(process.resourcesPath, "node", "node.exe")
  : path.join(process.resourcesPath, "node", "bin", "node");

function iconImage(dark = nativeTheme.shouldUseDarkColors) {
  const palette = dark
    ? { surface: "#173150", border: "#31567F", network: "#D7E8FF", core: "#4ADE80", ring: "#173150" }
    : { surface: "#EAF2FF", border: "#C7DCFF", network: "#1D4ED8", core: "#16A34A", ring: "#FFFFFF" };
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="1" y="1" width="62" height="62" rx="18" fill="${palette.surface}" stroke="${palette.border}" stroke-width="2"/>
      <g fill="none" stroke="${palette.network}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="32" cy="14" r="6"/><path d="m27.7 18.3-9.4 9.4"/>
        <circle cx="14" cy="32" r="6"/><path d="M20 32h24"/>
        <circle cx="50" cy="32" r="6"/><path d="m36.3 45.7 9.4-9.4"/>
        <circle cx="32" cy="50" r="6"/>
      </g>
      <rect x="27.5" y="27.5" width="9" height="9" rx="2" fill="${palette.core}" stroke="${palette.ring}" stroke-width="2" transform="rotate(45 32 32)"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
}

function trayIconImage() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 64 64">
      <g fill="none" stroke="#000" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="32" cy="14" r="6"/><path d="m27.7 18.3-9.4 9.4"/>
        <circle cx="14" cy="32" r="6"/><path d="M20 32h24"/>
        <circle cx="50" cy="32" r="6"/><path d="m36.3 45.7 9.4-9.4"/>
        <circle cx="32" cy="50" r="6"/>
      </g>
      <rect x="27" y="27" width="10" height="10" rx="2" fill="#000" transform="rotate(45 32 32)"/>
    </svg>
  `);
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`).resize({ width: 20, height: 20 });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function refreshNativeIcons() {
  const image = iconImage();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(image);
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(image);
  if (tray && !tray.isDestroyed()) tray.setImage(trayIconImage());
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitFor(url, timeoutMs = 30000) {
  const client = url.startsWith("https:") ? https : http;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = client.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error(`Server did not become ready: ${url}`));
      else setTimeout(tick, 350);
    };
    tick();
  });
}

// 远端连通性探测：只返回可达与否，不抛错，调用方按结果决定是否回退本机模式。
async function probeRemote(url, timeoutMs = remoteProbeTimeoutMs) {
  try {
    await waitFor(`${url}/aiteam/`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

// 只接受 http(s) 且取 origin（丢弃用户误填的路径/查询/尾斜杠），统一以 /aiteam/ 前缀访问。
function normalizeRemoteUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

function settingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (parsed && (parsed.mode === "local" || parsed.mode === "remote")) {
      return { mode: parsed.mode, remoteUrl: typeof parsed.remoteUrl === "string" ? parsed.remoteUrl : "" };
    }
  } catch {
    /* 首次启动或文件缺失/损坏时退回默认本机模式 */
  }
  return { mode: "local", remoteUrl: "" };
}

function saveSettings(next) {
  try {
    const userData = app.getPath("userData");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.error(`[aiteam-desktop] failed to save desktop-settings.json: ${error}`);
  }
}

function ensureSecret(userData) {
  const p = path.join(userData, "session-secret.txt");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  const secret = crypto.randomBytes(48).toString("base64url");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(p, secret, { mode: 0o600 });
  return secret;
}

function resolveServerNode() {
  const candidates = [
    process.env.AITEAM_NODE_BINARY,
    process.env.npm_node_execpath,
    process.env.NODE,
    app.isPackaged && fs.existsSync(bundledNode) ? bundledNode : undefined,
    "node",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "node" || fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

async function startServer() {
  // 幂等：本机 server 已在跑（例如从远端模式切回本机）时直接复用，不重复 spawn。
  if (serverProcess && !serverProcess.killed) {
    baseUrl = localBaseUrl;
    return;
  }
  if (!fs.existsSync(serverEntry)) {
    throw new Error("server/dist/index.js not found. Run `npm run build` before starting the desktop shell.");
  }
  const port = await getFreePort();
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  const nodeBinary = resolveServerNode();
  const env = {
    ...process.env,
    AITEAM_DATA_DIR: dataDir,
    AITEAM_HOST: "127.0.0.1",
    AITEAM_SESSION_SECRET: process.env.AITEAM_SESSION_SECRET || ensureSecret(userData),
    PORT: String(port),
  };
  if (nodeBinary === process.execPath) env.ELECTRON_RUN_AS_NODE = "1";
  else delete env.ELECTRON_RUN_AS_NODE;
  serverProcess = spawn(nodeBinary, [serverEntry], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (buf) => console.log(`[server] ${buf}`.trim()));
  serverProcess.stderr.on("data", (buf) => console.error(`[server] ${buf}`.trim()));
  serverProcess.on("exit", (code, signal) => {
    if (!quitting) console.error(`[aiteam-desktop] server exited code=${code} signal=${signal}`);
  });
  localBaseUrl = `http://127.0.0.1:${port}`;
  baseUrl = localBaseUrl;
  await waitFor(`${baseUrl}/aiteam/`);
}

function createWindow(target = "/aiteam/") {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    if (target) mainWindow.loadURL(`${baseUrl}${target}`);
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    title: "AiTeam",
    icon: iconImage(),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`${baseUrl}${target}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (!quitting && keepRunning) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

// 切到远端工作区：校验地址、探测健康后才提交状态，避免把窗口指向一个连不上的 baseUrl。
async function connectToRemote(rawUrl) {
  const normalized = normalizeRemoteUrl(rawUrl);
  if (!normalized) return { ok: false, message: "请输入合法的 http(s) 地址，例如 https://your-server:8787" };
  const reachable = await probeRemote(normalized, 8000);
  if (!reachable) return { ok: false, message: "无法连接到该地址，请确认服务已启动且网络可达" };
  settings = { mode: "remote", remoteUrl: normalized };
  saveSettings(settings);
  baseUrl = normalized;
  createMenu();
  refreshTrayMenu();
  createWindow();
  return { ok: true };
}

// 切回本机工作区：本地 server 未启动则先启动（startServer 对已运行的情况是幂等的）。
async function switchToLocal() {
  try {
    await startServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("启动本机服务失败", message);
    return { ok: false, message };
  }
  settings = { mode: "local", remoteUrl: settings.remoteUrl };
  saveSettings(settings);
  createMenu();
  refreshTrayMenu();
  createWindow();
  return { ok: true };
}

// 「连接远端工作区」窗口内容：以 data: URL 加载的内联表单，不接触磁盘/文件协议，避免额外的打包资源。
const connectWindowHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 20px; background: #f8faf7; color: #111827; }
  h1 { font-size: 15px; margin: 0 0 12px; }
  p.status { font-size: 12px; color: #475569; margin: 0 0 16px; word-break: break-all; }
  label { display: block; font-size: 12px; margin-bottom: 6px; color: #334155; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; margin-bottom: 10px; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; font-size: 13px; cursor: pointer; }
  button.primary { background: #111827; color: #fff; border-color: #111827; }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: #dc2626; font-size: 12px; min-height: 16px; margin-top: 8px; }
</style>
</head>
<body>
  <h1>连接远端工作区</h1>
  <p class="status" id="status">正在读取当前状态…</p>
  <label for="url">远端地址（http/https，含端口）</label>
  <input type="text" id="url" placeholder="https://your-vps:8787" />
  <div class="error" id="error"></div>
  <div class="row">
    <button id="cancel">取消</button>
    <button id="local" style="display:none">切回本机工作区</button>
    <button id="submit" class="primary">连接</button>
  </div>
  <script>
    var statusEl = document.getElementById("status");
    var urlInput = document.getElementById("url");
    var errorEl = document.getElementById("error");
    var submitBtn = document.getElementById("submit");
    var cancelBtn = document.getElementById("cancel");
    var localBtn = document.getElementById("local");

    function setBusy(busy) {
      submitBtn.disabled = busy;
      localBtn.disabled = busy;
      submitBtn.textContent = busy ? "连接中…" : "连接";
    }

    window.aiteamConnect.getState().then(function (state) {
      statusEl.textContent = "当前模式：" + (state.mode === "remote" ? "远端 (" + state.remoteUrl + ")" : "本机");
      if (state.remoteUrl) urlInput.value = state.remoteUrl;
      if (state.mode === "remote") localBtn.style.display = "block";
    });

    cancelBtn.addEventListener("click", function () {
      window.close();
    });

    localBtn.addEventListener("click", function () {
      setBusy(true);
      errorEl.textContent = "";
      window.aiteamConnect.switchLocal().then(function (result) {
        setBusy(false);
        if (result && result.ok) window.close();
        else errorEl.textContent = (result && result.message) || "切换失败";
      });
    });

    submitBtn.addEventListener("click", function () {
      var value = urlInput.value.trim();
      if (!value) {
        errorEl.textContent = "请输入远端地址";
        return;
      }
      setBusy(true);
      errorEl.textContent = "";
      window.aiteamConnect.setRemote(value).then(function (result) {
        setBusy(false);
        if (result && result.ok) window.close();
        else errorEl.textContent = (result && result.message) || "连接失败";
      });
    });
  </script>
</body>
</html>`;

function openConnectWindow() {
  if (connectWindow) {
    connectWindow.show();
    connectWindow.focus();
    return;
  }
  connectWindow = new BrowserWindow({
    width: 460,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow ?? undefined,
    title: "连接远端工作区",
    webPreferences: {
      preload: connectPreload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  connectWindow.setMenuBarVisibility(false);
  connectWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(connectWindowHtml)}`);
  connectWindow.on("closed", () => {
    connectWindow = null;
  });
}

function createMenu() {
  const remoteActive = settings.mode === "remote";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "AiTeam",
      submenu: [
        { label: "显示 AiTeam", click: () => createWindow() },
        { type: "separator" },
        { label: "连接远端工作区…", click: () => openConnectWindow() },
        ...(remoteActive ? [{ label: "切回本机工作区", click: () => switchToLocal() }] : []),
        { type: "separator" },
        {
          label: "关闭窗口后继续运行",
          type: "checkbox",
          checked: keepRunning,
          click: (item) => {
            keepRunning = item.checked;
          },
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
  ]));
}

function createTray() {
  tray = new Tray(trayIconImage());
  tray.setToolTip("AiTeam");
  const update = () => {
    const remoteActive = settings.mode === "remote";
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 AiTeam", click: () => createWindow() },
      { label: "连接远端工作区…", click: () => openConnectWindow() },
      ...(remoteActive ? [{ label: "切回本机工作区", click: () => switchToLocal() }] : []),
      {
        label: "关闭窗口后继续运行",
        type: "checkbox",
        checked: keepRunning,
        click: (item) => {
          keepRunning = item.checked;
          update();
        },
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]));
  };
  update();
  refreshTrayMenu = update;
  tray.on("click", () => createWindow());
}

function targetFromDeepLink(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname === "channel") return `/aiteam/?channel=${encodeURIComponent(u.pathname.slice(1))}`;
    if (u.hostname === "tasks") return "/aiteam/?view=tasks";
    if (u.hostname === "task") {
      const id = u.pathname.slice(1);
      return id ? `/aiteam/?view=tasks&task=${encodeURIComponent(id)}` : "/aiteam/?view=tasks";
    }
    if (u.hostname === "approval" || u.hostname === "approvals") {
      const id = u.pathname.slice(1);
      return id ? `/aiteam/?view=inbox&approval=${encodeURIComponent(id)}` : "/aiteam/?view=inbox";
    }
    if (u.hostname === "inbox") return "/aiteam/?view=inbox";
  } catch {
    /* ignore */
  }
  return "/aiteam/";
}

function handleDeepLink(raw) {
  if (!baseUrl) return;
  createWindow(targetFromDeepLink(raw));
}

ipcMain.on("notify", (_event, payload) => {
  if (!Notification.isSupported()) return;
  const title = String(payload?.title ?? "AiTeam");
  const body = String(payload?.body ?? "");
  const target = typeof payload?.target === "string" ? payload.target : "";
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    if (target.startsWith("aiteam://")) handleDeepLink(target);
    else createWindow();
  });
  notification.show();
});

ipcMain.handle("pick-file", async (_event, payload) => {
  const mode = payload?.mode === "template" ? "template" : "source";
  const filters = mode === "template"
    ? [{ name: "PowerPoint templates", extensions: ["pptx"] }]
    : [
        { name: "Supported documents", extensions: ["txt", "md", "markdown", "csv", "tsv", "json", "log", "yaml", "yml", "xml", "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "epub", "html", "htm", "png", "jpg", "jpeg", "gif", "webp"] },
      ];
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: mode === "template" ? "选择 .pptx 模板" : "选择来源文档",
    properties: ["openFile"],
    filters,
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { canceled: true };
  if (stat.size > desktopUploadMaxBytes) {
    throw new Error(`文件过大：最大 ${Math.round(desktopUploadMaxBytes / 1024 / 1024)}MB`);
  }
  const bytes = fs.readFileSync(filePath);
  return {
    canceled: false,
    file: {
      name: path.basename(filePath),
      size: stat.size,
      bytes: Array.from(bytes),
    },
  };
});

ipcMain.handle("get-connection-state", () => ({ mode: settings.mode, remoteUrl: settings.remoteUrl }));
ipcMain.handle("set-remote", (_event, rawUrl) => connectToRemote(rawUrl));
ipcMain.handle("switch-local", () => switchToLocal());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // app.quit() 是异步的：不加 else 守卫，输家实例仍会注册 whenReady 并再起一个 server 子进程。
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith("aiteam://"));
    if (link) handleDeepLink(link);
    else createWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    try {
      app.setAsDefaultProtocolClient("aiteam");
    } catch {
      /* protocol registration is best-effort */
    }
    settings = loadSettings();
    if (settings.mode === "remote" && settings.remoteUrl) {
      // 远端模式启动不 spawn 本机 server、不生成本机 session secret；探测失败才回退本机模式。
      const reachable = await probeRemote(settings.remoteUrl);
      if (reachable) {
        baseUrl = settings.remoteUrl;
      } else {
        dialog.showErrorBox(
          "无法连接远端工作区",
          `无法连接到 ${settings.remoteUrl}，已自动切换到本机工作区。可通过菜单「连接远端工作区…」重试。`,
        );
        settings = { mode: "local", remoteUrl: settings.remoteUrl };
        saveSettings(settings);
        await startServer();
      }
    } else {
      await startServer();
    }
    createMenu();
    createTray();
    createWindow();
    refreshNativeIcons();
    nativeTheme.on("updated", refreshNativeIcons);
  });

  app.on("before-quit", () => {
    quitting = true;
    if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGTERM");
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !keepRunning) app.quit();
  });

  app.on("activate", () => createWindow());
}
