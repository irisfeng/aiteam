const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

let mainWindow = null;
let tray = null;
let serverProcess = null;
let baseUrl = null;
let keepRunning = true;
let quitting = false;

const rootDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
const serverEntry = path.join(rootDir, "server", "dist", "index.js");
const preload = path.join(__dirname, "preload.cjs");
const desktopUploadMaxBytes = Number(process.env.AITEAM_UPLOAD_MAX_BYTES || 20 * 1024 * 1024);
const bundledNode = process.platform === "win32"
  ? path.join(process.resourcesPath, "node", "node.exe")
  : path.join(process.resourcesPath, "node", "bin", "node");

function iconImage() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#111827"/>
      <path d="M14 48 32 12l18 36h-8l-3.8-8.2H25.8L22 48h-8Zm15-14.8h6L32 26l-3 7.2Z" fill="#F8FAF7"/>
      <path d="m40 22 5.2 5.4L55 16" fill="none" stroke="#22C55E" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M18 48h28" fill="none" stroke="#475569" stroke-width="3" stroke-linecap="round"/>
      <circle cx="18" cy="48" r="4.5" fill="#3B82F6"/>
      <circle cx="46" cy="48" r="4.5" fill="#22C55E"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
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
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
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
  baseUrl = `http://127.0.0.1:${port}`;
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

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "AiTeam",
      submenu: [
        { label: "显示 AiTeam", click: () => createWindow() },
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
  tray = new Tray(iconImage());
  tray.setToolTip("AiTeam");
  const update = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 AiTeam", click: () => createWindow() },
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
  update();
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

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
  await startServer();
  createMenu();
  createTray();
  createWindow();
});

app.on("before-quit", () => {
  quitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !keepRunning) app.quit();
});

app.on("activate", () => createWindow());
