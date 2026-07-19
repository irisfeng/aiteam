import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = process.env.AITEAM_UI_OUTPUT || join(root, "output", "ui-smoke");

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
  const email = `ui-${label}@test.local`;
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
    await page.waitText("今天要推进什么？");
    await page.screenshot(`workline-${label}`);
    ok(`${label} focus composer visible`, await page.eval(`document.body.innerText.includes('今天要推进什么？')`));
    ok(`${label} three shortcuts visible`, await page.eval(`['调研并给出决策建议','写一份可交付文档','规划并推进一个项目'].every((text) => document.body.innerText.includes(text))`));
    ok(`${label} advanced controls are progressively disclosed`, await page.eval(`!document.body.innerText.includes('启动前检查') && document.body.innerText.includes('运行与验收工具')`));

    const budgetProviderName = `UI预算确认-${label}-${Date.now()}`;
    const budgetProvider = await page.eval(`
      fetch('/aiteam/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ${JSON.stringify(budgetProviderName)},
          api_key: 'sk-ui-budget-only',
          base_url: 'http://127.0.0.1:1/v1',
          default_model: 'ui-budget-reviewer',
          light_model: 'ui-budget-worker',
          price_input_per_million: 1,
          price_output_per_million: 2,
          price_currency: 'CNY',
        }),
      }).then((res) => res.json())
    `, true);
    ok(`${label} budget-only provider fixture is created`, Boolean(budgetProvider?.id), JSON.stringify(budgetProvider));
    await page.eval(`window.__aiteamBeforeProviderReload = true`);
    await page.send("Page.reload", { ignoreCache: true });
    await waitFor(() => page.eval(`typeof window.__aiteamBeforeProviderReload === 'undefined'`));
    await page.waitText("今天要推进什么？");
    const reloadedProviderVisible = await page.eval(`
      fetch('/aiteam/api/bootstrap').then((res) => res.json()).then((data) =>
        data.providers.some((provider) => provider.id === ${JSON.stringify(budgetProvider.id)})
      )
    `, true);
    ok(`${label} budget-only provider survives reload`, reloadedProviderVisible);
    const tasksBeforeBudgetCancel = await page.eval(`fetch('/aiteam/api/tasks').then((res) => res.json()).then((tasks) => tasks.length)`, true);
    const settingsOpened = await page.eval(`
      window.__aiteamBudgetWarning = '';
      window.confirm = (message) => {
        window.__aiteamBudgetWarning = String(message);
        return false;
      };
      const button = document.querySelector('button[title="设置"]');
      button?.click();
      Boolean(button);
    `);
    ok(`${label} settings opens for budget confirmation`, settingsOpened);
    await page.waitText(budgetProviderName);
    const clickedBudgetBenchmark = await page.eval(`
      (() => {
        const row = [...document.querySelectorAll('div')]
          .find((element) => element.textContent?.includes(${JSON.stringify(budgetProviderName)}) &&
            [...element.querySelectorAll('button')].some((button) => (button.innerText || '').trim() === '运行质量基准'));
        const button = row && [...row.querySelectorAll('button')]
          .find((item) => (item.innerText || '').trim() === '运行质量基准');
        button?.click();
        return Boolean(button);
      })()
    `);
    ok(`${label} budget benchmark control is reachable`, clickedBudgetBenchmark);
    const budgetWarningReady = await waitFor(() => page.eval(`window.__aiteamBudgetWarning.includes(${JSON.stringify(budgetProviderName)})`));
    ok(`${label} paid benchmark shows provider, models, token cap, reserve and cost before running`, Boolean(budgetWarningReady) && await page.eval(`
      window.__aiteamBudgetWarning.includes('ui-budget-worker') &&
      window.__aiteamBudgetWarning.includes('ui-budget-reviewer') &&
      window.__aiteamBudgetWarning.includes('AiTeam 产品落地决策简报 · v7') &&
      window.__aiteamBudgetWarning.includes('2200–3800') &&
      window.__aiteamBudgetWarning.includes('20k billable tokens') &&
      window.__aiteamBudgetWarning.includes('预留复核：6k') &&
      window.__aiteamBudgetWarning.includes('CNY 0.04') &&
      window.__aiteamBudgetWarning.includes('取消')
    `));
    await page.waitText("已取消 · 未调用模型、未创建任务");
    const tasksAfterBudgetCancel = await page.eval(`fetch('/aiteam/api/tasks').then((res) => res.json()).then((tasks) => tasks.length)`, true);
    ok(`${label} cancelling paid benchmark creates no task and makes no model call`, tasksAfterBudgetCancel === tasksBeforeBudgetCancel);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.screenshot(`budget-confirm-${label}`);
    await page.eval(`fetch('/aiteam/api/providers/${budgetProvider.id}', { method: 'DELETE' })`, true);
    await page.clickText("✕");

    await page.clickText("写一份可交付文档");
    const templateNeedsTopic = await page.eval(`
      (() => {
        const input = document.querySelector('textarea[aria-label="今天要推进的目标"]');
        const send = [...document.querySelectorAll('button')].find((button) => (button.innerText || '').trim() === '发送');
        return Boolean(input?.value.startsWith('写一份可直接评审和交付的文档') && send?.disabled);
      })()
    `);
    ok(`${label} shortcut template cannot be sent without a topic`, templateNeedsTopic);
    const focusTitle = `UI Focus-${label}-${Date.now()}`;
    await page.eval(`
      (() => {
        const input = document.querySelector('textarea[aria-label="今天要推进的目标"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, input.value + ${JSON.stringify("__FOCUS_TITLE__")});
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify("__FOCUS_TITLE__")} }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `.replaceAll("__FOCUS_TITLE__", focusTitle));
    await page.clickText("发送");
    await page.waitText(focusTitle);
    await page.waitText("责任链");
    const quickTask = await page.eval(`
      fetch('/aiteam/api/tasks')
        .then((res) => res.json())
        .then((tasks) => tasks.find((item) => item.title === ${JSON.stringify(focusTitle)}) || null)
    `, true);
    ok(
      `${label} shortcut maps to document contract, independent reviewer and capped budget`,
      Boolean(
        quickTask &&
        quickTask.acceptance_criteria.includes('正式文档') &&
        quickTask.budget_billable === 16000 &&
        quickTask.reviewer_agent_id &&
        quickTask.reviewer_agent_id !== quickTask.assignee_agent_id
      ),
    );
    await page.screenshot(`scenario-${label}`);
    ok(`${label} task drawer visible`, await page.eval(`document.body.innerText.includes('责任链')`));
    ok(`${label} review checklist visible`, await page.eval(`document.body.innerText.includes('人工复核清单')`));
    ok(`${label} activity log visible`, await page.eval(`document.body.innerText.includes('活动日志')`));
    await assertNoHorizontalOverflow(page, label);

    const reviewReady = await waitFor(() => page.eval(`
      Promise.all([
        fetch('/aiteam/api/tasks').then((res) => res.json()),
        fetch('/aiteam/api/documents').then((res) => res.json()),
        fetch('/aiteam/api/tasks/${quickTask.id}/events').then((res) => res.json()),
        fetch('/aiteam/api/tasks/${quickTask.id}/verdicts').then((res) => res.json()),
      ]).then(([tasks, docs, events, verdicts]) => {
        const task = tasks.find((item) => item.id === ${JSON.stringify(quickTask.id)});
        const eventTypes = new Set(events.map((event) => event.type));
        return Boolean(
          task?.status === 'review' &&
          docs.some((doc) => doc.task_id === task.id) &&
          ['claim', 'start', 'delivery'].every((type) => eventTypes.has(type)) &&
          verdicts.length === 0
        );
      })
    `, true), 15000);
    ok(`${label} focus task reaches review with deliverable and audit trail without a fake Mock verdict`, Boolean(reviewReady));
    ok(`${label} Mock review truthfully shows missing structured verdict`, await page.eval(`
      document.body.innerText.includes('暂无结构化裁决') &&
      document.body.innerText.includes('关单前仍需人工确认')
    `));
    await page.eval(`
      window.__aiteamCloseWarning = '';
      window.confirm = (message) => {
        window.__aiteamCloseWarning = String(message);
        return true;
      };
    `);
    await page.waitText("确认关闭任务");
    await page.clickText("确认关闭任务");
    await page.waitText("已关闭");
    ok(`${label} closing without a pass verdict requires explicit human acknowledgement`, await page.eval(`
      window.__aiteamCloseWarning.includes('暂无结构化复核通过裁决') &&
      window.__aiteamCloseWarning.includes('人工判断')
    `));
    const humanClosed = await waitFor(() => page.eval(`
      Promise.all([
        fetch('/aiteam/api/tasks').then((res) => res.json()),
        fetch('/aiteam/api/tasks/${quickTask.id}/events').then((res) => res.json()),
      ]).then(([tasks, events]) => {
        const task = tasks.find((item) => item.id === ${JSON.stringify(quickTask.id)});
        const closeEvent = events.find((event) => event.type === 'user_close');
        let closeMeta = {};
        try { closeMeta = JSON.parse(closeEvent?.metadata_json || '{}'); } catch {}
        return task?.status === 'done' &&
          closeEvent?.summary.includes('基于人工判断') &&
          closeMeta.human_override === true &&
          closeMeta.latest_verdict === null &&
          closeMeta.document_count >= 1;
      })
    `, true));
    ok(`${label} human closes reviewed focus task with explicit override evidence`, Boolean(humanClosed));
    await page.screenshot(`closed-${label}`);
    await assertNoHorizontalOverflow(page, `${label} closed drawer`);

    const benchmarkTitle = `真实模型质量基准：AiTeam 产品落地决策简报（UI-${label}-${Date.now()}）`;
    const benchmarkTaskId = await page.eval(`
      (async () => {
        const bootstrap = await fetch('/aiteam/api/bootstrap').then((res) => res.json());
        const [worker, reviewer] = bootstrap.agents;
        const res = await fetch('/aiteam/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: ${JSON.stringify(benchmarkTitle)},
            description: '验证真实质量基准的人工审计不可被跳过。',
            acceptance_criteria: '1. 有正式交付文档\\n2. 有独立复核结论\\n3. 完成人工质量审计',
            assignee_agent_id: worker.id,
            reviewer_agent_id: reviewer.id,
            budget_billable: 20000,
          }),
        });
        const task = await res.json();
        if (!res.ok) throw new Error(task.error || 'create benchmark task failed');
        return task.id;
      })()
    `, true);
    const benchmarkReviewReady = await waitFor(() => page.eval(`
      fetch('/aiteam/api/tasks')
        .then((res) => res.json())
        .then((tasks) => tasks.some((task) => task.id === ${JSON.stringify(benchmarkTaskId)} && task.status === 'review'))
    `, true), 15000);
    ok(`${label} benchmark task reaches human review`, Boolean(benchmarkReviewReady));
    await page.send("Page.navigate", { url: `${baseUrl}?task=${encodeURIComponent(benchmarkTaskId)}` });
    await page.waitText("三重验收");
    await page.waitText("最后一步 · 你的质量确认");
    await page.waitText("确认质量并关单");
    const visibleBenchmarkGate = await page.eval(`
      fetch('/aiteam/api/tasks/${benchmarkTaskId}/quality-gate')
        .then((res) => res.json())
        .then((gate) => ({
          gate,
          text: document.body.innerText,
        }))
    `, true);
    ok(
      `${label} benchmark drawer explains all three gates and current failure reasons before close`,
      visibleBenchmarkGate?.gate?.machine?.pass === false &&
        visibleBenchmarkGate?.gate?.reviewer?.ready === false &&
        visibleBenchmarkGate?.gate?.human?.completed === false &&
        visibleBenchmarkGate?.gate?.ready_for_human_audit === false &&
        visibleBenchmarkGate?.text?.includes("自动检查") &&
        visibleBenchmarkGate?.text?.includes("独立复核") &&
        visibleBenchmarkGate?.text?.includes("待完成 · 0/5") &&
        visibleBenchmarkGate?.text?.includes("先补齐当前文档的自动检查与独立复核"),
      JSON.stringify(visibleBenchmarkGate?.gate),
    );
    const liveGateRefreshTriggered = await page.eval(`
      (async () => {
        window.__aiteamQualityGateFetches = 0;
        window.__aiteamFetchBeforeQualityGateProbe = window.fetch.bind(window);
        window.fetch = (...args) => {
          if (String(args[0] || '').includes('/tasks/${benchmarkTaskId}/quality-gate')) {
            window.__aiteamQualityGateFetches += 1;
          }
          return window.__aiteamFetchBeforeQualityGateProbe(...args);
        };
        const [bootstrap, tasks] = await Promise.all([
          window.__aiteamFetchBeforeQualityGateProbe('/aiteam/api/bootstrap').then((res) => res.json()),
          window.__aiteamFetchBeforeQualityGateProbe('/aiteam/api/tasks').then((res) => res.json()),
        ]);
        const task = tasks.find((item) => item.id === ${JSON.stringify(benchmarkTaskId)});
        const nextReviewer = bootstrap.agents.find((agent) =>
          agent.id !== task?.assignee_agent_id && agent.id !== task?.reviewer_agent_id
        );
        if (!task || !nextReviewer || task.status !== 'review') return false;
        const response = await window.__aiteamFetchBeforeQualityGateProbe('/aiteam/api/tasks/${benchmarkTaskId}', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewer_agent_id: nextReviewer.id }),
        });
        return response.ok;
      })()
    `, true);
    const liveGateRefreshObserved = liveGateRefreshTriggered && await waitFor(() => page.eval(`
      window.__aiteamQualityGateFetches > 0
    `, true), 5000);
    await page.eval(`
      if (window.__aiteamFetchBeforeQualityGateProbe) {
        window.fetch = window.__aiteamFetchBeforeQualityGateProbe;
        delete window.__aiteamFetchBeforeQualityGateProbe;
      }
    `);
    ok(
      `${label} benchmark gate refreshes on same-status evidence events without reopening the drawer`,
      Boolean(liveGateRefreshObserved),
    );
    ok(`${label} benchmark human audit shows five explicit checks`, await page.eval(`
      [
        '结论足以支持继续/停止决策',
        '关键事实、数字和能力声明都能回到任务证据',
        '没有编造字段、事件、状态、工具、来源或用户反馈',
        '七步工作流、负责人、退出条件和下一步可实际执行',
        '没有重复段落、占位符或为凑篇幅写的空泛内容',
      ].every((text) => document.body.innerText.includes(text))
    `));
    await page.clickText("确认质量并关单");
    await page.waitText("真实质量基准不能跳过三重验收");
    ok(`${label} benchmark UI refuses incomplete human audit instead of offering override`, await page.eval(`
      document.body.innerText.includes('真实质量基准不能跳过三重验收') &&
      document.body.innerText.includes('不能跳过三重验收')
    `));
    const directBenchmarkBypass = await page.eval(`
      fetch('/aiteam/api/tasks/${benchmarkTaskId}', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'done',
          human_audit: {
            decision_useful: true,
            evidence_traceable: true,
            no_fabrication: true,
            workflow_actionable: true,
            no_padding: true,
            note: '这是一条足够长但缺少独立 verdict 的绕过尝试。',
          },
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }))
    `, true);
    ok(
      `${label} benchmark API refuses direct close without independent pass verdict`,
      directBenchmarkBypass?.status === 400 && directBenchmarkBypass?.body?.code === "BENCHMARK_HUMAN_AUDIT_REQUIRED",
      JSON.stringify(directBenchmarkBypass),
    );
    await page.eval(`
      [...document.querySelectorAll('div')]
        .find((element) => (element.textContent || '').trim() === '三重验收')
        ?.scrollIntoView({ block: 'center' })
    `);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.screenshot(`benchmark-audit-${label}`);
    await assertNoHorizontalOverflow(page, `${label} benchmark audit drawer`);

    const cancelTitle = `UI取消语义-${label}-${Date.now()}`;
    const cancelTaskId = await page.eval(`
      (async () => {
        const res = await fetch('/aiteam/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: ${JSON.stringify(cancelTitle)} }),
        });
        const task = await res.json();
        if (!res.ok) throw new Error(task.error || 'create task failed');
        return task.id;
      })()
    `, true);
    await page.send("Page.navigate", { url: `${baseUrl}?task=${encodeURIComponent(cancelTaskId)}` });
    await page.waitText(cancelTitle);
    await page.waitText("取消任务");
    await page.eval(`window.confirm = () => true`);
    await page.clickText("取消任务");
    await page.waitText("已取消");
    const cancelled = await waitFor(() => page.eval(`
      fetch('/aiteam/api/tasks')
        .then((res) => res.json())
        .then((tasks) => tasks.some((task) => task.id === ${JSON.stringify(cancelTaskId)} && task.status === 'cancelled'))
    `, true));
    ok(`${label} cancellation is distinct from delivery close`, Boolean(cancelled));
    const terminalBudgetDisabled = await page.eval(`
      (() => {
        const budgetLabel = [...document.querySelectorAll('label')]
          .find((element) => element.textContent?.includes('设置预算'));
        const input = budgetLabel?.querySelector('input');
        const button = budgetLabel?.querySelector('button');
        return Boolean(input?.disabled && button?.disabled);
      })()
    `);
    ok(`${label} terminal task budget controls are disabled`, terminalBudgetDisabled);
    await page.screenshot(`cancelled-${label}`);
    await assertNoHorizontalOverflow(page, `${label} cancelled drawer`);
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
      NODE_ENV: "production",
      PORT: String(appPort),
      AITEAM_DATA_DIR: dataDir,
      AITEAM_SESSION_SECRET: "ui-smoke-session-secret-32-bytes-minimum",
      AITEAM_CREDENTIAL_KEY: "82".repeat(32),
      AITEAM_AUTH_MODE: "standalone",
      AITEAM_ALLOW_SIGNUP: "1",
      AITEAM_ADMIN_EMAILS: "ui-desktop@test.local,ui-mobile@test.local",
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
