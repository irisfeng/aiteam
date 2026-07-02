import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "output", "ui-smoke");

function ok(name, condition, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`✓ ${name}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
  });
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  return null;
}

function waitProcessExit(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function rmRetry(path) {
  for (let i = 0; i < 6; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 + i * 150));
    }
  }
}

function chromePath() {
  const candidates = [
    process.env.AITEAM_UI_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome/Chromium not found. Set AITEAM_UI_CHROME=/path/to/chrome to run ui:smoke.");
  return found;
}

class CdpPage {
  constructor(wsUrl) {
    this.id = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}: ${msg.error.data ?? ""}`));
        else resolve(msg.result ?? {});
        return;
      }
      const callbacks = this.handlers.get(msg.method);
      if (callbacks) callbacks.forEach((cb) => cb(msg.params ?? {}));
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
    });
  }

  on(method, cb) {
    const callbacks = this.handlers.get(method) ?? [];
    callbacks.push(cb);
    this.handlers.set(method, callbacks);
  }

  async eval(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    return result.result?.value;
  }

  async waitText(text, timeoutMs = 15000) {
    const found = await waitFor(() => this.eval(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`), timeoutMs);
    if (!found) throw new Error(`Text not found: ${text}`);
    return true;
  }

  async clickText(text) {
    const clicked = await this.eval(`
      (() => {
        const target = [...document.querySelectorAll('button,a')]
          .find((el) => (el.innerText || '').trim() === ${JSON.stringify(text)});
        if (!target) return false;
        target.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error(`Clickable text not found: ${text}`);
  }

  async clickAnyText(texts) {
    const clicked = await this.eval(`
      (() => {
        const texts = ${JSON.stringify(texts)};
        const target = [...document.querySelectorAll('button,a')]
          .find((el) => texts.includes((el.innerText || '').trim()));
        if (!target) return '';
        target.click();
        return (target.innerText || '').trim();
      })()
    `);
    if (!clicked) throw new Error(`Clickable text not found: ${texts.join(" / ")}`);
    return clicked;
  }

  async screenshot(name) {
    const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
    const file = join(outDir, `${name}.png`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    return file;
  }

  close() {
    try { this.ws.close(); } catch {
      /* ignore */
    }
  }
}

async function createCdpPage(debugPort, url) {
  const endpoint = `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`;
  let target = await fetch(endpoint, { method: "PUT" });
  if (!target.ok) target = await fetch(endpoint);
  if (!target.ok) throw new Error(`Chrome target creation failed: HTTP ${target.status}`);
  const info = await target.json();
  const page = new CdpPage(info.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await waitFor(() => page.eval(`document.readyState === 'complete' && !!document.body`));
  return page;
}

async function setViewport(page, width, height, mobile = false) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await page.send("Emulation.setVisibleSize", { width, height });
}

async function register(page, label) {
  await page.eval(`
    (() => {
      const hasName = !!document.querySelector('input[placeholder="显示名（如 张三）"]');
      if (!hasName) {
        const link = [...document.querySelectorAll('button')]
          .find((el) => (el.innerText || '').trim() === '注册');
        if (link) link.click();
      }
    })()
  `);
  await waitFor(() => page.eval(`!!document.querySelector('input[placeholder="显示名（如 张三）"]')`));
  const email = `ui-${label}-${Date.now()}@test.local`;
  await page.eval(`
    (() => {
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(document.querySelector('input[placeholder="显示名（如 张三）"]'), ${JSON.stringify(`UI ${label}`)});
      setValue(document.querySelector('input[placeholder="邮箱"]'), ${JSON.stringify(email)});
      setValue(document.querySelector('input[placeholder="密码（至少 6 位）"]'), 'ui-smoke-pw');
      document.querySelector('form button[type="submit"]').click();
    })()
  `);
}

async function assertNoHorizontalOverflow(page, label) {
  const offenders = await page.eval(`
    (() => {
      const vw = Math.ceil(window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth);
      const inHorizontalScroller = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (/(auto|scroll|hidden)/.test(style.overflowX) && p.scrollWidth > p.clientWidth + 2) return true;
        }
        return false;
      };
      return [...document.querySelectorAll('body *')].flatMap((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 8 || (r.left >= -2 && r.right <= vw + 2)) return [];
        const style = getComputedStyle(el);
        if (style.position === 'fixed' && r.width <= vw + 32) return [];
        if (inHorizontalScroller(el)) return [];
        return [{
          tag: el.tagName,
          left: Math.round(r.left),
          right: Math.round(r.right),
          text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
        }];
      }).slice(0, 8);
    })()
  `);
  ok(`${label} has no horizontal overflow`, Array.isArray(offenders) && offenders.length === 0, JSON.stringify(offenders));
}

async function runViewport(debugPort, baseUrl, label, viewport) {
  const page = await createCdpPage(debugPort, baseUrl);
  try {
    await setViewport(page, viewport.width, viewport.height, viewport.mobile);
    await page.send("Page.navigate", { url: baseUrl });
    await waitFor(() => page.eval(`document.readyState === 'complete' && !!document.body`));
    await page.screenshot(`login-${label}`);
    const needsAuth = await page.eval(`!!document.querySelector('input[placeholder="邮箱"]')`);
    if (needsAuth) await register(page, label);
    await page.waitText("任务运行线");
    await page.screenshot(`workline-${label}`);
    ok(`${label} workline visible`, await page.eval(`document.body.innerText.includes('任务运行线')`));
    ok(`${label} startup checklist visible`, await page.eval(`document.body.innerText.includes('启动前检查')`));
    ok(`${label} core acceptance control visible`, await page.eval(`document.body.innerText.includes('端到端验收') || document.body.innerText.includes('打开验收')`));
    await page.clickAnyText(["端到端验收", "打开验收"]);
    await page.waitText("闭环验收：AI 同事任务运行线");
    await page.waitText("责任链");
    await page.screenshot(`scenario-${label}`);
    ok(`${label} task drawer visible`, await page.eval(`document.body.innerText.includes('责任链')`));
    ok(`${label} review checklist visible`, await page.eval(`document.body.innerText.includes('人工复核清单')`));
    ok(`${label} activity log visible`, await page.eval(`document.body.innerText.includes('活动日志')`));
    await assertNoHorizontalOverflow(page, label);
  } catch (err) {
    await page.screenshot(`failure-${label}`).catch(() => undefined);
    throw err;
  } finally {
    page.close();
  }
}

let serverProcess;
let chromeProcess;
let dataDir;
let chromeDir;

try {
  await mkdir(outDir, { recursive: true });
  const appPort = await freePort();
  const debugPort = await freePort();
  dataDir = await mkdtemp(join(tmpdir(), "aiteam-ui-smoke-data-"));
  chromeDir = await mkdtemp(join(tmpdir(), "aiteam-ui-smoke-chrome-"));
  serverProcess = spawn(process.execPath, [join(root, "server/dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(appPort),
      AITEAM_DATA_DIR: dataDir,
      AITEAM_AUTH_MODE: "standalone",
      AITEAM_ALLOW_SIGNUP: "1",
      AITEAM_ADMIN_EMAILS: "ui-smoke@test.local",
    },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${appPort}/aiteam/`;
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/aiteam/api/auth/me`).catch(() => null);
    return res && (res.status === 401 || res.ok);
  });
  ok("production server responds", true);

  chromeProcess = spawn(chromePath(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeDir}`,
    "about:blank",
  ], { stdio: "ignore" });
  await waitFor(() => fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.ok).catch(() => false));
  ok("system Chrome CDP responds", true);

  await runViewport(debugPort, baseUrl, "desktop", { width: 1440, height: 960, mobile: false });
  await runViewport(debugPort, baseUrl, "mobile", { width: 390, height: 844, mobile: true });
  console.log(`Screenshots written to ${outDir}`);
} finally {
  if (chromeProcess && !chromeProcess.killed) chromeProcess.kill("SIGTERM");
  await waitProcessExit(chromeProcess);
  if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGTERM");
  await waitProcessExit(serverProcess);
  if (chromeDir) await rmRetry(chromeDir);
  if (dataDir) await rmRetry(dataDir);
}
