#!/usr/bin/env node
/**
 * AITeam 自动化回归（机制级，Mock 模式零 token）
 * 覆盖 docs/TESTING.md 中可自动化的用例；智能质量类用例需真实 key 人工执行。
 *
 * 用法：npm run build && node scripts/regression.mjs
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 隔离测试库：所有读写（含 Phase 2 spawn 的子进程，env 继承）落在临时目录，
// 绝不触碰 server/data 生产工作区（那里有用户的密钥配置/项目/文档）。
const testDataDir = mkdtempSync(join(tmpdir(), "aiteam-regress-"));
process.env.AITEAM_DATA_DIR = testDataDir;
const PORT = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close((err) => (err ? reject(err) : resolve(port)));
  });
});
const TEST_INSTANCE_ID = `regress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
// 整合后所有路由挂在 /aiteam 前缀下（standalone 默认单一固定用户，requireUser 放行）
const BASE = `http://localhost:${PORT}/aiteam/api`;

const results = [];
let failures = 0;
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  if (ok !== true && ok !== "SKIP") failures++;
  const mark = ok === true ? "✅" : ok === "SKIP" ? "⏭️ " : "❌";
  console.log(`${mark} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 20000, interval = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 1：进程内直驱引擎（DAG / 计划把关 / 停止 / 预算 / 断点恢复）
// ---------------------------------------------------------------------------
const db = await import(join(root, "server/dist/db.js"));
const { seedGlobalSkills, seedForOwner, BUILTIN_SKILLS } = await import(join(root, "server/dist/seed.js"));
const { AGENT_TEMPLATES } = await import(join(root, "server/dist/agents/templates.js"));
const { enterOwner, ownerFromUserId } = await import(join(root, "server/dist/ownerScope.js"));
const { hashPassword } = await import(join(root, "server/dist/password.js"));
const engine = await import(join(root, "server/dist/agents/engine.js"));
const qualityBenchmark = await import(join(root, "server/dist/qualityBenchmark.js"));
const images = await import(join(root, "server/dist/agents/images.js"));

{
  let requestPath = "";
  let requestBody = {};
  let probeBase = "";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const imageProbe = createServer((req, res) => {
    if (req.method === "POST") {
      requestPath = req.url ?? "";
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { requestBody = JSON.parse(body); } catch { requestBody = {}; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ url: `${probeBase}/generated.png`, size: "2048x1152" }] }));
      });
      return;
    }
    if (req.url === "/generated.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(png.length) });
      res.end(png);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    imageProbe.once("error", reject);
    imageProbe.listen(0, "127.0.0.1", resolve);
  });
  const address = imageProbe.address();
  probeBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  db.setImageProvider({
    base_url: `${probeBase}/api/v3/images/generations`,
    api_key: "image-probe-key",
    model: "doubao-seedream-5-0-pro-260628",
  });
  const generated = await images.generateImage({ prompt: "一张克制的产品概念配图" });
  const assetName = generated.match(/\/aiteam\/assets\/([^\s)]+)/)?.[1] ?? "";
  await new Promise((resolve) => imageProbe.close(resolve));
  db.setImageProvider({ api_key: "-" });
  check(
    "QW4C",
    "Seedream 生图：完整端点不重复拼接、5.0 Pro 使用默认单图、URL 回传下载为持久资产",
    images.imageGenerationUrl("https://ark.cn-beijing.volces.com/api/v3") ===
      "https://ark.cn-beijing.volces.com/api/v3/images/generations" &&
      images.imageGenerationUrl("https://ark.cn-beijing.volces.com/api/v3/images/generations") ===
      "https://ark.cn-beijing.volces.com/api/v3/images/generations" &&
      requestPath === "/api/v3/images/generations" &&
      requestBody.model === "doubao-seedream-5-0-pro-260628" &&
      requestBody.sequential_image_generation === undefined &&
      images.imageRequestPayload("doubao-seedream-4-5", "probe", "2K").sequential_image_generation === "disabled" &&
      requestBody.stream === false &&
      requestBody.response_format === "url" &&
      assetName.endsWith(".png") &&
      existsSync(join(images.assetsDir, assetName)),
    `path=${requestPath} seedream5Sequential=${String(requestBody.sequential_image_generation)} legacySingle=${images.imageRequestPayload("doubao-seedream-4-5", "probe", "2K").sequential_image_generation} format=${requestBody.response_format} asset=${assetName}`,
  );
}

const benchmarkGoodReport = [
  "# AiTeam 14 天产品落地决策简报",
  "",
  "## 结论与推荐决策",
  "建议未来 14 天只验证一条闭环：完整简报进入后，AI 同事认领、交付、独立复核、按意见返工，最后由人类关单；未达到证据完整率建议阈值就停止扩功能。",
  "",
  "## 目标用户、核心待办与产品边界",
  "目标用户是需要委派高价值知识工作的 3–10 人小团队负责人。核心待办是把一个模糊目标变成可验收交付物，并能看见责任、过程和失败原因。当前产品边界只验证单工作区、结构化任务简报、AI 认领、文档交付、独立复核、自动返工和人类关单；不承诺外部市场数据、全自动经营或无人监督决策。",
  "",
  "## 核心工作流与证据",
  "| 步骤 | 责任人 | 可验证证据 | 失败处理 |",
  "|---|---|---|---|",
  "| goal | 人类发起人 | 目标字段与创建事件 | 缺目标不得开工 |",
  "| brief | 人类发起人 | 背景、交付物、验收标准 | 字段不全退回补充 |",
  "| claim | AI 执行者 | claim 事件与负责人 | 防止重复抢占 |",
  "| work | AI 执行者 | 工具事件与当前版文档 | 阻塞时请求输入 |",
  "| review | 独立复核者 | 结构化 verdict 与逐条理由 | 关键标准缺失判 revise |",
  "| revise | AI 执行者 | 新文档版本与 revision 计数 | 达上限转人工 |",
  "| human close | 人类发起人 | user_close 事件与完成状态 | 待审批时禁止关单 |",
  "",
  "## 按优先级排序的 14 天计划",
  "| 优先级 | 阶段目标 | 负责人 | 退出条件 | 可量化验收指标（建议阈值） |",
  "|---|---|---|---|---|",
  "| P0 / 第 1–3 天 | 固定简报与证据链 | 产品负责人、工程师 | 缺字段任务无法开工 | 10/10 个坏简报被拦截 |",
  "| P0 / 第 4–7 天 | 跑通交付与独立复核 | 工程师、复核人 | verdict 可回放且返工生成新版本 | 5/5 条任务留下完整事件 |",
  "| P1 / 第 8–11 天 | 邀请首批真实用户 | 产品负责人 | 用户能独立完成一次委派 | 建议阈值：完成率不少于 80% |",
  "| P1 / 第 12–14 天 | 复盘并做继续/停止决策 | 创始人 | 证据清单齐全 | 建议阈值：3 位用户中至少 2 位愿意复用 |",
  "",
  "## 执行细则",
  "### 1. 样本与简报门槛",
  "第 1 天由产品负责人准备五个真实但已脱敏的知识工作目标，并故意加入两个缺背景或缺验收标准的坏样本。观察新用户能否在不阅读说明书的前提下补齐交付物、验收标准和责任链；坏样本若仍可开工，先修简报入口，不进入模型质量比较。所有数量均为建议阈值。",
  "### 2. 认领与唯一责任人",
  "工程师在第 2–3 天回放多人同时认领、负责人改派和重复启动场景。每次运行必须能从任务详情定位唯一执行者、独立复核者及 claim 事件；出现两个执行者同时工作、旧执行者继续写入或责任人为空时，立即停止该轮并修复状态机。",
  "### 3. 工作过程证据",
  "第 4–5 天只检查一次完整交付：输入简报、允许的工具、实际工具调用、文档版本和用量应能按时间顺序回放。交付物中的每个产品能力声明要么来自本任务可信输入，要么明确写成待验证假设；不能把篇幅、模型自报字数或漂亮排版当作质量证据。",
  "### 4. 阻塞与用户输入",
  "第 6 天构造一个必须澄清才能继续的任务，确认执行者请求输入后任务真实停止，用户答复只恢复当前有效审批一次，旧授权和旧负责人上下文不得复活。若模型在缺少关键输入时仍继续生成完整报告，该任务直接判失败而不是用人工润色掩盖。",
  "### 5. 独立复核",
  "第 7–8 天让与执行者不同的强模型逐条核对七项标准，并保存结构化 verdict、理由和对应文档版本。复核者只能看到固定任务证据，不能通过额外检索替执行者补资料；机器契约未通过时不消耗强模型额度，避免让评审替空泛初稿兜底。",
  "### 6. 返工与版本链",
  "第 9 天故意植入一个超长结论和一个不存在的实现字段，验证机器预检能够指出具体差距并触发一次返工。返工提示必须重新携带全部可信事实、固定骨架、复核意见和标为不可信的上一版全文；新版产生后，旧版仍可回放但不能出现在当前交付列表。",
  "### 7. 首次使用体验",
  "第 10–11 天邀请三位未参与开发的测试者，只告诉他们要完成一份决策简报，不解释内部状态名。记录他们是否能找到目标入口、理解当前下一步、看到为什么被阻塞，并在复核后完成关单。建议阈值是至少两人无需口头指导跑完整条链路，否则先减界面复杂度。",
  "### 8. 成本与停止决策",
  "第 12–14 天汇总每次运行的输入输出用量、返工次数、机器契约结果、独立 verdict 和人工审计结论。创始人只在证据链完整且至少两位测试者愿意再次委派时继续扩展；任一任务突破批准预算、连续两轮编造事实或人工无法解释最终结论时，停止增加功能并回到最早失败步骤。",
  "",
  "## 关键风险、缓解动作与停止条件",
  "| 风险 | 缓解动作 | 停止条件 |",
  "|---|---|---|",
  "| 输出看似完整但没有证据 | 机器契约预检后再由独立模型复核 | 连续两轮仍缺关键证据就转人工 |",
  "| 模型成本失控 | 任务预算、复核预留与断点续跑 | 达到预算且未获批准立即停止 |",
  "| 新用户看不懂工作流 | 首屏只暴露下一步并观察首次任务 | 3 位测试者中 2 位无法独立开工则暂停扩展 |",
  "",
  "## 来源与假设",
  "本次未使用外部资料。",
  "内部事实仅来自任务简报与运行事件；没有调用 web_search、web_fetch 或 MCP。所有时间、数量、比例和停止条件均为建议阈值，待真实用户测试验证，不代表已有业绩或客户反馈。",
  "",
  "## 交付自查表",
  "| 标准 | 状态 | 正文证据位置 |",
  "|---|---|---|",
  "| 1 | 满足 | 结论与推荐决策 |",
  "| 2 | 满足 | 目标用户、核心待办与产品边界 |",
  "| 3 | 满足 | 核心工作流与证据表 |",
  "| 4 | 满足 | 14 天计划表 |",
  "| 5 | 满足 | 关键风险表三项 |",
  "| 6 | 满足 | 来源与假设 |",
  "| 7 | 满足 | 本交付自查表及以上证据位置 |",
].join("\n");

{
  const assess = engine.assessProviderQualityBenchmarkDocument;
  const benchmarkPrompt = engine.buildProviderQualityBenchmarkBrief({
    id: "prompt-contract",
    title: "真实模型质量基准：AiTeam 产品落地决策简报（离线）",
    description: "验证固定工作流",
    acceptance_criteria: "逐条验收",
  });
  const good = typeof assess === "function" ? assess(benchmarkGoodReport) : null;
  const hollow = typeof assess === "function"
    ? assess("# 决策简报\n\n建议尽快上线。\n\n## 自查表\n1. 满足\n2. 满足\n3. 满足\n4. 满足\n5. 满足\n6. 满足\n7. 满足")
    : null;
  const fabricated = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace("本次未使用外部资料。", "数据显示市场规模已经达到 100 亿元。"))
    : null;
  const inventedImplementation = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace(
        "本次未使用外部资料。",
        "本次未使用外部资料。系统把 goal 写入 tasks.goal，并生成 brief_generated 事件，最终设置 status=closed；供应商配置保存在 vendor_configs 表。",
      ))
    : null;
  const paraphrasedSourceBoundary = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace("本次未使用外部资料。", "本次未使用任何外部资料。"))
    : null;
  const misplacedSourceBoundary = typeof assess === "function"
    ? assess(benchmarkGoodReport
        .replace("# AiTeam 14 天产品落地决策简报", "# AiTeam 14 天产品落地决策简报\n\n本次未使用外部资料。")
        .replace("## 来源与假设\n本次未使用外部资料。", "## 来源与假设"))
    : null;
  const overlongConclusion = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace(
        "建议未来 14 天只验证一条闭环：完整简报进入后，AI 同事认领、交付、独立复核、按意见返工，最后由人类关单；未达到证据完整率建议阈值就停止扩功能。",
        "建议未来 14 天只验证一条闭环：完整简报进入后，AI 同事认领、交付、独立复核、按意见返工，最后由人类关单；未达到证据完整率建议阈值就停止扩功能。还应同步扩展频道、自动化、图像生成、外部连接、多人协作和更多模型，以便一次覆盖所有潜在需求并尽快形成完整平台。",
      ))
    : null;
  const repetitiveFiller = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace(
        /## 执行细则[\s\S]*?## 关键风险、缓解动作与停止条件/,
        `## 执行细则\n${Array.from({ length: 10 }, (_, index) => `### 重复检查 ${index + 1}\n每次只观察同一个问题，记录输入、动作、事件和状态；每次只观察同一个问题，记录输入、动作、事件和状态；每次只观察同一个问题，记录输入、动作、事件和状态；所有数字都是建议阈值，等待真实用户测试后确认。`).join("\n")}\n## 关键风险、缓解动作与停止条件`,
      ))
    : null;
  const thinPlan = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace(
        /\| P0 \/ 第 1–3 天[\s\S]*?\| P1 \/ 第 12–14 天[^\n]*/,
        "| P0 / 第 1–14 天 | 一次完成所有工作 | 产品负责人 | 输出一份报告 | 建议阈值：完成一次闭环 |",
      ))
    : null;
  const proseOnlyWorkflowStep = typeof assess === "function"
    ? assess(benchmarkGoodReport.replace(
        "| revise | AI 执行者 | 新文档版本与 revision 计数 | 达上限转人工 |",
        "revise 步骤由 AI 执行者负责，产出新文档版本并在达到上限时转人工。",
      ))
    : null;
  const legitimateLabelTables = typeof assess === "function"
    ? assess(benchmarkGoodReport
        .replace("| 3 | 满足 | 核心工作流与证据表 |", "| 3 | 满足 | 第 3 节 human close 表 |")
        .replace("| 4 | 满足 | 14 天计划表 |", "| 4 | 满足 | 第 4 节 KPI 表 |"))
    : null;
  const numberedNested = typeof assess === "function"
    ? assess(
        benchmarkGoodReport
          .replace("## 结论与推荐决策", "## 1. 结论与推荐决策")
          .replace("## 关键风险、缓解动作与停止条件", "## 5. 关键风险、缓解动作与停止条件")
          .replace(
            "| 风险 | 缓解动作 | 停止条件 |\n|---|---|---|\n| 输出看似完整但没有证据 | 机器契约预检后再由独立模型复核 | 连续两轮仍缺关键证据就转人工 |\n| 模型成本失控 | 任务预算、复核预留与断点续跑 | 达到预算且未获批准立即停止 |\n| 新用户看不懂工作流 | 首屏只暴露下一步并观察首次任务 | 3 位测试者中 2 位无法独立开工则暂停扩展 |",
            "### 风险 1：输出看似完整但没有证据\n| 要素 | 内容 |\n|---|---|\n| 缓解动作 | 机器契约预检后再由独立模型复核 |\n| 停止条件 | 连续两轮仍缺关键证据就转人工 |\n\n### 风险 2：模型成本失控\n| 要素 | 内容 |\n|---|---|\n| 缓解动作 | 任务预算、复核预留与断点续跑 |\n| 停止条件 | 达到预算且未获批准立即停止 |\n\n### 风险 3：新用户看不懂工作流\n| 要素 | 内容 |\n|---|---|\n| 缓解动作 | 首屏只暴露下一步并观察首次任务 |\n| 停止条件 | 3 位测试者中 2 位无法独立开工则暂停扩展 |",
          )
      )
    : null;
  const chineseNumbered = typeof assess === "function"
    ? assess(
        benchmarkGoodReport
          .replace("## 结论与推荐决策", "## 一、结论与推荐决策")
          .replace("## 交付自查表", "## 七、逐条自查表")
          .replaceAll("| 1 | 满足 |", "| **1. 标准一** | 满足 |")
          .replaceAll("| 2 | 满足 |", "| **2. 标准二** | 满足 |")
          .replaceAll("| 3 | 满足 |", "| **3. 标准三** | 满足 |")
          .replaceAll("| 4 | 满足 |", "| **4. 标准四** | 满足 |")
          .replaceAll("| 5 | 满足 |", "| **5. 标准五** | 满足 |")
          .replaceAll("| 6 | 满足 |", "| **6. 标准六** | 满足 |")
          .replaceAll("| 7 | 满足 |", "| **7. 标准七** | 满足 |"),
      )
    : null;
  check(
    "QW4",
    "固定质量基准机器契约：完整报告放行，空泛自称满足的报告拒绝并列出差距",
    good?.pass === true && good.gaps.length === 0 &&
      numberedNested?.pass === true && numberedNested.gaps.length === 0 &&
      chineseNumbered?.pass === true && chineseNumbered.gaps.length === 0 &&
      hollow?.pass === false && hollow.gaps.length >= 5 &&
      fabricated?.pass === false && fabricated.gaps.some((gap) => gap.includes("URL")) &&
      inventedImplementation?.pass === false && inventedImplementation.gaps.some((gap) => gap.includes("精确字段")) &&
      paraphrasedSourceBoundary?.pass === false && paraphrasedSourceBoundary.gaps.some((gap) => gap.includes("独立一行")) &&
      misplacedSourceBoundary?.pass === false && misplacedSourceBoundary.gaps.some((gap) => gap.includes("独立一行")) &&
      overlongConclusion?.pass === false && overlongConclusion.gaps.some((gap) => gap.includes("120 字")) &&
      repetitiveFiller?.pass === false && repetitiveFiller.gaps.some((gap) => gap.includes("重复 3 次")) &&
      thinPlan?.pass === false && thinPlan.gaps.some((gap) => gap.includes("至少需要 3 个")) &&
      proseOnlyWorkflowStep?.pass === false && proseOnlyWorkflowStep.gaps.some((gap) => gap.includes("revise")) &&
      legitimateLabelTables?.pass === true && legitimateLabelTables.gaps.length === 0 &&
      benchmarkPrompt.includes("当前产品已经有 Electron 桌面客户端") &&
      benchmarkPrompt.includes("| human close | ... | ... | ... |") &&
      benchmarkPrompt.includes("14 天计划至少拆成三个阶段") &&
      benchmarkPrompt.includes("本次未使用外部资料。") &&
      benchmarkPrompt.includes("| 7 | 满足/不满足 | ... |"),
    `assessor=${typeof assess} prompt=${benchmarkPrompt.length} good=${good?.pass}/${good?.gaps.length} numbered=${numberedNested?.pass}/${numberedNested?.gaps.length} chinese=${chineseNumbered?.pass}/${chineseNumbered?.gaps.length} hollow=${hollow?.pass}/${hollow?.gaps.length} fabricated=${fabricated?.pass}/${fabricated?.gaps.length} invented=${inventedImplementation?.pass}/${inventedImplementation?.gaps.length} source=${paraphrasedSourceBoundary?.pass}/${paraphrasedSourceBoundary?.gaps.length}/${misplacedSourceBoundary?.pass}/${misplacedSourceBoundary?.gaps.length} conclusion=${overlongConclusion?.pass}/${overlongConclusion?.gaps.length} repetitive=${repetitiveFiller?.pass}/${repetitiveFiller?.gaps.length} plan=${thinPlan?.pass}/${thinPlan?.gaps.length} workflow=${proseOnlyWorkflowStep?.pass}/${proseOnlyWorkflowStep?.gaps.length} labels=${legitimateLabelTables?.pass}/${legitimateLabelTables?.gaps.length}`,
  );
}

{
  const mockDoc = engine.mockTaskDocument?.({
    title: "为新用户输出上手方案",
    description: "帮助首次使用者完成一次从目标到人工关单的协作任务。",
    acceptance_criteria: "开头说明核心结论\n文末提供逐条自查",
  }, "产品经理") ?? "";
  check(
    "QW4D",
    "Mock 交付物诚实展示质量结构：明确演示边界、结论、风险、来源和逐条自查",
    mockDoc.includes("Mock 演示交付") &&
      mockDoc.includes("不可作为真实业务决策依据") &&
      mockDoc.includes("## 结论先行") &&
      mockDoc.includes("## 风险与停止条件") &&
      mockDoc.includes("本次未使用外部资料") &&
      mockDoc.includes("## 交付自查表") &&
      mockDoc.includes("文末提供逐条自查"),
    `len=${mockDoc.length}`,
  );
}

{
  const actors = { workerAgentId: "worker", reviewerAgentId: "reviewer" };
  const cleanTrace = qualityBenchmark.providerBenchmarkSourceTrace(
    [
      { id: "e1", type: "tool", agent_id: "worker", metadata_json: JSON.stringify({ tool: "write_document" }) },
      { id: "e2", type: "tool", agent_id: "reviewer", metadata_json: JSON.stringify({ tool: "submit_verdict" }) },
    ],
    [{ content: "本次未使用任何外部资料，包括但不限于 web_search、web_fetch、浏览器、插件或 MCP。当前产品支持 MCP 工具，但本次没有调用。" }],
    actors,
  );
  const badTrace = qualityBenchmark.providerBenchmarkSourceTrace(
    [
      { id: "e3", type: "tool", agent_id: "worker", metadata_json: JSON.stringify({ tool: "web_search" }) },
      { id: "e4", type: "tool", agent_id: "reviewer", metadata_json: JSON.stringify({ tool: "write_document" }) },
    ],
    [{ content: "报告通过 browser 插件和 web_search 检索获得外部资料。" }],
    actors,
  );
  const allPassChecks = {
    completed: true,
    delivered: true,
    tool_observed: true,
    verified: true,
    usage_tracked: true,
    quality_contract: true,
    independent_reviewer: true,
    verdict_recorded: true,
    within_budget: true,
    source_trace_clean: true,
    document_contract: true,
    pending_approval: false,
  };
  check(
    "QW4B",
    "固定质量基准来源账本：仅接受执行者 write_document 与复核者 submit_verdict，且未完成任务禁止通过",
    cleanTrace.clean === true &&
      cleanTrace.authorized_tools.length === 2 &&
      badTrace.clean === false &&
      badTrace.unauthorized_tool_events.length === 2 &&
      ["browser", "plugin", "web_search"].every((tool) => badTrace.unobserved_claims.includes(tool)) &&
      qualityBenchmark.providerBenchmarkPassed(allPassChecks) === true &&
      qualityBenchmark.providerBenchmarkPassed({ ...allPassChecks, completed: false }) === false,
    `clean=${cleanTrace.clean}/${cleanTrace.authorized_tools.length} bad=${badTrace.clean}/${badTrace.unauthorized_tool_events.length}/${badTrace.unobserved_claims.join(",")} completedGate=${qualityBenchmark.providerBenchmarkPassed({ ...allPassChecks, completed: false })}`,
  );
}

// 多用户登录架构：建一个测试账号，Phase 1 进入其 owner 上下文播种私有工作区；
// Phase 2 用同一账号登录 → 同一 owner → 共享同库工作区。
const TEST_EMAIL = "regress@test.local";
const TEST_PW = "regress-pw-123";
seedGlobalSkills();
const testUser = db.createUser({ email: TEST_EMAIL, password_hash: hashPassword(TEST_PW), display_name: "回归用户", role: "admin" });
enterOwner(ownerFromUserId(testUser.id));
seedForOwner();
const agents = db.listAgents();
const pm = agents[0];
const eng = agents[1];
const ch = db.listChannels()[0];
const skillNames = new Set(db.listSkills().map((s) => s.name));
check("P0", `种子：4 内置同事 + ${BUILTIN_SKILLS.length} 内置技能（含扩库新技能）`,
  agents.length === 4 &&
  db.listSkills().length === BUILTIN_SKILLS.length &&
  skillNames.has("信息图/封面/配图生成法") && skillNames.has("可验证规格法") && skillNames.has("文档解析能力"),
  `技能数=${db.listSkills().length}/${BUILTIN_SKILLS.length}`);

{
  const reworkPrompt = engine.buildProviderQualityBenchmarkReworkBrief({
    id: "rework-contract",
    title: "真实模型质量基准：AiTeam 产品落地决策简报（离线返工）",
    description: "验证隔离返工上下文",
    acceptance_criteria: "1. 结论；2. 证据；3. 自查",
  }, "删除编造字段，并缩短开头结论");
  check(
    "QW4R",
    "固定质量基准返工：隔离上下文重新携带可信产品事实、固定骨架与具体复核意见",
    reworkPrompt.includes("当前产品已经有 Electron 桌面客户端") &&
      reworkPrompt.includes("当前已经使用 SQLite") &&
      reworkPrompt.includes("| goal | ... | ... | ... |") &&
      reworkPrompt.includes("本次未使用外部资料。") &&
      reworkPrompt.includes("删除编造字段，并缩短开头结论") &&
      reworkPrompt.includes("你处于隔离上下文"),
    `length=${reworkPrompt.length}`,
  );
}

{
  const storeSource = readFileSync(join(root, "web/src/store.tsx"), "utf8");
  const appSource = readFileSync(join(root, "web/src/App.tsx"), "utf8");
  const focusSource = readFileSync(join(root, "web/src/components/FocusWorkspace.tsx"), "utf8");
  const uiSmokeSource = readFileSync(join(root, "scripts/ui-smoke.mjs"), "utf8");
  const worklineSource = readFileSync(join(root, "web/src/components/WorklineOverview.tsx"), "utf8");
  const tasksBoardSource = readFileSync(join(root, "web/src/components/TasksBoard.tsx"), "utf8");
  const taskDetailSource = readFileSync(join(root, "web/src/components/TaskDetailDrawer.tsx"), "utf8");
  const taskBriefSource = readFileSync(join(root, "web/src/components/TaskBriefComposer.tsx"), "utf8");
  const inboxSource = readFileSync(join(root, "web/src/components/InboxView.tsx"), "utf8");
  const modalsSource = readFileSync(join(root, "web/src/components/Modals.tsx"), "utf8");
  const worklineLibSource = readFileSync(join(root, "web/src/lib/workline.ts"), "utf8");
  const routesSource = readFileSync(join(root, "server/src/routes.ts"), "utf8");
  const defaultWorkline = /view:\s*\{\s*kind:\s*"workline"\s*\}/.test(storeSource);
  const bootstrapKeepsView = /view:\s*keepValidView\(state\.view,\s*d\.channels\)/.test(storeSource);
  const loadDoesNotForceChannel = !/const first = data\.channels\.find[\s\S]*?openChannel\(first\.id\)/.test(storeSource);
  const focusComposerIsPrimary =
    focusSource.includes("今天要推进什么？") &&
    focusSource.includes("描述目标、期望交付和截止时间…") &&
    focusSource.includes("FOCUS_SHORTCUTS") &&
    focusSource.includes("resolveFocusIntent") &&
    focusSource.includes("shortcutForGoal") &&
    focusSource.includes("pickFocusReviewer") &&
    focusSource.includes("复核：") &&
    focusSource.includes("ws.createTask") &&
    focusSource.includes("budget_billable: 16_000") &&
    uiSmokeSource.includes("focus task reaches review with deliverable and audit trail") &&
    uiSmokeSource.includes("closing without a pass verdict requires explicit human acknowledgement") &&
    uiSmokeSource.includes("human_override === true") &&
    focusSource.includes("进行中的任务") &&
    !appSource.includes("WelcomeOverlay");
  check("UX1", "首屏体验：默认落 Focus Composer，一次只突出目标提交、快捷入口和少量当前任务",
    defaultWorkline && bootstrapKeepsView && loadDoesNotForceChannel && focusComposerIsPrimary,
    `defaultWorkline=${defaultWorkline} bootstrapKeepsView=${bootstrapKeepsView} loadNoChannel=${loadDoesNotForceChannel} focusComposer=${focusComposerIsPrimary}`);
  const projectCloseCta =
    worklineSource.includes("closableProject") &&
    worklineSource.includes("确认关闭项目") &&
    worklineSource.includes("closeReadyProject") &&
    worklineSource.includes("approval.ref_id === project.id");
  check("UX2", "任务运行线：项目全量交付且无待审批时，顶部下一步直接进入项目级人类关单",
    projectCloseCta,
    `projectCloseCta=${projectCloseCta}`);
  const worklineViewSource = readFileSync(join(root, "web/src/components/WorklineView.tsx"), "utf8");
  const normalScenarioKeepsWorkline =
    worklineViewSource.includes("startCoreScenario") &&
    !/else\s*\{\s*setOpenTask\(result\.tasks\[0\]/.test(worklineViewSource) &&
    !/startCoreScenario/.test(tasksBoardSource);
  check("UX3", "任务运行线：普通场景启动后停留在工作台全局视图，不自动弹出单任务抽屉（场景逻辑单点在 WorklineView）",
    normalScenarioKeepsWorkline,
    `normalScenarioKeepsWorkline=${normalScenarioKeepsWorkline}`);
  const multiProviderLinkCheck =
    worklineSource.includes("providersToTest") &&
    worklineSource.includes("for (const provider of providersToTest)") &&
    worklineSource.includes("api.providerTaskTestPlan(provider.id)") &&
    worklineSource.includes("providerBenchmarkBatchConfirmation(availablePlans)") &&
    worklineSource.includes("providerBenchmarkRunInput(plan, runArg)") &&
    worklineSource.includes("所有已配置模型") &&
    worklineSource.includes("模型对比摘要") &&
    worklineSource.includes("providerPassed") &&
    worklineSource.includes("persistedLinkCheckResults") &&
    worklineSource.includes("visibleLinkCheckResults") &&
    worklineSource.includes("parseEventMeta") &&
    worklineSource.includes("eventTypes.has(\"tool\")") &&
    worklineSource.includes("eventTypes.has(\"verification\")") &&
    worklineSource.includes("provider_task_test") &&
    worklineSource.includes("usage_tracked") &&
    worklineSource.includes("quality_contract") &&
    worklineSource.includes("document_contract") &&
    worklineSource.includes("independent_reviewer") &&
    worklineSource.includes("verdict_recorded") &&
    worklineSource.includes("within_budget") &&
    worklineSource.includes("source_trace_clean") &&
    worklineSource.includes("pending_approval") &&
    worklineSource.includes("同构质量基准") &&
    worklineSource.includes("latency_ms") &&
    worklineSource.includes("usage_summary") &&
    worklineSource.includes("billable") &&
    worklineSource.includes("estimated_cost") &&
    worklineSource.includes("blockedWithoutPendingApproval") &&
    worklineSource.includes("inputOrApprovalCount");
  check("UX3B", "配置链路验收：所有已配置模型供应商逐个跑同构任务演练并汇入同一项目",
    multiProviderLinkCheck,
    `multiProviderLinkCheck=${multiProviderLinkCheck}`);
  const providerSetupLoop =
    modalsSource.includes("SiliconFlow GLM") &&
    modalsSource.includes("百炼 DashScope") &&
    modalsSource.includes("保存后立即跑质量基准") &&
    modalsSource.includes("runProviderTaskTest(saved.id)") &&
    modalsSource.includes("api.providerTaskTestPlan(id)") &&
    modalsSource.includes("providerBenchmarkConfirmation(plan)") &&
    modalsSource.includes("providerBenchmarkRunInput(plan)") &&
    modalsSource.includes("查看结果") &&
    modalsSource.includes("运行质量基准") &&
    modalsSource.includes("7项契约") &&
    modalsSource.includes("机器预检") &&
    modalsSource.includes("独立复核") &&
    modalsSource.includes("实际 token 上限、复核预留和可估算金额") &&
    modalsSource.includes("复核预算待批") &&
    modalsSource.includes("不重复生成") &&
    modalsSource.includes("来源可追溯") &&
    modalsSource.includes("usage_summary") &&
    modalsSource.includes("billable") &&
    modalsSource.includes("price_input_per_million") &&
    modalsSource.includes("estimated_cost");
  check("UX4", "模型配置体验：国内供应商预设可保存后直接跑固定质量基准并跳转任务详情",
    providerSetupLoop,
    `providerSetupLoop=${providerSetupLoop}`);
  const paidBenchmarkConsent =
    routesSource.includes("/providers/:id/task-test/plan") &&
    routesSource.includes("PROVIDER_BENCHMARK_BUDGET_CONFIRMATION_REQUIRED") &&
    routesSource.includes("confirmed_budget_billable") &&
    modalsSource.includes("已取消 · 未调用模型、未创建任务") &&
    worklineSource.includes("用户取消预算确认 · 未调用模型、未创建基准任务") &&
    worklineSource.includes("取消不会调用模型");
  check(
    "UX4B",
    "真实模型费用确认：单模型与批量链路验收都先展示动态预算，取消零调用，API 不能绕过",
    paidBenchmarkConsent,
    `paidBenchmarkConsent=${paidBenchmarkConsent}`,
  );
  const taskReviewEvidencePanel =
    taskDetailSource.includes("人工复核清单") &&
    taskDetailSource.includes("splitAcceptanceCriteria") &&
    taskDetailSource.includes("deliveryEvidence") &&
    taskDetailSource.includes("selfCheckEvidence") &&
    taskDetailSource.includes("latestVerdict") &&
    taskDetailSource.includes("暂无结构化裁决") &&
    taskDetailSource.includes("closeEvidenceGaps") &&
    taskDetailSource.includes("pendingApprovalCount") &&
    taskDetailSource.includes("closeDisabled") &&
    taskDetailSource.includes("先处理该任务的审批或输入");
  check("UX5", "任务详情：人工复核清单把验收标准、交付证据、自查表、复核和审批状态放在同一处",
    taskReviewEvidencePanel,
    `reviewEvidencePanel=${taskReviewEvidencePanel}`);
  const benchmarkHumanAuditGate =
    taskDetailSource.includes("真实质量基准 · 人工审计") &&
    taskDetailSource.includes("decision_useful") &&
    taskDetailSource.includes("evidence_traceable") &&
    taskDetailSource.includes("no_fabrication") &&
    taskDetailSource.includes("workflow_actionable") &&
    taskDetailSource.includes("no_padding") &&
    taskDetailSource.includes("提交人工审计并关单") &&
    taskDetailSource.includes("不能用人工 override 跳过") &&
    routesSource.includes("BENCHMARK_HUMAN_AUDIT_REQUIRED") &&
    routesSource.includes("machine_contract_passed") &&
    routesSource.includes("task-level human audit before project close");
  check(
    "UX5B",
    "真实质量基准人工审计：五项确认+决策说明落审计事件，任务/项目关单都不能绕过",
    benchmarkHumanAuditGate,
    `humanAuditGate=${benchmarkHumanAuditGate}`,
  );
  const inboxResolutionLoop =
    inboxSource.includes("resolveInboxApproval") &&
    inboxSource.includes("setResolvingId") &&
    inboxSource.includes("await ws.refreshWorkspace()") &&
    inboxSource.includes("setOpenTask(linkedTask)") &&
    inboxSource.includes("处理中…");
  check("UX6", "收件箱：处理审批/输入后刷新工作区并回到关联任务详情",
    inboxResolutionLoop,
    `inboxResolutionLoop=${inboxResolutionLoop}`);
  const scopedNetworkApprovalUi =
    inboxSource.includes("parseNetworkApprovalPayload") &&
    inboxSource.includes("一次性网络外发") &&
    inboxSource.includes("完整参数") &&
    inboxSource.includes("wrap-anywhere") &&
    inboxSource.includes("批准一次并恢复") &&
    taskDetailSource.includes("formatNetworkApprovalPayload") &&
    taskDetailSource.includes("调整后重试") &&
    taskDetailSource.includes("批准一次并恢复") &&
    worklineLibSource.includes("审批已处理或上下文已变化");
  check(
    "UX6B",
    "network 审批体验：显示目标/工具/参数/单次范围，拒绝后可调整并重新尝试",
    scopedNetworkApprovalUi,
    `scopedNetworkApprovalUi=${scopedNetworkApprovalUi}`,
  );
  const cancellationUi =
    taskDetailSource.includes('task.status === "review" ? "done" : "cancelled"') &&
    taskDetailSource.includes("取消只归档，不代表验收通过") &&
    tasksBoardSource.includes('{ key: "cancelled", label: "已取消" }') &&
    worklineLibSource.includes('t.status !== "done" && t.status !== "cancelled"');
  check("UX7", "取消任务：UI 明确区分验收关单与取消归档，取消项不计入活跃任务",
    cancellationUi,
    `cancellationUi=${cancellationUi}`);
  const cancelledProjectCloseUi =
    tasksBoardSource.includes('t.status === "review" || t.status === "done" || t.status === "cancelled"') &&
    tasksBoardSource.includes("statusCounts.review") &&
    tasksBoardSource.includes("statusCounts.cancelled") &&
    tasksBoardSource.includes("已取消任务保持「已取消」") &&
    worklineSource.includes('task.status === "review" || task.status === "done" || task.status === "cancelled"') &&
    worklineSource.includes("closableCancelledCount") &&
    worklineSource.includes("已取消任务保持「已取消」") &&
    worklineSource.includes('linkCheckProject?.status === "done"') &&
    worklineSource.includes("linkCheckCancelled") &&
    worklineViewSource.includes("acceptanceTerminal") &&
    worklineViewSource.includes('acceptanceProject.status === "done"') &&
    worklineViewSource.includes("acceptanceCancelled");
  check(
    "UX7B",
    "取消项目：任务看板与工作台都允许终态项目关单，并准确区分待评审与已取消数量",
    cancelledProjectCloseUi,
    `cancelledProjectCloseUi=${cancelledProjectCloseUi}`,
  );
  const testingSource = readFileSync(join(root, "docs/TESTING.md"), "utf8");
  const guideSource = readFileSync(join(root, "docs/GUIDE.md"), "utf8");
  const manualUatPaths =
    testingSource.includes("http://localhost:8787/aiteam/") &&
    testingSource.includes("http://localhost:5173/aiteam/") &&
    testingSource.includes("http://localhost:8787/aiteam/api/export.md") &&
    testingSource.includes("会返回 `401`") &&
    guideSource.includes("http://localhost:8787/aiteam/api/export.md");
  check(
    "UX8",
    "人工 UAT 文档：入口包含 /aiteam/，导出路径正确并明确需要登录态",
    manualUatPaths,
    `manualUatPaths=${manualUatPaths}`,
  );
  const taskBriefFlow =
    taskBriefSource.includes("新建任务简报") &&
    taskBriefSource.includes("预期交付物") &&
    taskBriefSource.includes("验收标准") &&
    taskBriefSource.includes("创建并开工") &&
    taskBriefSource.includes("负责人和复核人不能是同一位") &&
    taskBriefSource.includes("acceptance_criteria: acceptance") &&
    tasksBoardSource.includes("TaskBriefComposer") &&
    worklineViewSource.includes("TaskBriefComposer");
  check(
    "UX9",
    "任务简报：工作台与看板共用目标/交付物/验收/责任链入口，完整后才允许开工",
    taskBriefFlow,
    `taskBriefFlow=${taskBriefFlow}`,
  );
}

// C2 依赖调度 + 项目汇总
{
  const project = db.createProject({ channel_id: ch.id, lead_agent_id: pm.id, title: "回归-DAG", goal: "依赖与汇总" });
  const A = db.createTask({ channel_id: ch.id, title: "回归A", assignee_agent_id: eng.id, created_by: pm.id, project_id: project.id });
  const B = db.createTask({ channel_id: ch.id, title: "回归B", assignee_agent_id: eng.id, created_by: pm.id, project_id: project.id, depends_on: [A.id] });
  engine.onTaskAssigned(A);
  engine.onTaskAssigned(B);
  const done = await waitFor(() => {
    const p = db.getProject(project.id);
    return p.status !== "running" && p.summary_doc_id;
  }, 30000);
  // Mock 执行极快，状态快照会竞态；用审计轨迹断言 B 走了"等依赖→解锁"路径
  const unlocked = db.listMessages(ch.id, 100).some((x) => x.content.includes("⛓️") && x.content.includes("回归B"));
  check("C2", "项目 DAG：B 等待依赖 → A 交付解锁 → Lead 自动汇总", unlocked && done,
    `解锁事件=${unlocked}, 汇总=${done}`);
}

// C3 计划把关
{
  const project = db.createProject({ channel_id: ch.id, lead_agent_id: pm.id, title: "回归-把关", autonomy: "approve_plan", status: "planned" });
  const T = db.createTask({ channel_id: ch.id, title: "回归-把关任务", assignee_agent_id: eng.id, created_by: pm.id, project_id: project.id });
  engine.onTaskAssigned(T);
  await sleep(800);
  const held = db.getTask(T.id).status === "todo";
  engine.onPlanResolved(project.id, true);
  const ran = await waitFor(() => db.getTask(T.id).status === "review", 20000);
  check("C3", "计划把关：批准前不开工，批准后自动执行", held && ran, `批准前todo=${held}, 批准后review=${ran}`);
}

// HC1 任务认领：未分配任务可由 AI claim；已归属任务不可被其他同事抢占；结构化活动留痕
{
  const T = db.createTask({ channel_id: ch.id, title: "回归-认领", created_by: "user" });
  const claimed = engine.claimTaskForAgent(eng, T.id, "回归测试接手");
  const duplicate = engine.claimTaskForAgent(pm, T.id, "不应抢占");
  const events = db.listTaskEvents(T.id);
  const ok =
    claimed.ok === true &&
    duplicate.ok === false &&
    db.getTask(T.id).assignee_agent_id === eng.id &&
    events.some((e) => e.type === "claim" && e.agent_id === eng.id);
  check("HC1", "任务认领：未分配可 claim、已归属防抢占、结构化 claim 事件留痕", ok,
    `claimed=${claimed.ok} duplicate=${duplicate.ok} events=${events.map((e) => e.type).join(",")}`);
}

// HC2 阻塞/需要输入：AI 请求 clarification → 任务 blocked + pending approval；用户确认后恢复并自动交付
{
  const T = db.createTask({ channel_id: ch.id, title: "回归-阻塞恢复", assignee_agent_id: eng.id, created_by: "user" });
  const req = engine.requestClarificationForTask(eng, T, "请选择输出语气", "没有语气选择会影响最终交付口径", "专业克制");
  const dupReq = engine.requestClarificationForTask(eng, db.getTask(T.id), "重复问题", "不应新建", "不应覆盖");
  const blocked = db.getTask(T.id).status === "blocked";
  const approval = db.listApprovals().find((a) => a.id === req.approvalId);
  const pending = approval?.kind === "clarification" && approval.status === "pending" && approval.ref_id === T.id && dupReq.approvalId === req.approvalId;
  const userResponse = "使用正式但不生硬的产品评审语气";
  db.updateApprovalPayload(req.approvalId, JSON.stringify({ ...JSON.parse(approval.payload), user_response: userResponse }, null, 2));
  const resolved = db.resolveApproval(req.approvalId, true);
  engine.onClarificationResolved(resolved, true);
  const resumed = await waitFor(() => db.getTask(T.id).status === "review", 20000);
  engine.onClarificationResolved(resolved, true);
  await sleep(400);
  const stillReview = db.getTask(T.id).status === "review";
  const taskEvents = db.listTaskEvents(T.id);
  const events = taskEvents.map((e) => e.type);
  const carriedInput = db.getApproval(req.approvalId).payload.includes(userResponse) && taskEvents.some((e) => e.summary.includes(userResponse) || e.metadata_json.includes(userResponse));
  check("HC2", "阻塞输入：clarification 使任务 blocked，用户确认后清阻塞并恢复自动执行",
    blocked && pending && resumed && stillReview && carriedInput && events.includes("blocked") && events.includes("approval"),
    `blocked=${blocked} pending=${pending} resumed=${resumed} stillReview=${stillReview} carriedInput=${carriedInput} events=${events.join(",")}`);
}

// C5 停止开关（排队前取消）
{
  const T = db.createTask({ channel_id: ch.id, title: "回归-停止", assignee_agent_id: eng.id, created_by: "user" });
  engine.stopTask(T.id);
  engine.onTaskAssigned(T);
  await sleep(800);
  check("C5", "停止开关：被停止的任务不开工、留在待办", db.getTask(T.id).status === "todo");
}

// D6 预算护栏
{
  const m = db.insertMessage({ channel_id: ch.id, author_type: "agent", author_id: eng.id, content: "用量占位" });
  db.updateMessage(m.id, { usage_json: JSON.stringify({ input_tokens: 10, output_tokens: 10 }) });
  process.env.AITEAM_DAILY_TOKEN_BUDGET = "5";
  const T = db.createTask({ channel_id: ch.id, title: "回归-预算", assignee_agent_id: eng.id, created_by: "user" });
  engine.onTaskAssigned(T);
  await sleep(600);
  const held = db.getTask(T.id).status === "todo";
  const audited = db.listMessages(ch.id, 50).some((x) => x.content.includes("🧯"));
  delete process.env.AITEAM_DAILY_TOKEN_BUDGET;
  check("D6", "预算护栏：超限不开工并留痕", held && audited);
}

// D5 断点恢复
{
  const T = db.createTask({ channel_id: ch.id, title: "回归-恢复", assignee_agent_id: eng.id, created_by: "user", status: "doing" });
  engine.recoverInFlightTasks();
  const ok = await waitFor(() => db.getTask(T.id).status === "review", 20000);
  check("D5", "断点恢复：doing 任务重启后续跑至交付", ok);
}

// QW1 验收防放水：校验者未给结构化裁决时，兜底为 revise（fail-closed），绝不默认通过
check(
  "QW1",
  "验收防放水：无结构化裁决兜底为 revise 而非 pass",
  engine.NO_VERDICT_FALLBACK.result === "revise" && engine.NO_VERDICT_FALLBACK.reasons.length > 0
);

// QW2 产出规范上移：buildWorkBrief 第 5 点强制结论先行 + 来源标注 + 交付自查表（运行时普惠所有任务）
{
  const T = db.createTask({ channel_id: ch.id, title: "回归-自查", assignee_agent_id: eng.id, created_by: "user" });
  const brief = engine.buildWorkBrief(db.getTask(T.id), ch);
  const ok = brief.includes("自查表") && brief.includes("结论先行") && brief.includes("来源");
  check("QW2", "产出规范常驻：工作简报强制结论先行+来源+自查表", ok);
}

// QW3 计费分列：缓存读/写单独累计且加权计费，老行（无 cache_* 字段）向后兼容
{
  const u = db.readUsage(JSON.stringify({ input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, cache_creation_tokens: 200 }));
  // promptTotal=100+1000+200=1300；billable=100+50+200*1.25+1000*0.1=500（缓存读按 1/10 价）
  const fresh = u.promptTotal === 1300 && u.billable === 500;
  const old = db.readUsage(JSON.stringify({ input_tokens: 300, output_tokens: 60 }));
  const compat = old.promptTotal === 300 && old.billable === 360; // 老行无缓存字段：promptTotal=纯输入，billable=输入+输出
  check("QW3", "计费分列：缓存读/写加权计费 + 老行兼容", fresh && compat);
}

// DOC1 文档版本归并：同 (task_id,kind) 再写即出新版覆盖旧版，listDocuments 只显当前版，历史可查
{
  const T = db.createTask({ channel_id: ch.id, title: "回归-文档版本", assignee_agent_id: eng.id, created_by: "user" });
  const v1 = db.createDocument({ channel_id: ch.id, task_id: T.id, agent_id: eng.id, title: "回归报告 v1", content: "一", kind: "report" });
  const v2 = db.createDocument({ channel_id: ch.id, task_id: T.id, agent_id: eng.id, title: "回归报告 v2", content: "二", kind: "report" });
  const current = db.listDocuments().filter((d) => d.task_id === T.id);
  const v1row = db.getDocument(v1.id);
  const versions = db.listDocumentVersions(T.id, "report");
  const ok =
    current.length === 1 && current[0].id === v2.id && current[0].version === 2 &&
    v1row.superseded_by === v2.id && versions.length === 2;
  check("DOC1", "文档版本归并：同任务同 kind 再写出新版、列表只显当前版、历史可查", ok);
}

// PPTX2 幻灯片解析：Markdown 表格→结构化表格 + 围栏代码块捕获（不再压成项目符号）
{
  const { parseSlides } = await import(join(root, "server/dist/pptx.js"));
  const md = [
    "---", "title: t", "---", "", "# 封面页", "", "---", "",
    "# 模型对比", "", "| 模型 | 价格 | 速度 |", "|---|---|---|", "| A | 1 | 快 |", "| B | 2 | 慢 |",
    "", "一句说明", "", "```", "const x = 1;", "console.log(x);", "```", "",
  ].join("\n");
  const pages = parseSlides(md);
  const withTable = pages.find((p) => p.tables.length > 0);
  const tbl = withTable?.tables[0];
  const ok =
    Boolean(tbl) && tbl.header.length === 3 && tbl.rows.length === 2 && tbl.rows[0][0] === "A" &&
    pages.some((p) => p.code.length > 0 && p.code[0].includes("const x")) &&
    !pages.some((p) => p.bullets.some((b) => b.includes("价格"))); // 表格不应再落进项目符号
  check("PPTX2", "PPTX 解析：表格→结构化(3列2行) + 代码块捕获，不压成项目符号", ok,
    `表格=${tbl ? `${tbl.header.length}列${tbl.rows.length}行` : "无"}`);
}

// PPTX3 渲染升级：`值 :: 标签`→数字卡解析；长页按高度预算自动分续页（实渲幻灯片数 > 源页数）
{
  const { parseSlides, slidesManifest } = await import(join(root, "server/dist/pptx.js"));
  const longPage = Array.from({ length: 14 }, (_, i) => `- 要点 ${i + 1}：这是一条较长的要点用于撑高页面高度从而触发自动续页分页逻辑`).join("\n");
  const md = `# 封面\n\n---\n\n# 关键数字\n\n268亿元 :: 市场规模\n↓80% :: 人力成本\n\n---\n\n# 密集页\n\n${longPage}`;
  const pages = parseSlides(md);
  const statsPage = pages.find((p) => p.stats.length > 0);
  const m = slidesManifest(md);
  const ok =
    Boolean(statsPage) && statsPage.stats.length === 2 && statsPage.stats[0].value === "268亿元" &&
    m.statCards === 2 && m.renderedSlides > m.sourcePages && m.continuationSlides >= 1;
  check("PPTX3", "渲染升级：值::标签→数字卡 + 长页自动续页（实渲>源页）", ok,
    `源页=${m.sourcePages} 实渲=${m.renderedSlides} 续页=${m.continuationSlides} 数字卡=${m.statCards}`);
}

// PPTX4 解析健壮性：块状 <!-- note -->…<!-- end note --> 入备注不漏正文 + 剥离 slides 里的原始 HTML（跨行）
{
  const { parseSlides } = await import(join(root, "server/dist/pptx.js"));
  const md = "# 封面\n\n副标题\n\n<!-- note -->\n这是讲者备注内容不应出现在正文\n<!-- end note -->\n\n---\n\n# 能力\n\n<div style=\"display:flex;\ngap:16px\">\n实际要点A\n</div>\n\n- 正常要点";
  const pages = parseSlides(md);
  const cover = pages[0], cap = pages[1];
  const noteCaptured = cover.notes.includes("讲者备注内容");
  const noteNotLeaked = !cover.bullets.concat(cover.paragraphs).join("").includes("讲者备注内容");
  const capJson = JSON.stringify(cap);
  const htmlStripped = !capJson.includes("<div") && !capJson.includes("style=") && !capJson.includes("</div>") && capJson.includes("实际要点A");
  check("PPTX4", "解析健壮性：块状讲者备注入 notes 不漏正文 + slides 原始 HTML(跨行)被剥离", noteCaptured && noteNotLeaked && htmlStripped,
    `noteCaptured=${noteCaptured} noteNotLeaked=${noteNotLeaked} htmlStripped=${htmlStripped}`);
}

// PPTX5 解析：Marp frontmatter（含 `style: |` 多行 CSS 块标量）应被跳过，不渲染成幻灯片
{
  const { parseSlides } = await import(join(root, "server/dist/pptx.js"));
  const md = "---\nmarp: true\ntheme: default\npaginate: true\nstyle: |\n  :root { --x: #0B1D3A; }\n  section { color: var(--x); }\n---\n\n# 真封面\n\n副标题\n\n---\n\n# 第二页\n\n- 要点";
  const pages = parseSlides(md);
  const dump = JSON.stringify(pages);
  const ok = pages.length === 2 && pages[0].title === "真封面" && !dump.includes("marp: true") && !dump.includes(":root");
  check("PPTX5", "解析：Marp frontmatter(含 style:| 块标量) 被跳过、不渲染成幻灯片", ok,
    `pages=${pages.length} title0=${pages[0] && pages[0].title}`);
}

// PPTX6 架构图：```arch 围栏 → 解析 4 节点/3 边 + 入 manifest + 悬空边计 droppedLinks + 端到端出 pptx buffer
{
  const { parseSlides, slidesManifest, slidesToPptx } = await import(join(root, "server/dist/pptx.js"));
  const md = [
    "# 系统架构", "", "---", "",
    "# 数据管线", "",
    "```arch", "type: layered", "dir: down",
    "[接入] 网关", "[接入] 鉴权", "[核心] 调度器", "[存储] 主库",
    "网关 -> 调度器", "鉴权 -> 调度器", "调度器 -> 主库",
    "调度器 -. 异步 .-> 缓存",   // 缓存未定义 → droppedLinks=1
    "```",
  ].join("\n");
  const pages = parseSlides(md);
  const d = pages[1].diagrams[0];
  const m = slidesManifest(md);
  const buf = await slidesToPptx({ id: "x", title: "架构图", kind: "slides", content: md });
  const ok =
    Boolean(d) && d.type === "layered" && d.nodes.length === 4 && d.edges.length === 3 &&
    m.diagrams === 1 && m.droppedLinks === 1 && buf.length > 5000;
  check("PPTX6", "架构图：```arch 解析 4 节点/3 边、悬空边计 droppedLinks、端到端出 pptx", ok,
    `nodes=${d && d.nodes.length} edges=${d && d.edges.length} dropped=${m.droppedLinks} bytes=${buf.length}`);
}

// PPTX7 架构图新语法（节点|子项→框内模块 + 自动分层 + 目标可带子项）+ 数字卡整行反引号容错（修复实测 deck 的两个渲染 bug）
{
  const { parseSlides } = await import(join(root, "server/dist/pptx.js"));
  const md = [
    "# 架构", "",
    "```arch", "type: layered",
    "接入层 | [小程序] [外卖平台]",
    "接入层 -> 编排 | 引擎 | 路由",
    "编排 -. 未命中 .-> 兜底 | 坐席",
    "```", "",
    "---", "",
    "# 指标",
    "`↓30% :: 人力成本`",   // 整行被 markdown 行内代码反引号包裹（模型常见产出）
    "`<5秒 :: 响应`",
  ].join("\n");
  const pages = parseSlides(md);
  const dg = pages[0].diagrams[0];
  const byLabel = Object.fromEntries((dg?.nodes || []).map((n) => [n.label, n]));
  const archOk = dg && dg.nodes.length === 3 && dg.edges.length === 2 && dg.droppedLinks === 0 &&
    byLabel["接入层"]?.items?.length === 2 && byLabel["编排"]?.items?.length === 2 &&
    dg.edges.some((e) => e.dashed && e.label === "未命中") && dg.nodes.every((n) => n.group);
  const stats = pages[1].stats;
  const statOk = stats.length === 2 && stats.every((s) => !/`/.test(s.value + s.label)) &&
    stats[0].value === "↓30%" && stats[0].label === "人力成本";
  check("PPTX7", "架构图新语法(节点|子项+自动分层+目标带子项+虚线标签) + 数字卡整行反引号容错",
    !!archOk && statOk,
    `节点=${dg?.nodes.length} 边=${dg?.edges.length} dropped=${dg?.droppedLinks} 接入层子项=${byLabel["接入层"]?.items?.length} stat0=${stats[0]?.value}/${stats[0]?.label}`);
}

// WD1 write_document kind 契约校验：坏格式被拒（返回行号/分页提示），合法格式放行
{
  const v = engine.validateDocContent;
  const slidesOk = v("slides", "# 封面\n\n---\n\n# 第二页\n\n- 要点") === null;
  const slidesBad = typeof v("slides", "这是一段没有分页符的散文，被当成 slides") === "string"; // 无 --- 应拒
  const sheetOk = v("sheet", "模型,价格\nA,1\nB,2") === null;
  const sheetBad = (v("sheet", "模型,价格,速度\nA,1") || "").includes("列"); // 列数不齐应拒并提列
  const reportOk = v("report", "正文非空即可") === null;
  const emptyBad = typeof v("report", "   ") === "string";
  check("WD1", "write_document 契约校验：坏格式拒收+引导，合法放行",
    slidesOk && slidesBad && sheetOk && sheetBad && reportOk && emptyBad);
}

// SK1 技能相关性：trigger 优先命中/不命中 + 无 trigger 回退 SKILL_KEYWORDS[name] + 通用始终
{
  const rel = engine.skillRelevant;
  const ok =
    rel({ trigger: "调研,检索" }, "请调研最新模型") === true &&          // 带 trigger：命中
    rel({ trigger: "调研,检索" }, "撰写一份报告") === false &&          // 带 trigger：不命中
    rel({ name: "深度调研法" }, "请调研最新模型") === true &&            // 无 trigger 回退 SKILL_KEYWORDS[name]
    rel({ name: "金字塔写作法" }, "请调研最新模型") === false &&         // 同上（写作法不该被调研触发）
    rel({ name: "金字塔写作法" }, "撰写一份选型报告") === true &&
    rel({ name: "用户自定义技能X" }, "随便什么任务") === true;           // 无 trigger 无映射=通用=始终相关
  check("SK1", "技能相关性：trigger 优先 + 无 trigger 回退 name 关键词 + 通用始终", ok);
}

// SK2 渐进式披露：read_skill 拉正文（启用返回 body、停用返回空）
{
  const sk = db.listSkills().find((s) => s.name === "金字塔写作法");
  db.updateSkill(sk.id, { enabled: true });
  const enabledBody = engine.readSkillBody(sk.id);
  db.updateSkill(sk.id, { enabled: false });
  const disabledBody = engine.readSkillBody(sk.id);
  check("SK2", "渐进披露：read_skill 启用拉到非空 body、停用返回空",
    enabledBody.length > 50 && disabledBody === "", `len=${enabledBody.length}`);
}

// SK3 索引只放 L1（名/何时用/触发词 + read_skill 提示），不放正文；continue 不 break（最后一条仍在）
{
  const all = db.listSkills();
  for (const s of all) db.updateSkill(s.id, { enabled: true }); // 全开
  const idx = engine.buildSkillIndex("写作");
  const allIdsPresent = all.every((s) => idx.includes(`id: ${s.id}`));
  const py = all.find((s) => s.name === "金字塔写作法");
  const bodyLeaked = idx.includes(py.body.slice(0, 30)); // 正文不应出现在索引里
  const hasReadHint = idx.includes("read_skill");
  for (const s of all) db.updateSkill(s.id, { enabled: false }); // 复位
  check("SK3", "渐进披露索引：全部技能 id 在索引、含 read_skill 提示、正文未泄漏",
    allIdsPresent && hasReadHint && !bodyLeaked, `idsPresent=${allIdsPresent} bodyLeaked=${bodyLeaked}`);
}

// SK4 旧库兼容：body 为空的技能（模拟旧行）read_skill 回退 content
{
  const old = db.createSkill({ name: "回归旧技能", body: "", content: "老正文内容X", enabled: true });
  const got = engine.readSkillBody(old.id);
  db.deleteSkill(old.id);
  check("SK4", "旧库兼容：body 空时 read_skill 回退 content", got === "老正文内容X", `got=${got}`);
}

// CAP1 能力型就绪判断：依赖 MCP 未装→未就绪；装上启用→就绪；空依赖→就绪；缺图像供应商的 generate_image→未就绪
{
  const cap = engine.capabilityReady;
  const ref = JSON.stringify(["mcp__markitdown__*"]);
  const before = cap({ resources_json: ref });
  const srv = db.createMcpServer({ name: "markitdown", kind: "stdio", command: "true", args: [] });
  const after = cap({ resources_json: ref });
  db.deleteMcpServer(srv.id);
  const ok =
    before === false &&                                              // server 未装 → 未就绪
    after === true &&                                                // 启用同名 server → 就绪
    cap({ resources_json: "[]" }) === true &&                        // 无依赖 → 就绪
    cap({ resources_json: JSON.stringify(["generate_image"]) }) === false; // 测试库无图像供应商
  check("CAP1", "能力型就绪：MCP 未装未就绪/装上就绪/空依赖就绪/缺图像供应商未就绪", ok,
    `before=${before} after=${after}`);
}

// CAP2 network MCP 审批门：普通检索不断流；绑定来源文档或严格开关时，必须先走审批，避免源材料静默外发
{
  const srv = db.createMcpServer({ name: "web-search-prime", kind: "http", url: "https://search.example/mcp", safety: "network" });
  const tool = "mcp__web-search-prime__search";
  const plain = db.createTask({ channel_id: ch.id, title: "回归-network-普通检索", assignee_agent_id: eng.id, created_by: "user" });
  const src = db.createDocument({ channel_id: ch.id, agent_id: eng.id, title: "回归来源", kind: "source", content: "SensitiveSourceCAP2" });
  const sourced = db.createTask({ channel_id: ch.id, title: "回归-network-来源任务", assignee_agent_id: eng.id, created_by: "user", source_doc_ids: [src.id] });
  const beforeStrict = process.env.AITEAM_APPROVE_NETWORK_MCP;
  const plainOk = engine.mcpRequiresApprovalForTask(db.getTask(plain.id), tool) === false;
  const sourcedOk = engine.mcpRequiresApprovalForTask(db.getTask(sourced.id), tool) === true;
  process.env.AITEAM_APPROVE_NETWORK_MCP = "1";
  const strictOk = engine.mcpRequiresApprovalForTask(db.getTask(plain.id), tool) === true;
  if (beforeStrict === undefined) delete process.env.AITEAM_APPROVE_NETWORK_MCP;
  else process.env.AITEAM_APPROVE_NETWORK_MCP = beforeStrict;
  const callA = { query: "只检索公开的 A 主题", filters: { region: "CN", freshness: 30 } };
  const callAReordered = { filters: { freshness: 30, region: "CN" }, query: "只检索公开的 A 主题" };
  const callB = { query: "改为外发完全不同的 B 主题" };
  const pausedTask = db.createTask({
    channel_id: ch.id,
    title: "回归-network-审批时暂停任务",
    assignee_agent_id: eng.id,
    created_by: "user",
    source_doc_ids: [src.id],
  });
  db.updateTask(pausedTask.id, { status: "doing" });
  const genericApproval = db.createApproval({
    channel_id: ch.id,
    agent_id: eng.id,
    title: "批准一项无关动作",
    payload: "只批准整理内部文档",
    kind: "action",
    ref_id: pausedTask.id,
  });
  db.resolveApproval(genericApproval.id, true);
  const genericDoesNotGrant = engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callA, eng.id) === false;
  const pauseResult =
    typeof engine.requestNetworkApprovalForTask === "function"
      ? engine.requestNetworkApprovalForTask(
          eng,
          db.getTask(pausedTask.id),
          tool,
          callA,
          "批准一次 A 主题检索",
          "只允许外发本次公开查询",
        )
      : null;
  const pausedAfter = db.getTask(pausedTask.id);
  const pendingApproval = pauseResult ? db.getApproval(pauseResult.approvalId) : undefined;
  let pendingGrant = null;
  try { pendingGrant = JSON.parse(pendingApproval?.payload ?? "{}").network_grant; } catch { /* asserted below */ }
  check(
    "CAP2B",
    "network MCP 审批创建后任务必须 blocked，且授权范围由服务端绑定真实调用",
    Boolean(
      pauseResult &&
      pausedAfter?.status === "blocked" &&
      pausedAfter.blocked_approval_id === pauseResult.approvalId &&
      pendingApproval?.status === "pending" &&
      pendingApproval.kind === "network" &&
      pendingApproval.ref_id === pausedTask.id &&
      pendingApproval.agent_id === eng.id &&
      pendingGrant?.server_id === srv.id &&
      pendingGrant?.server_name === srv.name &&
      pendingGrant?.server_target === srv.url &&
      pendingGrant?.tool === tool &&
      pendingGrant?.input?.query === callA.query
    ),
    `helper=${Boolean(pauseResult)} status=${pausedAfter?.status} approval=${pendingApproval?.status}`,
  );
  const forgedApproval = pendingApproval
    ? db.createApproval({
        channel_id: ch.id,
        agent_id: eng.id,
        title: "伪造 network payload 的普通 action",
        payload: pendingApproval.payload,
        kind: "action",
        ref_id: pausedTask.id,
      })
    : null;
  if (forgedApproval) db.resolveApproval(forgedApproval.id, true);
  const forgedActionRejected =
    engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callA, eng.id) === false;
  if (pendingApproval) db.resolveApproval(pendingApproval.id, true);
  db.updateTask(pausedTask.id, { status: "doing", blocked_approval_id: null });
  const exactGrant = engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callAReordered, eng.id) === true;
  const changedCallRejected = engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callB, eng.id) === false;
  const changedToolRejected =
    engine.taskHasApprovedNetworkGrant(pausedTask.id, "mcp__web-search-prime__fetch", callA, eng.id) === false;
  const wrongAgentRejected = engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callA, pm.id) === false;
  const otherTask = db.createTask({
    channel_id: ch.id,
    title: "回归-network-错误任务范围",
    assignee_agent_id: eng.id,
    created_by: "user",
  });
  db.updateTask(otherTask.id, { status: "doing" });
  const wrongTaskRejected = engine.taskHasApprovedNetworkGrant(otherTask.id, tool, callA, eng.id) === false;
  db.db.prepare("UPDATE mcp_servers SET url = ? WHERE id = ?").run("https://changed.example/mcp", srv.id);
  const changedServerRejected =
    engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callA, eng.id) === false;
  db.db.prepare("UPDATE mcp_servers SET url = ? WHERE id = ?").run("https://search.example/mcp", srv.id);
  const consumed =
    typeof engine.consumeApprovedNetworkGrant === "function" &&
    engine.consumeApprovedNetworkGrant(pausedTask.id, tool, callAReordered, eng.id) === true;
  const consumedPersisted = Boolean(pendingApproval && db.getApproval(pendingApproval.id)?.consumed_at);
  const secondConsumeRejected =
    engine.consumeApprovedNetworkGrant(pausedTask.id, tool, callAReordered, eng.id) === false;
  const replayRejected = engine.taskHasApprovedNetworkGrant(pausedTask.id, tool, callA, eng.id) === false;
  check(
    "CAP2",
    "network MCP：来源/严格任务必须审批，且授权只匹配指定工具与参数",
    plainOk &&
      sourcedOk &&
      strictOk &&
      genericDoesNotGrant &&
      forgedActionRejected &&
      exactGrant &&
      changedCallRejected &&
      changedToolRejected &&
      wrongAgentRejected &&
      wrongTaskRejected &&
      changedServerRejected &&
      consumed &&
      consumedPersisted &&
      secondConsumeRejected &&
      replayRejected,
    `plain=${plainOk} sourced=${sourcedOk} strict=${strictOk} genericBlocked=${genericDoesNotGrant}/${forgedActionRejected} exact=${exactGrant} changed=${changedCallRejected}/${changedToolRejected}/${changedServerRejected} wrongScope=${wrongAgentRejected}/${wrongTaskRejected} consumed=${consumed}/${consumedPersisted} replayBlocked=${secondConsumeRejected}/${replayRejected}`,
  );
  const reassignedTask = db.createTask({
    channel_id: ch.id,
    title: "回归-network-改派后旧授权不可复活",
    assignee_agent_id: eng.id,
    created_by: "user",
    source_doc_ids: [src.id],
  });
  db.updateTask(reassignedTask.id, { status: "doing" });
  const reassignedRequest = engine.requestNetworkApprovalForTask(
    eng,
    db.getTask(reassignedTask.id),
    tool,
    callA,
    "批准一次改派前调用",
    "改派后本授权必须永久失效",
  );
  const reassignedApproval = reassignedRequest
    ? db.resolveApproval(reassignedRequest.approvalId, true)
    : null;
  db.updateTask(reassignedTask.id, { assignee_agent_id: pm.id });
  if (reassignedApproval) engine.onNetworkApprovalResolved(reassignedApproval);
  const invalidConsumed = Boolean(
    reassignedRequest && db.getApproval(reassignedRequest.approvalId)?.consumed_at,
  );
  db.updateTask(reassignedTask.id, {
    status: "doing",
    assignee_agent_id: eng.id,
    blocked_approval_id: null,
  });
  const reassignedGrantCannotRevive =
    engine.taskHasApprovedNetworkGrant(reassignedTask.id, tool, callA, eng.id) === false;
  check(
    "CAP2C",
    "network MCP：改派导致的已批准授权必须原子失效，改回原负责人也不能复活",
    Boolean(reassignedRequest && reassignedApproval && invalidConsumed && reassignedGrantCannotRevive),
    `requested=${Boolean(reassignedRequest)} consumed=${invalidConsumed} revived=${!reassignedGrantCannotRevive}`,
  );
  const mismatchedTask = db.createTask({
    channel_id: ch.id,
    title: "回归-network-审批状态错配不可复活",
    assignee_agent_id: eng.id,
    created_by: "user",
    source_doc_ids: [src.id],
  });
  db.updateTask(mismatchedTask.id, { status: "doing" });
  const mismatchedRequest = engine.requestNetworkApprovalForTask(
    eng,
    db.getTask(mismatchedTask.id),
    tool,
    callA,
    "批准一次状态错配调用",
    "即使任务被旁路改状态，批准也必须立即失效",
  );
  db.updateTask(mismatchedTask.id, { status: "review" });
  const mismatchedApproval = mismatchedRequest
    ? db.resolveApproval(mismatchedRequest.approvalId, true)
    : null;
  if (mismatchedApproval) engine.onNetworkApprovalResolved(mismatchedApproval);
  const mismatchedConsumed = Boolean(
    mismatchedRequest && db.getApproval(mismatchedRequest.approvalId)?.consumed_at,
  );
  db.updateTask(mismatchedTask.id, { status: "doing", blocked_approval_id: null });
  const mismatchedCannotRevive =
    !engine.taskHasApprovedNetworkGrant(mismatchedTask.id, tool, callA, eng.id);
  check(
    "CAP2D",
    "network MCP：审批处理时任务状态/blocked id 已错配，批准必须关闭且不可复活",
    Boolean(mismatchedRequest && mismatchedApproval && mismatchedConsumed && mismatchedCannotRevive),
    `requested=${Boolean(mismatchedRequest)} consumed=${mismatchedConsumed} revived=${!mismatchedCannotRevive}`,
  );
  const invalidationTask = db.createTask({
    channel_id: ch.id,
    title: "回归-network-批量原子失效",
    assignee_agent_id: eng.id,
    created_by: "user",
  });
  const pendingNetwork = db.createApproval({
    channel_id: ch.id,
    agent_id: eng.id,
    title: "待处理 network 审批",
    kind: "network",
    ref_id: invalidationTask.id,
  });
  const approvedNetwork = db.createApproval({
    channel_id: ch.id,
    agent_id: eng.id,
    title: "已批准未消费 network 审批",
    kind: "network",
    ref_id: invalidationTask.id,
  });
  db.resolveApproval(approvedNetwork.id, true);
  const unrelatedAction = db.createApproval({
    channel_id: ch.id,
    agent_id: eng.id,
    title: "不应被波及的普通审批",
    kind: "action",
    ref_id: invalidationTask.id,
  });
  const invalidated = engine.invalidateTaskNetworkApprovals(invalidationTask.id);
  const pendingAfterInvalidation = db.getApproval(pendingNetwork.id);
  const approvedAfterInvalidation = db.getApproval(approvedNetwork.id);
  const actionAfterInvalidation = db.getApproval(unrelatedAction.id);
  const repeatedInvalidation = engine.invalidateTaskNetworkApprovals(invalidationTask.id);
  check(
    "CAP2E",
    "network MCP：任务上下文撤销时 pending→rejected、approved→consumed 一次原子收口",
    invalidated === 2 &&
      pendingAfterInvalidation?.status === "rejected" &&
      Boolean(pendingAfterInvalidation.resolved_at) &&
      approvedAfterInvalidation?.status === "approved" &&
      Boolean(approvedAfterInvalidation.consumed_at) &&
      actionAfterInvalidation?.status === "pending" &&
      repeatedInvalidation === 0,
    `changed=${invalidated}->${repeatedInvalidation} pending=${pendingAfterInvalidation?.status}/${Boolean(pendingAfterInvalidation?.resolved_at)} approved=${approvedAfterInvalidation?.status}/${Boolean(approvedAfterInvalidation?.consumed_at)} action=${actionAfterInvalidation?.status}`,
  );
  const makeApprovedGrantTask = (title) => {
    const task = db.createTask({
      channel_id: ch.id,
      title,
      assignee_agent_id: eng.id,
      created_by: "user",
      source_doc_ids: [src.id],
    });
    db.updateTask(task.id, { status: "doing" });
    const request = engine.requestNetworkApprovalForTask(
      eng,
      db.getTask(task.id),
      tool,
      callA,
      `批准一次 ${title} 调用`,
      "进入新的阻塞边界后，本授权必须永久失效",
    );
    const approval = request ? db.resolveApproval(request.approvalId, true) : null;
    db.updateTask(task.id, { status: "doing", blocked_approval_id: null });
    return { task: db.getTask(task.id), request, approval };
  };
  const clarificationGrant = makeApprovedGrantTask("clarification 前");
  const clarificationWasGranted = Boolean(
    clarificationGrant.request &&
    clarificationGrant.approval &&
    engine.taskHasApprovedNetworkGrant(clarificationGrant.task.id, tool, callA, eng.id),
  );
  const clarificationBlock = engine.requestClarificationForTask(
    eng,
    clarificationGrant.task,
    "是否调整任务范围？",
    "用户的新输入可能改变外发内容。",
    "保持原范围",
  );
  db.updateTask(clarificationGrant.task.id, { status: "doing", blocked_approval_id: null });
  const clarificationGrantClosed = Boolean(
    clarificationGrant.request &&
    db.getApproval(clarificationGrant.request.approvalId)?.consumed_at &&
    !engine.taskHasApprovedNetworkGrant(clarificationGrant.task.id, tool, callA, eng.id),
  );
  db.resolveApproval(clarificationBlock.approvalId, false);
  db.updateTask(clarificationGrant.task.id, { status: "cancelled", blocked_approval_id: null });

  const budgetGrant = makeApprovedGrantTask("预算暂停前");
  const budgetWasGranted = Boolean(
    budgetGrant.request &&
    budgetGrant.approval &&
    engine.taskHasApprovedNetworkGrant(budgetGrant.task.id, tool, callA, eng.id),
  );
  const budgetBlock = engine.requestBudgetPauseForTask(eng, budgetGrant.task, 100, 100);
  db.updateTask(budgetGrant.task.id, { status: "doing", blocked_approval_id: null });
  const budgetGrantClosed = Boolean(
    budgetGrant.request &&
    db.getApproval(budgetGrant.request.approvalId)?.consumed_at &&
    !engine.taskHasApprovedNetworkGrant(budgetGrant.task.id, tool, callA, eng.id),
  );
  db.resolveApproval(budgetBlock.approvalId, false);
  db.updateTask(budgetGrant.task.id, { status: "cancelled", blocked_approval_id: null });
  check(
    "CAP2F",
    "network MCP：clarification/预算暂停形成新决策边界，旧授权必须关闭且恢复后不可复活",
    clarificationWasGranted && clarificationGrantClosed && budgetWasGranted && budgetGrantClosed,
    `clarification=${clarificationWasGranted}/${clarificationGrantClosed} budget=${budgetWasGranted}/${budgetGrantClosed}`,
  );
  db.deleteMcpServer(srv.id);
}

// DOC-HTML html 交付物：格式 + 防 XSS 校验（外链 script / 内联事件 / javascript: URI 全拒）
{
  const v = engine.validateDocContent;
  const ok =
    v("html", "<section><h1>原型</h1><p>hi</p></section>") === null &&     // 合法
    typeof v("html", "纯文本无标签") === "string" &&                       // 非 HTML 拒
    typeof v("html", '<div></div><script src="//evil/x.js"></script>') === "string" && // 外链 script 拒
    typeof v("html", '<img src=x onerror="alert(1)">') === "string" &&     // 内联事件(空格分隔) 拒
    typeof v("html", "<svg/onload=alert(1)>") === "string" &&             // 内联事件(/ 分隔，HTML5 绕过) 拒
    typeof v("html", '<a href="javascript:alert(1)">x</a>') === "string";  // javascript: URI 拒
  check("DOC-HTML", "html 交付物：合法放行 + 外链script/内联事件(含 /onload 绕过)/js:URI 全拒（防存储型 XSS）", ok);
}

// DOC-SRC 无源数字软门：report/slides 多处量化且零来源/零示意标注 → 退回自纠；有来源/示意/少量/sheet/html → 放行
{
  const v = engine.validateDocContent;
  const manyNums = "市场规模 268亿元，渗透率 60%，成本下降 80%，ROI 提升 3 倍，年省 500 万元。";
  const withSrc = manyNums + "（来源：https://example.com/report）";
  const withMark = "市场规模 268亿元，渗透率 60%，成本下降 80%，ROI 提升 3 倍，年省 500 万元（示意值，待核实）。";
  const few = "本季度营收 100 万元，同比增长 20%。";
  const sheetNums = "指标,数值\n市场规模,268亿元\n渗透率,60%\n成本下降,80%\nROI,3倍\n年省,500万元"; // 合法 CSV，数字多但 sheet 不受 C2 约束
  const ok =
    typeof v("report", manyNums) === "string" &&   // 多处无源 → 退回自纠
    v("report", withSrc) === null &&               // 有来源标注 → 放行
    v("report", withMark) === null &&              // 示意值标注 → 放行
    v("report", few) === null &&                   // 量化数量少(<5) → 不误伤
    v("sheet", sheetNums) === null;                // sheet 豁免（数据表本就是数字，格式合法即放行）
  check("DOC-SRC", "无源数字软门：report 多处量化零来源退回；有来源/示意/少量/sheet 放行", ok);
}

// VER-ROUTE 验收者按交付物类型路由：视觉物→设计审核 / 内容物→校对审核 / 退代码评审 / 兜底创建者·本人
{
  const pick = engine.pickVerifier;
  const explicit = engine.resolveTaskReviewer;
  const A = (id, name, role) => ({ id, name, role });
  const design = A("d", "设计审核", "视觉与版式把关");
  const content = A("c", "校对审核", "文字校对与事实核查");
  const code = A("k", "代码评审", "代码审查与质量把关");
  const product = A("p", "产品经理", "产品规划");
  const worker = A("w", "PPT 助手", "演示文稿制作");
  const reviewerTask = db.createTask({ channel_id: ch.id, title: "回归-指定复核", assignee_agent_id: eng.id, reviewer_agent_id: pm.id, created_by: "user" });
  const ok =
    pick([product, code, content, design], "slides", null, worker).id === "d" && // 视觉物→设计审核
    pick([product, code, content, design], "report", null, worker).id === "c" && // 内容物→校对审核
    pick([product, code], "slides", null, worker).id === "k" &&                  // 无设计/校对→退代码评审
    pick([product], "slides", "p", worker).id === "p" &&                         // 都没有→任务创建者
    pick([], "slides", null, worker).id === "w" &&                          // 空→本人(solo 自检)
    explicit(reviewerTask, [design, content, code], "report", eng).id === pm.id; // 显式 reviewer 优先
  check("VER-ROUTE", "验收者按交付物类型路由：视觉→设计审核 / 内容→校对审核 / 退代码评审 / 兜底创建者·本人", ok);
}

// SK5 L3 模板资源：技能用 tpl: 引用内置模板，read_skill 附带模板正文返回
{
  const sk = db.listSkills().find((s) => s.name === "演示设计与防溢出法");
  db.updateSkill(sk.id, { enabled: true });
  const out = engine.readSkillBody(sk.id);
  db.updateSkill(sk.id, { enabled: false });
  check("SK5", "L3 模板：read_skill 把 tpl: 引用的内置模板正文附带返回",
    out.includes("可复用模板") && out.includes("横向翻页网页 PPT") && out.includes("<!doctype html>"),
    `len=${out.length}`);
}

// TPL1 内置模板自洽：每个 SKILL_TEMPLATES 都是合法 html 交付物（agent 照抄即可过 validateDocContent）
{
  const { SKILL_TEMPLATES } = await import(join(root, "server/dist/registry.js"));
  const allValid = SKILL_TEMPLATES.length > 0 && SKILL_TEMPLATES.every((t) => engine.validateDocContent("html", t.content) === null);
  check("TPL1", "内置模板自洽：全部 SKILL_TEMPLATES 通过 html 交付物校验", allValid, `模板数=${SKILL_TEMPLATES.length}`);
  // TPL-SOFF 脚本关闭可渲染：禁 opacity:0 门控的 .slide（除非有 scroll-snap / :first-of-type / :not(.js) 兜底）
  const soffOk = SKILL_TEMPLATES.every((t) =>
    !/\.slide\s*\{[^}]*opacity\s*:\s*0/.test(t.content) || /scroll-snap|:first-of-type|:not\(\.js\)/.test(t.content));
  check("TPL-SOFF", "模板脚本关闭可渲染：无裸 opacity:0 门控（预览 iframe sandbox 空、脚本不跑）", soffOk);
  // STRAT1 演示风格选择法：策略技能在册；5 套精装模板入库且正文引用的 html-deck-* id 全部可解析
  // （read_skill 回退按单 id 取模板的前提；防 body 写错 id）
  const { getSkillTemplate } = await import(join(root, "server/dist/registry.js"));
  const strat = BUILTIN_SKILLS.find((s) => s.name === "演示风格选择法");
  const designedIds = ["html-deck-navy-gold", "html-deck-whitespace", "html-deck-circuit", "html-deck-magazine", "html-deck-colorblock"];
  const allInRegistry = designedIds.every((id) => SKILL_TEMPLATES.some((t) => t.id === id) && !!getSkillTemplate(id));
  const refIds = strat ? [...new Set(strat.body.match(/html-deck-[a-z-]+/g) || [])] : [];
  const refsResolve = refIds.length >= 5 && refIds.every((id) => !!getSkillTemplate(id));
  check("STRAT1", "演示风格选择法在册 + 5 套精装模板入库且正文引用 id 全部可解析",
    !!strat && allInRegistry && refsResolve, `策略=${!!strat} 入库=${allInRegistry} 引用id=${refIds.length}`);
}

// PTPL 上传 .pptx 模板「就地改图文」核心（方案① OOXML）：用 slidesToPptx 造夹具 → 解析槽位 → 文本就地替换 →
// 重解析校验。关键不变量：母版/版式/主题 inner XML 逐字不变（原设计天然保留）、只动被编辑那一页、zip 条目零增减。
{
  const { slidesToPptx } = await import(join(root, "server/dist/pptx.js"));
  const { parseTemplate, applyTemplateEdits } = await import(join(root, "server/dist/pptx-template.js"));
  const JSZip = (await import("jszip")).default;
  const fixtureDoc = {
    id: "ptpl-fix", owner_id: "o", channel_id: null, task_id: null, agent_id: null,
    title: "夹具", kind: "slides", version: 1, superseded_by: null, created_at: 0, updated_at: 0,
    content: ["# 封面ALPHA", "副标题", "---", "## 第二页", "- 要点BRAVO", "- 要点乙", "---", "## 结尾CHARLIE", "联系方式"].join("\n"),
  };
  const original = await slidesToPptx(fixtureDoc);
  const meta = await parseTemplate(original);
  const alpha = meta.slots.find((s) => s.text.includes("封面ALPHA"));
  const bravo = meta.slots.find((s) => s.text.includes("要点BRAVO"));
  check("PTPL-PARSE", "上传模板解析：slidesToPptx 夹具解析出槽位清单（含封面/正文文本，定位稳定）",
    meta.slideCount === 3 && meta.slots.length > 0 && !!alpha && !!bravo, `页=${meta.slideCount} 槽=${meta.slots.length}`);

  // 内 XML 快照（母版/版式/主题 + 各 slide）
  const innerMap = async (buf) => {
    const z = await JSZip.loadAsync(buf); const out = {};
    for (const p of Object.keys(z.files)) {
      const fo = z.file(p); if (!fo || z.files[p].dir) continue;
      if (/^ppt\/(slideMasters|slideLayouts|theme)\/.+\.xml$/.test(p) || /^ppt\/slides\/slide\d+\.xml$/.test(p)) out[p] = await fo.async("string");
    } return out;
  };
  const before = await innerMap(original);
  const edited = alpha ? await applyTemplateEdits(original, [{ slideIdx: alpha.slideIdx, shapeIdx: alpha.shapeIdx, paraIdx: alpha.paraIdx, newText: "封面已改DELTA" }]) : original;
  const meta2 = await parseTemplate(edited);
  const after = await innerMap(edited);
  const masterChanged = Object.keys(before).filter((p) => !/slides\/slide\d+\.xml$/.test(p) && before[p] !== after[p]);
  const slidesChanged = Object.keys(before).filter((p) => /slides\/slide\d+\.xml$/.test(p) && before[p] !== after[p]);
  const za = await JSZip.loadAsync(original), zb = await JSZip.loadAsync(edited);
  const setA = Object.keys(za.files).filter((p) => !za.files[p].dir).sort().join("|");
  const setB = Object.keys(zb.files).filter((p) => !zb.files[p].dir).sort().join("|");
  const deltaIn = !!meta2.slots.find((s) => s.text.includes("封面已改DELTA"));
  const alphaGone = !meta2.slots.find((s) => s.text.includes("封面ALPHA"));
  const bravoKept = !!meta2.slots.find((s) => s.text.includes("要点BRAVO"));
  check("PTPL-EDIT", "就地改文本：命中段替换成功 + 母版/版式/主题 inner XML 逐字不变 + 只动被编辑页 + zip 条目零增减",
    deltaIn && alphaGone && bravoKept && masterChanged.length === 0 && slidesChanged.length === 1 && setA === setB && meta2.slideCount === 3,
    `delta=${deltaIn} alphaGone=${alphaGone} bravoKept=${bravoKept} master改=${masterChanged.length} slide改=${slidesChanged.length} 条目同=${setA === setB}`);

  // PTPL-EMPTY 空模板生成图文：把夹具首个文本形状改成「空 title 占位符」→ 解析应列出空占位槽(text=''、phType) → 填字导出 → 重解析有该字、母版不变
  const { DOMParser, XMLSerializer } = await import("@xmldom/xmldom");
  const baseEmpty = await slidesToPptx({ ...fixtureDoc, content: "# 占位\n副\n---\n## 二\n- x" });
  const zE = await JSZip.loadAsync(baseEmpty);
  const rawE = await zE.file("ppt/slides/slide1.xml").async("string");
  const declE = (rawE.match(/^<\?xml[^>]*\?>/) || [""])[0];
  const docE = new DOMParser().parseFromString(rawE, "text/xml");
  const kidsOf = (p, tag) => { const o = []; for (let i = 0; i < p.childNodes.length; i++) { const n = p.childNodes[i]; if (n.nodeType === 1 && (!tag || n.nodeName === tag)) o.push(n); } return o; };
  const tree = docE.getElementsByTagName("p:spTree")[0];
  const sp0 = kidsOf(tree, "p:sp").find((sp) => kidsOf(sp, "p:txBody")[0]);
  const nvSpPr = kidsOf(sp0, "p:nvSpPr")[0];
  let nvPr = kidsOf(nvSpPr, "p:nvPr")[0]; if (!nvPr) { nvPr = docE.createElement("p:nvPr"); nvSpPr.appendChild(nvPr); }
  const phEl = docE.createElement("p:ph"); phEl.setAttribute("type", "title"); nvPr.appendChild(phEl);
  const firstP = kidsOf(kidsOf(sp0, "p:txBody")[0], "a:p")[0];
  kidsOf(firstP, "a:r").forEach((r) => firstP.removeChild(r));
  let outE = new XMLSerializer().serializeToString(docE); if (!outE.startsWith("<?xml")) outE = declE + "\n" + outE;
  zE.file("ppt/slides/slide1.xml", outE);
  const emptyTpl = Buffer.from(await zE.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  const metaE = await parseTemplate(emptyTpl);
  const emptySlot = metaE.slots.find((s) => s.text === "" && s.kind === "ph" && s.phType);
  const beforeM = await innerMap(emptyTpl);
  const filled = emptySlot ? await applyTemplateEdits(emptyTpl, [{ slideIdx: emptySlot.slideIdx, shapeIdx: emptySlot.shapeIdx, paraIdx: emptySlot.paraIdx, newText: "填入标题ZULU" }]) : emptyTpl;
  const metaF = await parseTemplate(filled);
  const afterM = await innerMap(filled);
  const masterE = Object.keys(beforeM).filter((p) => !/slides\/slide\d+\.xml$/.test(p) && beforeM[p] !== afterM[p]);
  check("PTPL-EMPTY", "空模板生成图文：空占位符列成可填槽(text=''+phType) + 填字入位 + 母版/版式/主题不变",
    !!emptySlot && !!metaF.slots.find((s) => s.text.includes("填入标题ZULU")) && masterE.length === 0,
    `空槽=${!!emptySlot} phType=${emptySlot?.phType} 填入=${!!metaF.slots.find((s) => s.text.includes("填入标题ZULU"))} master改=${masterE.length}`);

  // PTPL-IMG 模板换图：夹具嵌图 → 解析出图片位 → 换图(base64) → 新 media + Content_Types png + 重解析仍在 + 母版不变
  const { assetsDir } = await import(join(root, "server/dist/agents/images.js"));
  const PNGa = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNGb = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  writeFileSync(join(assetsDir, "ptpl-img.png"), Buffer.from(PNGa, "base64"));
  const imgDeck = await slidesToPptx({ ...fixtureDoc, content: "# 封面\n副\n---\n## 配图\n![x](/aiteam/assets/ptpl-img.png)\n要点" });
  const metaI = await parseTemplate(imgDeck);
  const picSlot = (metaI.images || []).find((s) => s.type === "pic" && s.fillable);
  const beforeMI = await innerMap(imgDeck);
  const editedI = picSlot ? await applyTemplateEdits(imgDeck, [], [{ slideIdx: picSlot.slideIdx, imageIdx: picSlot.imageIdx, dataBase64: PNGb, ext: "png" }]) : imgDeck;
  const zI = await JSZip.loadAsync(editedI);
  const mediaN = Object.keys(zI.files).filter((p) => /^ppt\/media\/.+\.(png|jpg|jpeg)$/i.test(p)).length;
  const ctI = await zI.file("[Content_Types].xml").async("string");
  const metaI2 = await parseTemplate(editedI);
  const afterMI = await innerMap(editedI);
  const masterMI = Object.keys(beforeMI).filter((p) => !/slides\/slide\d+\.xml$/.test(p) && beforeMI[p] !== afterMI[p]);
  check("PTPL-IMG", "模板换图：解析出图片位 + 换图(新 media + Content_Types png) + 重解析仍在 + 母版/版式/主题不变",
    !!picSlot && mediaN >= 2 && /Extension="png"/i.test(ctI) && (metaI2.images || []).some((s) => s.type === "pic") && masterMI.length === 0,
    `图片位=${!!picSlot} media=${mediaN} ct=${/Extension="png"/i.test(ctI)} master改=${masterMI.length}`);
}

// ENV1 stdio MCP 环境变量：密文入库（库文件泄漏≠凭证泄漏），sanitize 只回 key 名、绝不下发值（博查 BOCHA_API_KEY 用例）
{
  const { decryptSecret, isEncryptedSecret } = await import(join(root, "server/dist/secrets.js"));
  const s = db.createMcpServer({ name: "envtest", kind: "stdio", command: "true", args: [], env: { BOCHA_API_KEY: "sk-secret-xyz" } });
  const raw = db.getMcpServer(s.id);
  const san = db.sanitizeMcpServer(raw);
  db.deleteMcpServer(s.id);
  const ok =
    Array.isArray(san.env_keys) && san.env_keys.includes("BOCHA_API_KEY") &&        // 暴露 key 名
    san.env_json === undefined && !JSON.stringify(san).includes("sk-secret-xyz") && // 不泄露值
    isEncryptedSecret(raw.env_json) && !raw.env_json.includes("sk-secret-xyz") &&   // 落库是密文，不含明文值
    JSON.parse(decryptSecret(raw.env_json)).BOCHA_API_KEY === "sk-secret-xyz";      // 服务端可解回原值
  check("ENV1", "stdio MCP 环境变量：密文入库 + 服务端可解 + sanitize 只回 key 名不下发值", ok);
}

// DEDUP1 跨插件检索去重签名：不同搜索插件的 query/search_query 同句 → 同签名（会被去重）；非检索类(uri/urls) → null
{
  const { searchQuerySignature: sig } = await import(join(root, "server/dist/agents/mcp.js"));
  const a = sig({ query: "最新 AI 模型" });                 // bocha/tavily
  const b = sig({ search_query: "最新  AI 模型 " });         // 智谱(空格/大小写归一)
  const ok =
    a !== null && a === b &&                                  // 同句跨插件 → 同签名
    sig({ uri: "file:///x.pdf" }) === null &&                 // markitdown 非检索 → 不去重
    sig({ urls: ["http://a"] }) === null &&                   // tavily_extract → 不去重
    sig({}) === null;
  check("DEDUP1", "跨插件检索去重：同句不同插件同签名、非检索类不参与", ok, `a=${a}`);
}

// SRC1 定向润色 grounding：任务挂 source_doc_ids → buildWorkBrief 注入来源全文 + 受限改写框架（解决"从零生成泛泛而谈"）
{
  const src = db.createDocument({ channel_id: ch.id, agent_id: pm.id, title: "来源草稿X", kind: "report", content: "来源文档独特标记 ZZTOP123，需要被定向润色。" });
  const t = db.createTask({ channel_id: ch.id, title: "润色来源草稿X", assignee_agent_id: eng.id, created_by: pm.id, source_doc_ids: [src.id], acceptance_criteria: "仅润色、不新增数据" });
  const brief = engine.buildWorkBrief(t, ch);
  const noSrc = engine.buildWorkBrief(db.createTask({ channel_id: ch.id, title: "普通任务", assignee_agent_id: eng.id, created_by: pm.id }), ch);
  const ok =
    brief.includes("ZZTOP123") &&                       // 来源全文已注入
    /来源文档|定向润色|受限改写/.test(brief) &&          // 受限改写框架已注入
    !noSrc.includes("受限改写");                          // 无 source 的任务不触发该框架
  check("SRC1", "定向润色：source_doc_ids 把来源全文+受限改写框架注入工作简报，无来源不触发", ok, `len=${brief.length}`);
}

// QC1 D1 裁决落表：verdict 链可回放（revise→pass），质量汇总能区分一次通过/返工
{
  const t = db.createTask({ channel_id: ch.id, title: "质量落表任务", assignee_agent_id: eng.id, created_by: pm.id });
  db.createVerdict({ task_id: t.id, worker_agent_id: eng.id, verifier_agent_id: pm.id, attempt: 0, result: "revise", reasons: "关键数字无来源", source: "auto" });
  db.createVerdict({ task_id: t.id, worker_agent_id: eng.id, verifier_agent_id: pm.id, attempt: 1, result: "pass", reasons: "已补来源", source: "auto" });
  db.updateTask(t.id, { status: "review" });
  const chain = db.listVerdictsForTask(t.id);
  const q = db.qualitySummary();
  const mine = q.agents.find((a) => a.agent_id === eng.id);
  const ok =
    chain.length === 2 && chain[0].result === "revise" && chain[1].result === "pass" &&
    Boolean(mine) && mine.tasks >= 1 && mine.revises >= 1 && mine.first_pass === 0 && // attempt0=revise 不算一次通过
    q.coverage.delivered >= 1 && q.coverage.verified >= 1 &&
    q.recent_revises.some((r) => r.task_id === t.id && r.reasons.includes("无来源"));
  check("QC1", "D1 裁决落表：verdict 链回放 + 质量汇总（一次通过率/返工/覆盖率）", ok,
    `chain=${chain.map((v) => v.result).join("→")} coverage=${q.coverage.verified}/${q.coverage.delivered}`);
}

// QC2 D2 任务级用量累计：跨多次运行叠加、billable 加权口径、进入同档估价样本
{
  const t = db.createTask({ channel_id: ch.id, title: "用量累计任务", assignee_agent_id: eng.id, created_by: pm.id });
  db.addTaskUsage(t.id, { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 2000, cache_creation_tokens: 400 });
  db.addTaskUsage(t.id, { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 });
  const spent = db.taskSpentBillable(db.getTask(t.id));
  // billable = 1100 + 550 + 400*1.25 + 2000*0.1 = 2350（与 readUsage 计费权重同口径）
  db.updateTask(t.id, { status: "review" });
  const est = db.estimateTaskBillable("standard");
  check("QC2", "D2 用量累计：多次运行叠加 + billable 加权 + 同档历史估价（中位数）",
    spent === 2350 && est === 2350, `spent=${spent} est=${est}`);
}

// QC3 D2 预算护栏：超支暂停（blocked + budget 审批）→ 批准恢复（todo + 预算=消耗+追加周期）
{
  const t = db.createTask({ channel_id: ch.id, title: "预算护栏任务", assignee_agent_id: eng.id, created_by: pm.id, budget_billable: 100 });
  db.addTaskUsage(t.id, { input_tokens: 90, output_tokens: 30, cache_read_tokens: 0, cache_creation_tokens: 0 });
  const spent = db.taskSpentBillable(db.getTask(t.id)); // 120 ≥ 100 触线
  const { approvalId } = engine.requestBudgetPauseForTask(eng, db.getTask(t.id), spent, 100);
  const paused = db.getTask(t.id);
  const approval = db.getApproval(approvalId);
  const pausedOk = paused.status === "blocked" && paused.blocked_approval_id === approvalId && approval.kind === "budget";
  db.resolveApproval(approvalId, true);
  engine.onBudgetResolved(db.getApproval(approvalId), true);
  const resumed = db.getTask(t.id);
  check("QC3", "D2 预算护栏：超支暂停开 budget 审批，批准后恢复且新预算=消耗+追加",
    pausedOk && resumed.status === "todo" && resumed.blocked_approval_id === null && resumed.budget_billable === spent + 100,
    `spent=${spent} paused=${pausedOk} resumedBudget=${resumed.budget_billable}`);
}

// ---------------------------------------------------------------------------
// Phase 2：拉起服务，走 HTTP API（聊天/引用/文档/技能/MCP/用量/导出/模板/频道）
// ---------------------------------------------------------------------------
// G1 的 everything server 不在 stdio 默认白名单内——用运维扩展口放行（同时覆盖"白名单可扩展"这条路径）
process.env.AITEAM_MCP_STDIO_ALLOW = [process.env.AITEAM_MCP_STDIO_ALLOW, "mcp-server-everything"]
  .filter(Boolean)
  .join(",");
const server = spawn("node", [join(root, "server/dist/index.js")], {
  env: { ...process.env, PORT: String(PORT), AITEAM_TEST_INSTANCE_ID: TEST_INSTANCE_ID },
  stdio: "ignore",
});
let serverExit = null;
server.once("error", (error) => { serverExit = { error: String(error) }; });
server.once("exit", (code, signal) => { serverExit = { code, signal }; });
let fakeOpenAiServer = null;
let fakeOpenAiStreamHits = 0;
const qualityBenchmarkWorkerRequests = [];
const qualityBenchmarkVerifierRequests = [];
const NETWORK_APPROVAL_MARKER = "NETWORK_APPROVAL_E2E";
const NETWORK_PROBE_TOOL = "mcp__network_probe__search";
const NETWORK_RECONNECT_MARKER = "NETWORK_RECONNECT_STOP_E2E";
const NETWORK_RECONNECT_PROBE_TOOL = "mcp__network_reconnect_probe__search";
const STOP_DURING_VERIFICATION_MARKER = "STOP_DURING_VERIFICATION_E2E";
const CANCEL_REOPEN_DURING_VERIFICATION_MARKER = "CANCEL_REOPEN_DURING_VERIFICATION_E2E";
const REASSIGN_DURING_WORK_MARKER = "REASSIGN_DURING_WORK_E2E";
let heldStopVerificationResponse = null;
let stopVerificationHoldUsed = false;
let heldCancelReopenVerificationResponse = null;
let cancelReopenVerificationHoldUsed = false;
let cancelReopenVerifierCalls = 0;
let cancelReopenWorkRequests = 0;
let heldReassignWorkResponse = null;
let reassignWorkHoldUsed = false;
let reassignWorkRequests = 0;
let heldNetworkReconnectResponse = null;
let networkReconnectHoldUsed = false;
const networkProbeFile = join(testDataDir, "network-probe-calls.jsonl");
const networkReconnectProbeFile = join(testDataDir, "network-reconnect-probe-calls.jsonl");
const networkReconnectConnectFile = join(testDataDir, "network-reconnect-connects.log");
const networkProbeCalls = () => {
  try {
    return readFileSync(networkProbeFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const lineCount = (path) => {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
try {
const up = await waitFor(async () => {
  if (serverExit) return false;
  try {
    const r = await fetch(`${BASE}/__test/instance`);
    const body = await r.json().catch(() => ({}));
    return r.ok && body.instance_id === TEST_INSTANCE_ID;
  } catch {
    return false;
  }
}, 15000);
check("A1", "隔离服务启动可达且实例探针匹配", up, serverExit ? JSON.stringify(serverExit) : `port=${PORT}`);
if (!up) {
  throw new Error(`regression server failed to start: ${JSON.stringify(serverExit)}`);
}

// 鉴权：未登录访问受保护 API 应 401；登录后下发会话 cookie
let sessionCookie = "";
const unauth = await fetch(`${BASE}/bootstrap`);
const login = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PW }),
});
const lsc = login.headers.get("set-cookie");
if (lsc) { const m = lsc.match(/aiteam_session=[^;]+/); if (m) sessionCookie = m[0]; }
check("AUTH1", "鉴权：未登录 API 401 + 登录下发会话 cookie", unauth.status === 401 && login.ok && sessionCookie.length > 0);

const J = async (path, init = {}) => {
  const headers = { "Content-Type": "application/json", ...(init.headers ?? {}), ...(sessionCookie ? { Cookie: sessionCookie } : {}) };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) { const m = sc.match(/aiteam_session=[^;]+/); if (m) sessionCookie = m[0]; }
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
};

const runProviderBenchmark = async (providerId, scope = {}) => {
  const planResponse = await J(`/providers/${providerId}/task-test/plan`);
  if (!planResponse.ok) return planResponse;
  const plan = planResponse.body;
  return J(`/providers/${providerId}/task-test`, {
    method: "POST",
    body: JSON.stringify({
      ...scope,
      confirmation_version: plan.confirmation_version,
      confirmed_budget_billable: plan.budget_billable,
    }),
  });
};

fakeOpenAiServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = JSON.parse(raw || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolMessages = messages.filter((m) => m.role === "tool");
    const tools = Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name).filter(Boolean) : [];
    const serializedMessages = JSON.stringify(messages);
    const isQualityBenchmarkRequest = serializedMessages.includes("真实模型质量基准：AiTeam 产品落地决策简报");
    if (isQualityBenchmarkRequest && tools.includes("write_document")) {
      qualityBenchmarkWorkerRequests.push({ model: String(body.model || ""), tools: [...tools], messages: serializedMessages });
    }
    if (isQualityBenchmarkRequest && tools.includes("submit_verdict")) {
      qualityBenchmarkVerifierRequests.push({ model: String(body.model || ""), tools: [...tools], messages: serializedMessages });
    }
    const hasToolResult = toolMessages.length > 0;
    const isNetworkApprovalProbe =
      tools.includes(NETWORK_PROBE_TOOL) &&
      messages.some((message) => JSON.stringify(message).includes(NETWORK_APPROVAL_MARKER));
    const isNetworkReconnectProbe =
      tools.includes(NETWORK_RECONNECT_PROBE_TOOL) &&
      messages.some((message) => JSON.stringify(message).includes(NETWORK_RECONNECT_MARKER));
    const hasApprovedNetworkGrantBrief =
      messages.some((message) => JSON.stringify(message).includes("用户刚批准的单次网络调用"));
    const isStopDuringVerificationProbe =
      messages.some((message) => JSON.stringify(message).includes(STOP_DURING_VERIFICATION_MARKER));
    const isCancelReopenDuringVerificationProbe =
      messages.some((message) => JSON.stringify(message).includes(CANCEL_REOPEN_DURING_VERIFICATION_MARKER));
    const isReassignDuringWorkProbe =
      messages.some((message) => JSON.stringify(message).includes(REASSIGN_DURING_WORK_MARKER));
    if (isCancelReopenDuringVerificationProbe && tools.includes("write_document") && !hasToolResult) {
      cancelReopenWorkRequests++;
    }
    if (isReassignDuringWorkProbe && tools.includes("write_document") && !hasToolResult) {
      reassignWorkRequests++;
    }
    const toolCall = (name, args) => ({
      id: `call_${name}_${Date.now()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    let message = { role: "assistant", content: `AiTeam 模型通道可用：${body.model}` };
    if (isNetworkReconnectProbe && toolMessages.length === 0) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall(NETWORK_RECONNECT_PROBE_TOOL, {
          query: "must-not-run-after-stop",
          limit: 1,
        })],
      };
    } else if (isNetworkApprovalProbe && toolMessages.length === 0) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall(NETWORK_PROBE_TOOL, { query: "公开资料：AiTeam scoped approval", limit: 2 })],
      };
    } else if (isNetworkApprovalProbe && toolMessages.length === 1 && tools.includes("write_document")) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("write_document", {
          title: "Network approval E2E delivery",
          kind: "report",
          content: `# Network approval E2E delivery\n\n${NETWORK_APPROVAL_MARKER}\n\nTL;DR: scoped network MCP executed exactly once after approval.\n\n## 自查表\n- 单次授权 -> 满足 -> 已由回归计数器核验。`,
        })],
      };
    } else if (isNetworkApprovalProbe && toolMessages.length >= 2) {
      message = { role: "assistant", content: "Network approval E2E completed." };
    } else if (isCancelReopenDuringVerificationProbe && tools.includes("submit_verdict") && !hasToolResult) {
      cancelReopenVerifierCalls++;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("submit_verdict", {
          result: cancelReopenVerifierCalls === 1 ? "revise" : "pass",
          reasons: cancelReopenVerifierCalls === 1
            ? "hold first verdict so cancellation can race with retry"
            : "rerun after old worker drained",
        })],
      };
    } else if (tools.includes("submit_verdict") && !hasToolResult) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("submit_verdict", { result: "pass", reasons: "fake verifier pass" })],
      };
    } else if (isQualityBenchmarkRequest && tools.includes("write_document") && !hasToolResult) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("write_document", {
          title: "AiTeam 14 天产品落地决策简报",
          kind: "report",
          content: String(body.model || "").includes("hollow")
            ? "# 决策简报\n\n建议尽快上线。\n\n## 自查表\n1. 满足\n2. 满足\n3. 满足\n4. 满足\n5. 满足\n6. 满足\n7. 满足"
            : benchmarkGoodReport,
        })],
      };
    } else if (tools.includes("write_document") && !hasToolResult) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("write_document", {
          title: "Fake provider task delivery",
          kind: "report",
          content: "# Fake provider task delivery\n\nTL;DR: fake provider used write_document successfully.\n\n## 自查表\n- 验收标准 -> 满足 -> 本文档由工具写入。",
        })],
      };
    } else if (hasToolResult) {
      message = { role: "assistant", content: "Fake provider completed tool result follow-up." };
    }
    const respond = () => {
      const modelName = String(body.model || "");
      const usage = modelName.includes("high-usage")
        ? { prompt_tokens: 22000, completion_tokens: 9000, total_tokens: 31000 }
        : modelName.includes("near-budget")
          ? { prompt_tokens: 15000, completion_tokens: 3000, total_tokens: 18000 }
          : { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
      if (body.stream === true) {
        // 真流式路径：模拟国内 OpenAI 兼容通道的 SSE 分片（含 stream_options.include_usage 的末尾 usage 块）
        fakeOpenAiStreamHits++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const chunk = (delta, finish = null) => ({ id: "chatcmpl-regression", choices: [{ index: 0, delta, finish_reason: finish }] });
        if (message.tool_calls?.length) {
          const tc = message.tool_calls[0];
          const args = tc.function.arguments;
          const half = Math.ceil(args.length / 2);
          send(chunk({ role: "assistant", tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }));
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }));
          send(chunk({}, "tool_calls"));
        } else {
          const text = String(message.content ?? "");
          const half = Math.ceil(text.length / 2);
          send(chunk({ role: "assistant", content: text.slice(0, half) }));
          send(chunk({ content: text.slice(half) }));
          send(chunk({}, "stop"));
        }
        send({ id: "chatcmpl-regression", choices: [], usage });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-regression",
        choices: [{ message, finish_reason: message.tool_calls?.length ? "tool_calls" : "stop" }],
        usage,
      }));
    };
    // 给 stop/cancel 回归留出稳定窗口：模型已开始生成 network tool_use，但工具尚未返回给引擎。
    if (
      isNetworkReconnectProbe &&
      hasApprovedNetworkGrantBrief &&
      toolMessages.length === 0 &&
      !networkReconnectHoldUsed
    ) {
      networkReconnectHoldUsed = true;
      heldNetworkReconnectResponse = respond;
    } else if (
      isReassignDuringWorkProbe &&
      tools.includes("write_document") &&
      hasToolResult &&
      !reassignWorkHoldUsed
    ) {
      reassignWorkHoldUsed = true;
      heldReassignWorkResponse = respond;
    } else if (
      isCancelReopenDuringVerificationProbe &&
      tools.includes("submit_verdict") &&
      !hasToolResult &&
      !cancelReopenVerificationHoldUsed
    ) {
      cancelReopenVerificationHoldUsed = true;
      heldCancelReopenVerificationResponse = respond;
    } else if (
      isStopDuringVerificationProbe &&
      tools.includes("submit_verdict") &&
      !hasToolResult &&
      !stopVerificationHoldUsed
    ) {
      stopVerificationHoldUsed = true;
      heldStopVerificationResponse = respond;
    } else if (isNetworkApprovalProbe && toolMessages.length === 0) setTimeout(respond, 300);
    else respond();
  });
});
await new Promise((resolve) => fakeOpenAiServer.listen(0, "127.0.0.1", resolve));
const fakeOpenAiBase = `http://127.0.0.1:${fakeOpenAiServer.address().port}/v1`;

  // AUTH2 角色门控 + 多用户隔离：注册第二个用户(member)，应被挡在 admin 配置外、且看不到管理员的频道
  {
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@test.local", password: "member-pw-123", display_name: "成员" }),
    });
    let memberCookie = "";
    const rsc = reg.headers.get("set-cookie");
    if (rsc) { const m = rsc.match(/aiteam_session=[^;]+/); if (m) memberCookie = m[0]; }
    const regBody = await reg.json().catch(() => ({}));
    const mHdr = { headers: { "Content-Type": "application/json", Cookie: memberCookie } };
    const forbidden = (await fetch(`${BASE}/image-provider`, { method: "PUT", ...mHdr, body: JSON.stringify({ model: "x" }) })).status === 403;
    const memberBoot = await (await fetch(`${BASE}/bootstrap`, { headers: { Cookie: memberCookie } })).json();
    const isolated = Array.isArray(memberBoot.channels) && !memberBoot.channels.some((c) => c.id === ch.id);
    enterOwner(ownerFromUserId(testUser.id));
    const stopScopeServer = db.createMcpServer({
      name: "stop_scope_probe",
      kind: "http",
      url: "https://stop-scope.example/mcp",
      safety: "network",
    });
    const stopScopeTool = "mcp__stop_scope_probe__search";
    const stopScopeInput = { query: "验证跨租户 stop 不得污染进程状态" };
    const stopScopeTask = db.createTask({
      channel_id: ch.id,
      title: "回归-stop-跨租户隔离",
      assignee_agent_id: eng.id,
      created_by: "user",
    });
    db.updateTask(stopScopeTask.id, { status: "doing" });
    const crossTenantStop = await fetch(`${BASE}/tasks/${stopScopeTask.id}/stop`, { method: "POST", ...mHdr });
    const missingStop = await fetch(`${BASE}/tasks/nonexistent-stop-${Date.now()}/stop`, { method: "POST", ...mHdr });
    enterOwner(ownerFromUserId(testUser.id));
    const stopScopeRequest = engine.requestNetworkApprovalForTask(
      eng,
      db.getTask(stopScopeTask.id),
      stopScopeTool,
      stopScopeInput,
      "验证 stop 权限隔离",
      "跨租户请求不得给本任务写入进程级停止标记",
    );
    if (stopScopeRequest) db.resolveApproval(stopScopeRequest.approvalId, false);
    db.updateTask(stopScopeTask.id, { status: "cancelled", blocked_approval_id: null });
    db.deleteMcpServer(stopScopeServer.id);
    check("AUTH2", "角色门控：member 注册为 member + 被挡在 admin 配置外(403) + 看不到他人频道",
      regBody.role === "member" && forbidden && isolated);
    check(
      "AUTH2B",
      "任务停止权限：跨租户/不存在任务均 404，且不得污染受害任务的进程级停止状态",
      crossTenantStop.status === 404 && missingStop.status === 404 && Boolean(stopScopeRequest),
      `crossTenant=${crossTenantStop.status} missing=${missingStop.status} stateClean=${Boolean(stopScopeRequest)}`,
    );
  }

  // B1 聊天管线（mock 应答）
  {
    const sent = await J(`/channels/${ch.id}/messages`, { method: "POST", body: JSON.stringify({ content: "@产品经理 回归冒烟" }) });
    const replied = await waitFor(async () => {
      const msgs = (await J(`/channels/${ch.id}/messages`)).body;
      return msgs.some((m) => m.author_type === "agent" && m.status === "complete" && m.created_at >= sent.body.created_at);
    }, 20000);
    check("B1", "聊天管线：@路由 → 流式应答落库", replied);
  }

  // HC3 任务状态 API：blocked 只能由 clarification 流进入；待处理输入/审批不能被关单绕过
  {
    enterOwner(ownerFromUserId(testUser.id));
    const t1 = db.createTask({ channel_id: ch.id, title: "回归-状态机-普通", assignee_agent_id: eng.id, created_by: "user" });
    const manualBlocked = await J(`/tasks/${t1.id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked" }) });
    const t2 = db.createTask({ channel_id: ch.id, title: "回归-状态机-阻塞", assignee_agent_id: eng.id, created_by: "user" });
    const req = engine.requestClarificationForTask(eng, t2, "确认是否关闭", "仍有待处理输入时不能直接关单。", "继续等待");
    db.db.pragma("wal_checkpoint(FULL)");
    const blockedToReview = await J(`/tasks/${t2.id}`, { method: "PATCH", body: JSON.stringify({ status: "review" }) });
    const blockedToCancelledPending = await J(`/tasks/${t2.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
    await J(`/approvals/${req.approvalId}/resolve`, { method: "POST", body: JSON.stringify({ approve: false }) });
    db.db.pragma("wal_checkpoint(FULL)");
    const blockedToCancelledResolved = await J(`/tasks/${t2.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
    check("HC3", "任务状态 API：禁止手工进入 blocked、禁止 blocked→review、待输入时不能取消、处理后可取消",
      !manualBlocked.ok &&
      !blockedToReview.ok &&
      !blockedToCancelledPending.ok &&
      blockedToCancelledPending.body.error === "task has pending approvals" &&
      blockedToCancelledResolved.ok &&
      blockedToCancelledResolved.body.status === "cancelled",
      `manualBlocked=${manualBlocked.ok} blockedToReview=${blockedToReview.ok} pendingCancel=${blockedToCancelledPending.ok} resolvedCancel=${blockedToCancelledResolved.ok}`);
  }

  // HC3D 取消语义：取消不是交付，也不能用 done 绕过 review
  {
    enterOwner(ownerFromUserId(testUser.id));
    const unfinished = db.createTask({
      channel_id: ch.id,
      title: "回归-未交付不能伪装关单",
      assignee_agent_id: eng.id,
      created_by: "user",
    });
    const fakeDone = await J(`/tasks/${unfinished.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });

    const prerequisite = db.createTask({
      channel_id: ch.id,
      title: "回归-取消前置任务",
      assignee_agent_id: eng.id,
      created_by: "user",
      budget_billable: 120,
    });
    const dependent = db.createTask({
      channel_id: ch.id,
      title: "回归-取消任务不得解锁下游",
      assignee_agent_id: pm.id,
      depends_on: [prerequisite.id],
      created_by: "user",
    });
    const cancelled = await J(`/tasks/${prerequisite.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    });
    const cancelledBudgetEdit = await J(`/tasks/${prerequisite.id}`, {
      method: "PATCH",
      body: JSON.stringify({ budget_billable: 999 }),
    });
    const doneTask = db.createTask({
      channel_id: ch.id,
      title: "回归-完成任务预算冻结",
      assignee_agent_id: eng.id,
      created_by: "user",
      status: "review",
      budget_billable: 240,
    });
    const doneClosed = await J(`/tasks/${doneTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    const doneBudgetEdit = await J(`/tasks/${doneTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ budget_billable: 999 }),
    });
    // 直接构造 doing 快照，避免 Mock worker 在 HTTP 取消请求到达前极速交付造成竞态；
    // 本用例只验证取消状态机与统计语义，真实运行中停止/取消另有 HC3L/HC3M 覆盖。
    const live = db.createTask({
      channel_id: ch.id,
      title: "回归-运行中取消保持终态",
      description: "验证运行中的任务被取消后保持取消终态，且不会误计为交付。",
      acceptance_criteria: "取消后必须保持 cancelled，且不得解锁下游或增加交付统计。",
      assignee_agent_id: eng.id,
      created_by: "user",
    });
    db.updateTask(live.id, { status: "doing" });
    const liveStarted = db.getTask(live.id)?.status === "doing";
    const liveCancelled = await J(`/tasks/${live.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancelEvents = db.listTaskEvents(prerequisite.id);
    const liveEvents = db.listTaskEvents(live.id);
    const downstreamEvents = db.listTaskEvents(dependent.id);
    const cancelledHasNoDeliveryEvidence =
      !cancelEvents.some((event) => event.type === "delivery" || event.type === "verification") &&
      !liveEvents.some((event) => event.type === "delivery" || event.type === "verification") &&
      db.listVerdictsForTask(prerequisite.id).length === 0 &&
      db.listVerdictsForTask(live.id).length === 0 &&
      !db.listDocuments().some((doc) => doc.task_id === prerequisite.id || doc.task_id === live.id);
    check(
      "HC3D",
      "取消语义：未交付不能置 done；cancelled 不解锁依赖、不计交付或质量覆盖",
      !fakeDone.ok &&
        db.getTask(unfinished.id).status === "todo" &&
        cancelled.ok &&
        cancelled.body.status === "cancelled" &&
        !cancelledBudgetEdit.ok &&
        db.getTask(prerequisite.id).budget_billable === 120 &&
        doneClosed.ok &&
        !doneBudgetEdit.ok &&
        db.getTask(doneTask.id).budget_billable === 240 &&
        liveStarted &&
        liveCancelled.ok &&
        db.getTask(live.id).status === "cancelled" &&
        db.getTask(dependent.id).status === "todo" &&
        !downstreamEvents.some((event) => event.type === "start") &&
        cancelEvents.some((event) => event.type === "cancelled") &&
        liveEvents.some((event) => event.type === "cancelled") &&
        cancelledHasNoDeliveryEvidence,
      `fakeDone=${fakeDone.ok} cancelled=${cancelled.ok} frozenBudget=${!cancelledBudgetEdit.ok}/${!doneBudgetEdit.ok} live=${liveStarted}/${liveCancelled.ok}/${db.getTask(live.id).status} downstream=${db.getTask(dependent.id).status} noDeliveryEvidence=${cancelledHasNoDeliveryEvidence}`,
    );
  }

  // HC3E 交付状态不可由人工通用 PATCH 伪造，否则会提前解锁依赖
  {
    enterOwner(ownerFromUserId(testUser.id));
    const prerequisite = db.createTask({
      channel_id: ch.id,
      title: "回归-运行中任务不能人工伪造交付",
      created_by: "user",
    });
    db.updateTask(prerequisite.id, { status: "doing" });
    const dependent = db.createTask({
      channel_id: ch.id,
      title: "回归-伪造交付不能解锁下游",
      assignee_agent_id: pm.id,
      depends_on: [prerequisite.id],
      created_by: "user",
    });
    const manualReview = await J(`/tasks/${prerequisite.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "review" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const prerequisiteEvents = db.listTaskEvents(prerequisite.id);
    const dependentEvents = db.listTaskEvents(dependent.id);
    check(
      "HC3E",
      "交付状态只能由执行/验收闭环产生：禁止通用 PATCH 把 doing 推进到 review",
      !manualReview.ok &&
        db.getTask(prerequisite.id).status === "doing" &&
        db.getTask(dependent.id).status === "todo" &&
        !prerequisiteEvents.some((event) => event.type === "delivery") &&
        !dependentEvents.some((event) => event.type === "start"),
      `manualReview=${manualReview.ok} prerequisite=${db.getTask(prerequisite.id).status} dependent=${db.getTask(dependent.id).status}`,
    );
  }

  // HC3F 待评审任务退回必须走 revise 接口，不能绕过返工理由、次数和审计事件
  {
    enterOwner(ownerFromUserId(testUser.id));
    const reviewTask = db.createTask({
      channel_id: ch.id,
      title: "回归-待评审退回必须走正式返工",
      created_by: "user",
    });
    db.updateTask(reviewTask.id, { status: "review" });
    const manualTodo = await J(`/tasks/${reviewTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "todo" }),
    });
    check(
      "HC3F",
      "待评审任务不能用通用 PATCH 退回 todo，必须走带原因和审计的 revise",
      !manualTodo.ok &&
        db.getTask(reviewTask.id).status === "review" &&
        db.getTask(reviewTask.id).revision_count === 0,
      `manualTodo=${manualTodo.ok} status=${db.getTask(reviewTask.id).status} revisions=${db.getTask(reviewTask.id).revision_count}`,
    );
  }

  // HC3G 运行中任务只能走 stop/cancel，不能用通用状态 PATCH 制造“已停止”假象
  {
    enterOwner(ownerFromUserId(testUser.id));
    const doingTask = db.createTask({
      channel_id: ch.id,
      title: "回归-运行中停止必须走停止开关",
      created_by: "user",
    });
    db.updateTask(doingTask.id, { status: "doing" });
    const manualTodo = await J(`/tasks/${doingTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "todo" }),
    });
    check(
      "HC3G",
      "运行中任务不能用通用 PATCH 退回 todo，必须走 stop 或 cancel",
      !manualTodo.ok && db.getTask(doingTask.id).status === "doing",
      `manualTodo=${manualTodo.ok} status=${db.getTask(doingTask.id).status}`,
    );
  }

  // HC3H scoped network action 审批必须恢复原任务，重复 resolve 不得重复恢复/触发
  {
    enterOwner(ownerFromUserId(testUser.id));
    const noRunAgent = { ...eng, id: "network_resume_no_run" };
    const networkServer = db.createMcpServer({
      name: "network_resume",
      kind: "http",
      url: "https://network-resume.example/mcp",
      safety: "network",
    });
    const tool = "mcp__network_resume__search";
    const input = { query: "只检索公开资料", limit: 3 };
    const task = db.createTask({
      channel_id: ch.id,
      title: "回归-network-批准后恢复原任务",
      assignee_agent_id: noRunAgent.id,
      created_by: "user",
    });
    db.updateTask(task.id, { status: "doing" });
    const request = engine.requestNetworkApprovalForTask(
      noRunAgent,
      db.getTask(task.id),
      tool,
      input,
      "批准一次公开资料检索",
      "仅执行列明的工具和参数",
    );
    const malformed = await J(`/approvals/${request.approvalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ approve: "false" }),
    });
    const stillPendingAfterMalformed = db.getApproval(request.approvalId)?.status === "pending";
    const resolved = await J(`/approvals/${request.approvalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ approve: true }),
    });
    db.db.pragma("wal_checkpoint(FULL)");
    const afterFirst = db.getTask(task.id);
    const firstResumeEvents = db.listTaskEvents(task.id).filter(
      (event) => event.type === "approval" && event.summary.includes("任务恢复"),
    ).length;
    const repeated = await J(`/approvals/${request.approvalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ approve: true }),
    });
    db.db.pragma("wal_checkpoint(FULL)");
    const secondResumeEvents = db.listTaskEvents(task.id).filter(
      (event) => event.type === "approval" && event.summary.includes("任务恢复"),
    ).length;
    check(
      "HC3H",
      "network action 批准后恢复原任务且只恢复一次，不得切到无 taskId 的普通 chat",
      resolved.ok &&
        !malformed.ok &&
        stillPendingAfterMalformed &&
        repeated.ok &&
        afterFirst?.status === "todo" &&
        afterFirst.blocked_approval_id === null &&
        engine.taskHasApprovedNetworkGrant(task.id, tool, input, noRunAgent.id) &&
        firstResumeEvents === 1 &&
        secondResumeEvents === firstResumeEvents,
      `malformed=${malformed.ok}/${stillPendingAfterMalformed} resolved=${resolved.ok} status=${afterFirst?.status} grant=${engine.taskHasApprovedNetworkGrant(task.id, tool, input, noRunAgent.id)} resumeEvents=${firstResumeEvents}->${secondResumeEvents}`,
    );
    db.deleteMcpServer(networkServer.id);
  }

  // HC3I scoped network action 被拒后必须保持阻塞，重复 resolve 不得重复写入拒绝事件
  {
    enterOwner(ownerFromUserId(testUser.id));
    const noRunAgent = { ...eng, id: "network_reject_no_run" };
    const networkServer = db.createMcpServer({
      name: "network_reject",
      kind: "http",
      url: "https://network-reject.example/mcp",
      safety: "network",
    });
    const tool = "mcp__network_reject__search";
    const input = { query: "禁止外发的内部材料" };
    const task = db.createTask({
      channel_id: ch.id,
      title: "回归-network-拒绝后保持阻塞",
      assignee_agent_id: noRunAgent.id,
      created_by: "user",
    });
    db.updateTask(task.id, { status: "doing" });
    const request = engine.requestNetworkApprovalForTask(
      noRunAgent,
      db.getTask(task.id),
      tool,
      input,
      "批准一次内部材料检索",
      "本测试应被用户拒绝",
    );
    const rejected = await J(`/approvals/${request.approvalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ approve: false }),
    });
    db.db.pragma("wal_checkpoint(FULL)");
    const afterFirst = db.getTask(task.id);
    const firstRejectEvents = db.listTaskEvents(task.id).filter(
      (event) => event.type === "approval" && event.summary.includes("拒绝网络调用"),
    ).length;
    const repeated = await J(`/approvals/${request.approvalId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ approve: false }),
    });
    db.db.pragma("wal_checkpoint(FULL)");
    const secondRejectEvents = db.listTaskEvents(task.id).filter(
      (event) => event.type === "approval" && event.summary.includes("拒绝网络调用"),
    ).length;
    check(
      "HC3I",
      "network action 被拒后保持原任务阻塞且只记录一次，不得留下可用授权",
      rejected.ok &&
        repeated.ok &&
        afterFirst?.status === "blocked" &&
        afterFirst.blocked_approval_id === request.approvalId &&
        !engine.taskHasApprovedNetworkGrant(task.id, tool, input, noRunAgent.id) &&
        firstRejectEvents === 1 &&
        secondRejectEvents === firstRejectEvents,
      `rejected=${rejected.ok} status=${afterFirst?.status} grant=${engine.taskHasApprovedNetworkGrant(task.id, tool, input, noRunAgent.id)} rejectEvents=${firstRejectEvents}->${secondRejectEvents}`,
    );
    db.deleteMcpServer(networkServer.id);
  }

  // HC3K 改派/取消/手工重试必须关闭旧 network grant，且已处理的 blocked 任务可从详情恢复
  {
    enterOwner(ownerFromUserId(testUser.id));
    const noRunAgent = { ...eng, id: "network_context_no_run" };
    const networkServer = db.createMcpServer({
      name: "network_context",
      kind: "http",
      url: "https://network-context.example/mcp",
      safety: "network",
    });
    const tool = "mcp__network_context__search";
    const input = { query: "上下文撤销测试" };

    const reassignedTask = db.createTask({
      channel_id: ch.id,
      title: "回归-network-路由改派关闭授权",
      description: "验证负责人变更后旧的网络授权不可复活。",
      acceptance_criteria: "旧负责人授权必须关闭，改派后不得复用。",
      assignee_agent_id: noRunAgent.id,
      created_by: "user",
    });
    db.updateTask(reassignedTask.id, { status: "doing" });
    const reassignedRequest = engine.requestNetworkApprovalForTask(
      noRunAgent,
      db.getTask(reassignedTask.id),
      tool,
      input,
      "批准一次改派前调用",
      "改派后必须失效",
    );
    db.resolveApproval(reassignedRequest.approvalId, true);
    db.updateTask(reassignedTask.id, { status: "todo", blocked_approval_id: null });
    const reassigned = await J(`/tasks/${reassignedTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ assignee_agent_id: "network_context_new_owner" }),
    });
    const reassignedConsumed = Boolean(db.getApproval(reassignedRequest.approvalId)?.consumed_at);
    await J(`/tasks/${reassignedTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ assignee_agent_id: noRunAgent.id }),
    });
    db.updateTask(reassignedTask.id, { status: "doing" });
    const reassignedCannotRevive =
      !engine.taskHasApprovedNetworkGrant(reassignedTask.id, tool, input, noRunAgent.id);

    const cancelledTask = db.createTask({
      channel_id: ch.id,
      title: "回归-network-取消关闭授权",
      description: "验证取消任务后旧的网络授权不可复活。",
      acceptance_criteria: "任务取消后旧授权必须关闭且不得复用。",
      assignee_agent_id: noRunAgent.id,
      created_by: "user",
    });
    db.updateTask(cancelledTask.id, { status: "doing" });
    const cancelledRequest = engine.requestNetworkApprovalForTask(
      noRunAgent,
      db.getTask(cancelledTask.id),
      tool,
      input,
      "批准一次取消前调用",
      "取消后必须失效",
    );
    db.resolveApproval(cancelledRequest.approvalId, true);
    db.updateTask(cancelledTask.id, { status: "todo", blocked_approval_id: null });
    const cancelled = await J(`/tasks/${cancelledTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    });
    const cancelledConsumed = Boolean(db.getApproval(cancelledRequest.approvalId)?.consumed_at);
    await J(`/tasks/${cancelledTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "todo" }),
    });
    db.updateTask(cancelledTask.id, { status: "doing" });
    const cancelledCannotRevive =
      !engine.taskHasApprovedNetworkGrant(cancelledTask.id, tool, input, noRunAgent.id);

    const rejectedTask = db.createTask({
      channel_id: ch.id,
      title: "回归-network-拒绝后可调整重试",
      description: "验证拒绝网络授权后可以调整任务并重新尝试。",
      acceptance_criteria: "拒绝后保持阻塞；人工恢复时清除阻塞引用并留下事件。",
      assignee_agent_id: noRunAgent.id,
      created_by: "user",
    });
    db.updateTask(rejectedTask.id, { status: "doing" });
    const rejectedRequest = engine.requestNetworkApprovalForTask(
      noRunAgent,
      db.getTask(rejectedTask.id),
      tool,
      input,
      "批准一次将被拒绝的调用",
      "拒绝后从详情调整重试",
    );
    const rejectedApproval = db.resolveApproval(rejectedRequest.approvalId, false);
    if (rejectedApproval) engine.onNetworkApprovalResolved(rejectedApproval);
    const resumed = await J(`/tasks/${rejectedTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "todo" }),
    });
    const resumedEvent = db.listTaskEvents(rejectedTask.id).some(
      (event) => event.type === "handoff" && event.summary.includes("恢复任务并重新尝试"),
    );

    check(
      "HC3K",
      "network grant 上下文撤销：改派/取消后不可复活，已处理的 blocked 任务可调整后重试",
      reassigned.ok &&
        reassignedConsumed &&
        reassignedCannotRevive &&
        cancelled.ok &&
        cancelledConsumed &&
        cancelledCannotRevive &&
        resumed.ok &&
        resumed.body.status === "todo" &&
        resumed.body.blocked_approval_id === null &&
        resumedEvent,
      `reassigned=${reassigned.ok}/${reassignedConsumed}/${reassignedCannotRevive} cancelled=${cancelled.ok}/${cancelledConsumed}/${cancelledCannotRevive} resumed=${resumed.ok}/${resumed.body.status}/${resumedEvent}`,
    );
    db.deleteMcpServer(networkServer.id);
  }

  // HC3N 已批准但未消费的精确 network grant 不能跨执行边界复活：
  // 自动交付、人工 done、人工 revise、项目 close 都必须永久关闭旧授权。
  {
    enterOwner(ownerFromUserId(testUser.id));
    const noRunAgent = { ...eng, id: "network_lifecycle_no_run" };
    const networkServer = db.createMcpServer({
      name: "network_lifecycle",
      kind: "http",
      url: "https://network-lifecycle.example/mcp",
      safety: "network",
    });
    const tool = "mcp__network_lifecycle__search";
    const input = { query: "授权生命周期边界", limit: 1 };
    const issueApprovedGrant = (title, projectId = null) => {
      const task = db.createTask({
        channel_id: ch.id,
        project_id: projectId,
        title,
        assignee_agent_id: noRunAgent.id,
        created_by: "user",
      });
      db.updateTask(task.id, { status: "doing" });
      const request = engine.requestNetworkApprovalForTask(
        noRunAgent,
        db.getTask(task.id),
        tool,
        input,
        `批准一次调用：${title}`,
        "离开本次执行上下文后必须失效",
      );
      if (request) db.resolveApproval(request.approvalId, true);
      db.updateTask(task.id, { status: "review", blocked_approval_id: null });
      return { task: db.getTask(task.id), approvalId: request?.approvalId ?? "" };
    };
    const closedAndCannotRevive = ({ task, approvalId }) => {
      const consumed = Boolean(db.getApproval(approvalId)?.consumed_at);
      db.updateTask(task.id, {
        status: "doing",
        assignee_agent_id: noRunAgent.id,
        blocked_approval_id: null,
      });
      return consumed && !engine.taskHasApprovedNetworkGrant(task.id, tool, input, noRunAgent.id);
    };

    const delivered = issueApprovedGrant("回归-network-交付关闭授权");
    engine.onTaskDelivered(delivered.task);
    const deliveryClosed = closedAndCannotRevive(delivered);

    const done = issueApprovedGrant("回归-network-done关闭授权");
    const doneResult = await J(`/tasks/${done.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    const doneClosed = doneResult.ok && closedAndCannotRevive(done);

    const revised = issueApprovedGrant("回归-network-revise关闭授权");
    const reviseResult = await J(`/tasks/${revised.task.id}/revise`, {
      method: "POST",
      body: JSON.stringify({ reason: "新一轮返工不得继承旧网络批准" }),
    });
    const reviseClosed = reviseResult.ok && closedAndCannotRevive(revised);

    const project = db.createProject({
      channel_id: ch.id,
      lead_agent_id: pm.id,
      title: "回归-network-项目关单关闭授权",
      goal: "项目关闭后旧 network grant 不得复活",
      status: "review",
    });
    const projectTask = issueApprovedGrant("回归-network-project-close关闭授权", project.id);
    const closeResult = await J(`/projects/${project.id}/close`, { method: "POST" });
    const projectCloseClosed = closeResult.ok && closedAndCannotRevive(projectTask);

    check(
      "HC3N",
      "network grant 生命周期：delivery/review/done/revise/project close 后旧授权不可跨运行复活",
      deliveryClosed && doneClosed && reviseClosed && projectCloseClosed,
      `delivery=${deliveryClosed} done=${doneResult.ok}/${doneClosed} revise=${reviseResult.ok}/${reviseClosed} projectClose=${closeResult.ok}/${projectCloseClosed}`,
    );
    db.deleteMcpServer(networkServer.id);
  }

  // HC3Q 任务开工质量闸：有负责人就意味着会自动开工，必须先具备可执行的任务简报
  {
    const incomplete = await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: "回归-缺少输出契约不得开工",
        assignee_agent_id: eng.id,
      }),
    });
    check(
      "HC3Q",
      "任务开工质量闸：缺少背景与验收标准的已指派任务拒绝自动开工",
      !incomplete.ok &&
        incomplete.body?.code === "TASK_BRIEF_INCOMPLETE" &&
        incomplete.body?.missing?.includes("description") &&
        incomplete.body?.missing?.includes("acceptance_criteria"),
      `ok=${incomplete.ok} code=${incomplete.body?.code ?? "?"} missing=${incomplete.body?.missing?.join(",") ?? "?"}`,
    );
  }

  {
    const draft = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({ channel_id: ch.id, title: "回归-不完整待办" }),
    })).body;
    const assigned = await J(`/tasks/${draft.id}`, {
      method: "PATCH",
      body: JSON.stringify({ assignee_agent_id: eng.id }),
    });
    check(
      "HC3Q2",
      "任务开工质量闸：不完整待办不能通过后续指派绕过输出契约",
      !assigned.ok &&
        assigned.body?.code === "TASK_BRIEF_INCOMPLETE" &&
        db.getTask(draft.id)?.assignee_agent_id === null,
      `ok=${assigned.ok} code=${assigned.body?.code ?? "?"} assignee=${db.getTask(draft.id)?.assignee_agent_id ?? "null"}`,
    );
  }

  {
    const selfReviewed = await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: "回归-执行与复核必须分离",
        description: "输出一份可核验的回归报告。",
        acceptance_criteria: "交付物：一份 report；必须逐条说明验证结果。",
        assignee_agent_id: eng.id,
        reviewer_agent_id: eng.id,
      }),
    });
    check(
      "HC3Q3",
      "任务开工质量闸：显式复核人不能与负责人相同",
      !selfReviewed.ok && selfReviewed.body?.code === "TASK_REVIEWER_CONFLICT",
      `ok=${selfReviewed.ok} code=${selfReviewed.body?.code ?? "?"}`,
    );
  }

  // HC3C clarification HTTP 闭环：用户输入必须随审批一起持久化，并进入任务活动日志
  {
    const task = db.createTask({ channel_id: ch.id, title: "回归-HTTP-输入恢复", assignee_agent_id: eng.id, created_by: "user" });
    const req = engine.requestClarificationForTask(eng, task, "请选择引用口径", "需要用户确认引用范围。", "只引用上传材料");
    const response = "允许引用上传材料和本频道已确认结论，不访问外网。";
    const resolved = await J(`/approvals/${req.approvalId}/resolve`, { method: "POST", body: JSON.stringify({ approve: true, response }) });
    const resumed = await waitFor(() => db.getTask(task.id).status === "review", 20000);
    const freshApproval = db.getApproval(req.approvalId);
    const events = db.listTaskEvents(task.id);
    const ok =
      resolved.ok &&
      resolved.body.status === "approved" &&
      freshApproval.payload.includes(response) &&
      resumed &&
      events.some((e) => e.type === "approval" && (e.summary.includes(response) || e.metadata_json.includes(response)));
    check("HC3C", "clarification HTTP 闭环：用户输入随审批保存，恢复后进入任务活动日志",
      ok,
      `resolved=${resolved.ok} status=${resolved.body.status} resumed=${resumed} events=${events.map((e) => e.type).join(",")}`);
  }

  // HC3B 复核人责任链：显式 reviewer 创建/修改/清空都必须进入结构化任务事件，避免 UI 责任链不可审计
  {
    const created = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: "回归-复核人留痕",
        description: "验证显式复核人变更会写入任务活动日志。",
        reviewer_agent_id: pm.id,
      }),
    })).body;
    const changed = await J(`/tasks/${created.id}`, { method: "PATCH", body: JSON.stringify({ reviewer_agent_id: eng.id }) });
    const cleared = await J(`/tasks/${created.id}`, { method: "PATCH", body: JSON.stringify({ reviewer_agent_id: null }) });
    const events = (await J(`/tasks/${created.id}/events`)).body;
    const verificationSummaries = events.filter((e) => e.type === "verification").map((e) => e.summary);
    const ok =
      changed.ok &&
      cleared.ok &&
      verificationSummaries.some((s) => s.includes("用户指定复核人") && s.includes(pm.name)) &&
      verificationSummaries.some((s) => s.includes("用户指定复核人") && s.includes(eng.name)) &&
      verificationSummaries.some((s) => s.includes("用户恢复自动复核"));
    check("HC3B", "复核人责任链：创建/修改/清空 reviewer 都写结构化 verification 事件",
      ok,
      `events=${events.map((e) => e.type).join(",")} summaries=${verificationSummaries.join(" | ")}`);
  }

  // QC4 D1 人工退回落表：POST /tasks/:id/revise 写 source=human 的 verdict；HTTP 读侧（verdicts/quality）可见
  {
    const t = db.createTask({ channel_id: ch.id, title: "QC4-人工退回落表", assignee_agent_id: eng.id, created_by: pm.id });
    db.updateTask(t.id, { status: "review" });
    const revise = await J(`/tasks/${t.id}/revise`, { method: "POST", body: JSON.stringify({ reason: "结论缺依据，需补引用" }) });
    const chain = (await J(`/tasks/${t.id}/verdicts`)).body;
    const quality = (await J(`/quality`)).body;
    const humanRow = Array.isArray(chain) && chain.find((v) => v.source === "human");
    check("QC4", "D1 人工退回：revise 路由落 human verdict + /verdicts 与 /quality 读侧可见",
      revise.ok && Boolean(humanRow) && humanRow.reasons.includes("缺依据") &&
      Array.isArray(quality.agents) && quality.recent_revises.some((r) => r.task_id === t.id),
      `verdicts=${Array.isArray(chain) ? chain.length : "?"} human=${Boolean(humanRow)}`);
  }

  // HC4 Helio-style 全链路：频道里的多角色项目 → claim → clarification → 用户确认恢复 → reviewer 退回一次 → 返工再交付 → Lead 汇总 → 人类关闭
  {
    const reviewer = agents.find((a) => a.id !== eng.id && a.id !== pm.id) ?? pm;
    const project = db.createProject({
      channel_id: ch.id,
      lead_agent_id: pm.id,
      title: "回归-Helio式协作",
      goal: "验证 AI 同事在同一频道/任务/审计线里协作，风险动作等人类确认，最终由人类关闭。",
      status: "running",
    });
    const tClaim = db.createTask({
      channel_id: ch.id,
      project_id: project.id,
      title: "HC4-未分配任务由 AI 认领并交付",
      created_by: "user",
      reviewer_agent_id: reviewer.id,
      acceptance_criteria: "必须有交付物，并进入待评审。",
    });
    const tClarify = db.createTask({
      channel_id: ch.id,
      project_id: project.id,
      title: "HC4-需要用户输入后交付",
      created_by: "user",
      assignee_agent_id: eng.id,
      reviewer_agent_id: reviewer.id,
      acceptance_criteria: "必须先等待用户确认，再恢复并交付。",
    });
    const tGate = db.createTask({
      channel_id: ch.id,
      project_id: project.id,
      title: "HC4-最终检查闸门",
      created_by: "user",
      reviewer_agent_id: reviewer.id,
      acceptance_criteria: "前两项复核通过后才执行，用于触发项目最终汇总。",
    });

    const claimed = engine.claimTaskForAgent(eng, tClaim.id, "Helio-style 原子认领");
    if (claimed.ok) engine.onTaskAssigned(claimed.task);
    const claimDelivered = await waitFor(() => db.getTask(tClaim.id).status === "review", 20000);

    const clarReq = engine.requestClarificationForTask(
      eng,
      db.getTask(tClarify.id),
      "请选择本次输出口径",
      "没有口径选择会导致交付物不可验收。",
      "专业克制，面向产品评审"
    );
    const blocked = db.getTask(tClarify.id).status === "blocked";
    const clarificationResponse = "专业克制，面向产品评审，并明确引用用户确认口径";
    db.updateApprovalPayload(clarReq.approvalId, JSON.stringify({
      question: "请选择本次输出口径",
      context: "没有口径选择会导致交付物不可验收。",
      proposed_default: "专业克制，面向产品评审",
      user_response: clarificationResponse,
    }, null, 2));
    const approval = db.resolveApproval(clarReq.approvalId, true);
    engine.onClarificationResolved(approval, true);
    const afterClarification = await waitFor(() => db.getTask(tClarify.id).status === "review", 20000);

    const revised = await J(`/tasks/${tClarify.id}/revise`, {
      method: "POST",
      body: JSON.stringify({ reason: "复核发现缺少人类确认口径引用，请补充后重新交付。" }),
    });
    const reDelivered = await waitFor(() => {
      const t = db.getTask(tClarify.id);
      return t.status === "review" && t.revision_count >= 1;
    }, 20000);

    const gateClaim = engine.claimTaskForAgent(pm, tGate.id, "前置任务已过复核，执行最终检查");
    if (gateClaim.ok) engine.onTaskAssigned(gateClaim.task);
    const summarized = await waitFor(() => {
      const p = db.getProject(project.id);
      return p.status === "review" && Boolean(p.summary_doc_id);
    }, 30000);

    const closed = await J(`/projects/${project.id}/close`, { method: "POST" });
    const finalProject = db.getProject(project.id);
    const finalTasks = db.listTasks().filter((t) => t.project_id === project.id);
    const events = finalTasks.flatMap((t) => db.listTaskEvents(t.id));
    const types = new Set(events.map((e) => e.type));
    const ok =
      claimed.ok &&
      claimDelivered &&
      blocked &&
      approval?.status === "approved" &&
      afterClarification &&
      revised.ok &&
      reDelivered &&
      gateClaim.ok &&
      summarized &&
      closed.ok &&
      finalProject.status === "done" &&
      finalTasks.every((t) => t.status === "done") &&
      ["claim", "blocked", "approval", "verification", "handoff", "delivery", "user_close"].every((x) => types.has(x)) &&
      events.some((e) => e.metadata_json.includes(clarificationResponse) || e.summary.includes(clarificationResponse));
    check("HC4", "Helio式核心场景：多角色项目 claim→阻塞输入→审批恢复→复核退回→返工交付→汇总→人类关闭",
      ok,
      `claim=${claimed.ok} blocked=${blocked} approved=${approval?.status} revise=${revised.ok} redeliver=${reDelivered} summary=${summarized} close=${closed.ok} events=${[...types].join(",")}`);
  }

  // HC4B human-only 关单硬门：服务端不能被绕过 UI 直接关闭未交付项目或仍有待审批的项目
  {
    const project = db.createProject({
      channel_id: ch.id,
      lead_agent_id: pm.id,
      title: "回归-项目关单硬门",
      goal: "验证项目关闭必须等待所有任务交付且审批清零。",
      status: "running",
    });
    const task = db.createTask({
      channel_id: ch.id,
      project_id: project.id,
      title: "HC4B-未交付不能关项目",
      created_by: "user",
      assignee_agent_id: eng.id,
      reviewer_agent_id: pm.id,
    });
    const closeBeforeDelivery = await J(`/projects/${project.id}/close`, { method: "POST" });
    const stayedOpen = db.getTask(task.id).status === "todo" && db.getProject(project.id).status !== "done";
    db.updateTask(task.id, { status: "review" });
    const approval = db.createApproval({
      channel_id: ch.id,
      agent_id: eng.id,
      title: "HC4B-待审批",
      payload: "仍有待审批动作时，项目不能被关闭。",
      kind: "action",
      ref_id: task.id,
    });
    const closeWithApproval = await J(`/projects/${project.id}/close`, { method: "POST" });
    const stillReview = db.getTask(task.id).status === "review" && db.getProject(project.id).status !== "done";
    db.resolveApproval(approval.id, false);
    const projectApproval = db.createApproval({
      channel_id: ch.id,
      agent_id: pm.id,
      title: "HC4B-项目计划审批",
      payload: "项目级计划审批未处理时，项目不能被关闭。",
      kind: "plan",
      ref_id: project.id,
    });
    const closeWithProjectApproval = await J(`/projects/${project.id}/close`, { method: "POST" });
    const projectStillReview = db.getTask(task.id).status === "review" && db.getProject(project.id).status !== "done";
    db.resolveApproval(projectApproval.id, true);
    const closeAfterResolved = await J(`/projects/${project.id}/close`, { method: "POST" });
    const finalTask = db.getTask(task.id);
    const finalProject = db.getProject(project.id);
    const ok =
      !closeBeforeDelivery.ok &&
      closeBeforeDelivery.body.error === "project has unfinished tasks" &&
      stayedOpen &&
      !closeWithApproval.ok &&
      closeWithApproval.body.error === "project has pending approvals" &&
      stillReview &&
      !closeWithProjectApproval.ok &&
      closeWithProjectApproval.body.error === "project has pending approvals" &&
      projectStillReview &&
      closeAfterResolved.ok &&
      finalTask.status === "done" &&
      finalProject.status === "done";
    check("HC4B", "项目关单硬门：未交付/待审批项目不能通过 API 绕过人类验收直接关闭",
      ok,
      `unfinishedBlocked=${!closeBeforeDelivery.ok} taskApprovalBlocked=${!closeWithApproval.ok} projectApprovalBlocked=${!closeWithProjectApproval.ok} final=${finalProject.status}/${finalTask.status}`);
  }

  // HC4C 取消是终态但不是交付：混合 review/cancelled 项目可关单，且 cancelled 必须保持取消
  {
    const project = db.createProject({
      channel_id: ch.id,
      lead_agent_id: pm.id,
      title: "回归-混合终态项目关单",
      goal: "验证取消任务不阻塞项目归档，也不会被伪装成已交付。",
      status: "review",
    });
    const reviewTask = db.createTask({
      channel_id: ch.id,
      project_id: project.id,
      title: "HC4C-已交付任务",
      created_by: "user",
      status: "review",
    });
    const cancelledTask = db.createTask({
      channel_id: ch.id,
      project_id: project.id,
      title: "HC4C-已取消任务",
      created_by: "user",
      status: "cancelled",
    });
    const closed = await J(`/projects/${project.id}/close`, { method: "POST" });
    const finalProject = db.getProject(project.id);
    const finalReviewTask = db.getTask(reviewTask.id);
    const finalCancelledTask = db.getTask(cancelledTask.id);
    const reviewCloseEvents = db.listTaskEvents(reviewTask.id).filter((event) => event.type === "user_close");
    const cancelledCloseEvents = db.listTaskEvents(cancelledTask.id).filter((event) => event.type === "user_close");
    const ok =
      closed.ok &&
      finalProject.status === "done" &&
      finalReviewTask.status === "done" &&
      finalCancelledTask.status === "cancelled" &&
      reviewCloseEvents.length === 1 &&
      cancelledCloseEvents.length === 0;
    check(
      "HC4C",
      "项目混合终态关单：review 转完成，cancelled 保持取消且不计作人工验收",
      ok,
      `close=${closed.ok} project=${finalProject.status} review=${finalReviewTask.status}/${reviewCloseEvents.length} cancelled=${finalCancelledTask.status}/${cancelledCloseEvents.length}`,
    );
  }

  // HC4D 全取消项目也应可归档，但不能制造任何已交付/人工验收记录
  {
    const project = db.createProject({
      channel_id: ch.id,
      lead_agent_id: pm.id,
      title: "回归-全取消项目关单",
      goal: "验证项目可结束，但取消项始终保持取消语义。",
      status: "running",
    });
    const cancelledTasks = [
      db.createTask({
        channel_id: ch.id,
        project_id: project.id,
        title: "HC4D-取消任务一",
        created_by: "user",
        status: "cancelled",
      }),
      db.createTask({
        channel_id: ch.id,
        project_id: project.id,
        title: "HC4D-取消任务二",
        created_by: "user",
        status: "cancelled",
      }),
    ];
    const closed = await J(`/projects/${project.id}/close`, { method: "POST" });
    const finalProject = db.getProject(project.id);
    const finalTasks = cancelledTasks.map((task) => db.getTask(task.id));
    const closeEvents = cancelledTasks.flatMap((task) =>
      db.listTaskEvents(task.id).filter((event) => event.type === "user_close"),
    );
    const ok =
      closed.ok &&
      finalProject.status === "done" &&
      finalTasks.every((task) => task.status === "cancelled") &&
      closeEvents.length === 0 &&
      Array.isArray(closed.body.tasks) &&
      closed.body.tasks.length === 0;
    check(
      "HC4D",
      "项目全取消关单：项目可归档，取消任务保持 cancelled 且不产生人工验收",
      ok,
      `close=${closed.ok} project=${finalProject.status} tasks=${finalTasks.map((task) => task.status).join(",")} changed=${closed.body.tasks?.length} events=${closeEvents.length}`,
    );
  }

  // HC5 产品内协作演练入口：HTTP 启动三步项目，任务带 DAG/负责人/复核人，活动日志结构化可观测，最终进入待评审汇总
  {
    const started = await J(`/scenarios/helio-core/start`, { method: "POST", body: JSON.stringify({ channel_id: ch.id }) });
    const project = started.body.project;
    const tasks = started.body.tasks ?? [];
    const projectReviewed = await waitFor(() => db.getProject(project.id)?.status === "review", 30000);
    const latestTasks = db.listTasks().filter((t) => t.project_id === project.id);
    const allDelivered = latestTasks.length === 3 && latestTasks.every((t) => t.status === "review");
    const deps = latestTasks.map((t) => JSON.parse(t.depends_on || "[]"));
    const hasDag = deps.some((d) => d.length === 1) && deps.some((d) => d.length === 2);
    const events = latestTasks.flatMap((t) => db.listTaskEvents(t.id));
    const types = new Set(events.map((e) => e.type));
    const ok =
      started.ok &&
      project?.status === "running" &&
      tasks.length === 3 &&
      latestTasks.every((t) => t.assignee_agent_id && t.reviewer_agent_id) &&
      hasDag &&
      types.has("created") &&
      types.has("claim") &&
      types.has("delivery") &&
      projectReviewed &&
      allDelivered;
    check("HC5", "产品内协作演练入口：HTTP 启动三步 DAG 项目，结构化审计，自动交付并进入项目待评审",
      ok,
      `start=${started.ok} tasks=${tasks.length} dag=${hasDag} review=${projectReviewed} delivered=${allDelivered} events=${[...types].join(",")}`);
  }

  // HC5C 场景复用：同频道同场景未关闭时，重复点击不应创建重复项目和重复子任务
  {
    const first = await J(`/scenarios/solution-deck/start`, { method: "POST", body: JSON.stringify({ channel_id: ch.id }) });
    const project = first.body.project;
    const firstTasks = first.body.tasks ?? [];
    const second = await J(`/scenarios/solution-deck/start`, { method: "POST", body: JSON.stringify({ channel_id: ch.id }) });
    const secondTasks = second.body.tasks ?? [];
    const projects = db.listProjects().filter((p) => p.channel_id === ch.id && p.title === project.title);
    const tasks = db.listTasks().filter((t) => t.project_id === project.id);
    const ok =
      first.ok &&
      second.ok &&
      second.body.reused === true &&
      second.body.project?.id === project.id &&
      projects.length === 1 &&
      firstTasks.length === 4 &&
      secondTasks.length === 4 &&
      tasks.length === 4;
    check("HC5C", "场景复用：同频道同场景未关闭时重复启动只返回现有项目，不创建重复任务",
      ok,
      `reused=${second.body.reused} projects=${projects.length} firstTasks=${firstTasks.length} secondTasks=${secondTasks.length} storedTasks=${tasks.length}`);
  }

  {
    const started = await J(`/scenarios/helio-core/start`, { method: "POST", body: JSON.stringify({ channel_id: ch.id, acceptance: true }) });
    const project = started.body.project;
    const projectReviewed = await waitFor(() => db.getProject(project.id)?.status === "review", 30000);
    const latestTasks = db.listTasks().filter((t) => t.project_id === project.id);
    const events = latestTasks.flatMap((t) => db.listTaskEvents(t.id));
    const startupEvents = events.filter((e) => e.type === "created" || e.type === "claim");
    const acceptanceEvents = startupEvents.length > 0 && startupEvents.every((e) => {
      try {
        return JSON.parse(e.metadata_json || "{}").acceptance === true;
      } catch {
        return false;
      }
    });
    check("HC5B", "端到端验收入口：创建可恢复识别的闭环验收项目并进入待复核",
      started.ok &&
      project?.title?.startsWith("闭环验收") &&
      latestTasks.length === 3 &&
      projectReviewed &&
      latestTasks.every((t) => t.status === "review") &&
      acceptanceEvents,
      `title=${project?.title} tasks=${latestTasks.length} review=${projectReviewed} acceptanceEvents=${acceptanceEvents}`);
  }

  // HC6 场景库：不只一个 demo，产品内可选择调研/方案等核心工作流模板
  {
    const catalog = await J("/scenarios");
    const ids = new Set((catalog.body ?? []).map((s) => s.id));
    const started = await J(`/scenarios/research-report/start`, { method: "POST", body: JSON.stringify({ channel_id: ch.id }) });
    const project = started.body.project;
    const tasks = started.body.tasks ?? [];
    const projectReviewed = await waitFor(() => db.getProject(project.id)?.status === "review", 30000);
    const latestTasks = db.listTasks().filter((t) => t.project_id === project.id);
    const deps = latestTasks.map((t) => JSON.parse(t.depends_on || "[]").length);
    const events = latestTasks.flatMap((t) => db.listTaskEvents(t.id));
    const scenarioTagged = events.some((e) => {
      try { return JSON.parse(e.metadata_json || "{}").scenario === "research-report"; } catch { return false; }
    });
    const ok =
      catalog.ok &&
      ["helio-core", "research-report", "solution-deck"].every((id) => ids.has(id)) &&
      started.ok &&
      tasks.length === 4 &&
      latestTasks.every((t) => t.assignee_agent_id && t.reviewer_agent_id) &&
      deps.filter((n) => n === 0).length === 1 &&
      deps.filter((n) => n >= 1).length === 3 &&
      projectReviewed &&
      scenarioTagged;
    check("HC6", "场景库：协作演练/调研报告/方案演示可发现，调研报告场景生成四步 DAG 并进入待评审",
      ok,
      `catalog=${[...ids].join(",")} tasks=${tasks.length} deps=${deps.join(",")} review=${projectReviewed} tagged=${scenarioTagged}`);
  }

  // G4 引用回复
  {
    const m1 = (await J(`/channels/${ch.id}/messages`, { method: "POST", body: JSON.stringify({ content: "被引用的原文" }) })).body;
    const m2 = (await J(`/channels/${ch.id}/messages`, { method: "POST", body: JSON.stringify({ content: "引用它", reply_to: m1.id }) })).body;
    check("G4", "引用回复：reply_to 校验并落库", m2.reply_to === m1.id);
  }

  // E1 三类交付格式
  {
    db.createDocument({ channel_id: ch.id, agent_id: eng.id, title: "回归slides", kind: "slides", content: "# A\n\n---\n\n# B" });
    db.createDocument({ channel_id: ch.id, agent_id: eng.id, title: "回归sheet", kind: "sheet", content: "a,b\n1,2" });
    const kinds = new Set((await J("/documents")).body.map((d) => d.kind));
    check("E1", "交付格式：report/slides/sheet 三类齐备", kinds.has("report") && kinds.has("slides") && kinds.has("sheet"),
      `实际=${[...kinds].join(",")}`);
  }

  // G3 技能 CRUD：内置基数引用 BUILTIN_SKILLS.length（扩库不必再改）+ 启停 + 自定义增删 + v2 字段透传
  {
    const skills = (await J("/skills")).body;
    const toggled = (await J(`/skills/${skills[0].id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })).body;
    const custom = (await J("/skills", { method: "POST", body: JSON.stringify({ name: "回归技能", body: "规则X", trigger: "回归,测试", when_to_use: "回归时", kind: "method" }) })).body;
    const fieldsOk = custom.body === "规则X" && custom.trigger === "回归,测试" && custom.when_to_use === "回归时" && custom.kind === "method";
    await J(`/skills/${custom.id}`, { method: "DELETE" });
    const after = (await J("/skills")).body;
    check("G3", `技能：内置${BUILTIN_SKILLS.length} + 启停 + 自定义增删 + v2字段(trigger/when_to_use/kind)透传`,
      skills.length === BUILTIN_SKILLS.length && toggled.enabled === 1 && fieldsOk && after.length === skills.length,
      `before=${skills.length} after=${after.length} fields=${fieldsOk}`);
  }

  {
    const skills = (await J("/skills")).body;
    const skill = skills.find((s) => s.name === "交付自查清单") ?? skills[0];
    const result = (await J(`/skills/${skill.id}/task-test`, { method: "POST" })).body;
    const eventTypes = new Set((result.events ?? []).map((e) => e.type));
    check("SK6", "技能演练接口：启用技能→read_skill 证据→报告交付→待评审",
      result.ok === true &&
      result.task?.status === "review" &&
      result.docs?.some((d) => d.kind === "report" && d.content.includes("read_skill")) &&
      eventTypes.has("tool") &&
      eventTypes.has("delivery") &&
      eventTypes.has("verification") &&
      result.checks?.body_loaded === true,
      `ok=${result.ok} status=${result.task?.status} docs=${result.docs?.length ?? 0} events=${[...eventTypes].join(",")}`);
  }

  // REG1 预设目录：可读非空 + registry 静态无 token + mcp_servers 回吐脱敏（auth_token 不下发前端）
  {
    const reg = (await J("/registry")).body;
    const hasMcp = Array.isArray(reg.mcp) && reg.mcp.length > 0;
    const hasSkills = Array.isArray(reg.skills) && reg.skills.length > 0;
    const noTokenInRegistry = !JSON.stringify(reg).includes("auth_token");
    const s = (await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "regtok", kind: "http", url: "https://x.example/mcp", auth_token: "SECRET123", safety: "network" }) })).body;
    const list = (await J("/mcp-servers")).body;
    const row = list.find((x) => x.id === s.id);
    const sanitized = Boolean(row) && row.has_token === true && row.auth_token === undefined && !JSON.stringify(list).includes("SECRET123");
    await J(`/mcp-servers/${s.id}`, { method: "DELETE" });
    check("REG1", "预设目录可读非空 + registry 无 token + mcp 列表 auth_token 脱敏", hasMcp && hasSkills && noTokenInRegistry && sanitized);
  }

  // UP1 上传来源文档：txt 直读入库为 kind=source、含内容；不支持类型被拒（multipart 走 multer，非 markitdown 路径）
  {
    const fd = new FormData();
    fd.append("file", new Blob(["这是上传的来源文本 UPLOADMARK42，供定向润色。"], { type: "text/plain" }), "src.txt");
    const r = await fetch(`${BASE}/uploads`, { method: "POST", headers: { Cookie: sessionCookie }, body: fd });
    const doc = await r.json().catch(() => ({}));
    const fd2 = new FormData();
    fd2.append("file", new Blob(["MZ..."], { type: "application/octet-stream" }), "evil.exe");
    const bad = await fetch(`${BASE}/uploads`, { method: "POST", headers: { Cookie: sessionCookie }, body: fd2 });
    check("UP1", "上传来源：txt 入库为 source+含内容；不支持类型(.exe)被拒",
      r.ok && doc.kind === "source" && String(doc.content || "").includes("UPLOADMARK42") && !bad.ok,
      `ok=${r.ok} kind=${doc.kind} badRejected=${!bad.ok}`);
  }

  // G2 MCP 容错（坏 URL 测试应报错不卡死）
  {
    const bad = (await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "bad", kind: "http", url: "https://invalid.example.com/mcp" }) })).body;
    const t0 = Date.now();
    const test = await J(`/mcp-servers/${bad.id}/test`, { method: "POST" });
    await J(`/mcp-servers/${bad.id}`, { method: "DELETE" });
    check("G2", "MCP 容错：坏端点测试报错且不悬挂", !test.ok && Date.now() - t0 < 90000, `耗时${Date.now() - t0}ms`);
  }

  // WL1 stdio 命令白名单：任意命令（bash）建档被 400 拒绝；白名单内命令（npx）可入库
  {
    const bad = await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "wl-bad", kind: "stdio", command: "bash", args: "-c id" }) });
    const good = (await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "wl-good", kind: "stdio", command: "npx", args: "-y some-mcp" }) })).body;
    if (good?.id) await J(`/mcp-servers/${good.id}`, { method: "DELETE" });
    check("WL1", "stdio 白名单：bash 建档拒绝（400）+ npx 放行", !bad.ok && Boolean(good?.id), `badErr=${bad.body?.error?.slice(0, 40) ?? "?"}`);
  }

  // G1 MCP 真连接（本地 stdio everything server；未安装则跳过）
  {
    let hasBin = false;
    try {
      execSync("command -v mcp-server-everything", { stdio: "ignore" });
      hasBin = true;
    } catch { /* not installed */ }
    if (!hasBin) {
      check("G1", "MCP 真连接（everything）", "SKIP", "未安装 @modelcontextprotocol/server-everything");
    } else {
      const s = (await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "everything", kind: "stdio", command: "mcp-server-everything", args: "" }) })).body;
      const test = await J(`/mcp-servers/${s.id}/test`, { method: "POST" });
      const { callMcpTool } = await import(join(root, "server/dist/agents/mcp.js"));
      const echo = await callMcpTool("mcp__everything__echo", { message: "回归" });
      await J(`/mcp-servers/${s.id}`, { method: "DELETE" });
      check("G1", "MCP 真连接：注册→列工具→真实调用回包", test.ok && test.body.tools > 0 && echo.includes("回归"),
        `tools=${test.body.tools}`);
    }
  }

  // MD1 markitdown 能力端到端（P1·B；未安装 markitdown-mcp 则跳过）。冷启动较慢，故超时给足。
  {
    let hasBin = false;
    try { execSync("command -v markitdown-mcp", { stdio: "ignore" }); hasBin = true; } catch { /* not installed */ }
    if (!hasBin) {
      check("MD1", "markitdown 文档解析端到端", "SKIP", "未安装 markitdown-mcp（uv tool install markitdown-mcp）");
    } else {
      const { callMcpTool } = await import(join(root, "server/dist/agents/mcp.js"));
      const s = (await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "markitdown", kind: "stdio", command: "markitdown-mcp", args: "", safety: "local" }) })).body;
      const test = await J(`/mcp-servers/${s.id}/test`, { method: "POST" });
      const sample = join(testDataDir, "md1-sample.html");
      writeFileSync(sample, "<html><body><h1>季度报告</h1><p>营收 <b>1200万</b></p></body></html>");
      const out = await callMcpTool("mcp__markitdown__convert_to_markdown", { uri: "file://" + sample });
      const taskTest = (await J(`/mcp-servers/${s.id}/task-test`, { method: "POST" })).body;
      const taskEventTypes = new Set((taskTest.events ?? []).map((e) => e.type));
      await J(`/mcp-servers/${s.id}`, { method: "DELETE" });
      check("MD1", "markitdown 端到端：注册→列工具→convert_to_markdown 转出 Markdown",
        test.ok && test.body.tools > 0 && out.includes("# 季度报告") && out.includes("**1200万**"),
        `tools=${test.body.tools}`);
      check("MD2", "MCP 能力演练：markitdown 连接→工具事件→来源文档→验收待评审",
        taskTest.ok === true &&
        taskTest.task?.status === "review" &&
        taskTest.docs?.some((d) => d.kind === "source" && d.content.includes("AiTeam MCP 演练")) &&
        taskEventTypes.has("tool") &&
        taskEventTypes.has("delivery") &&
        taskEventTypes.has("verification"),
        `ok=${taskTest.ok} status=${taskTest.task?.status} docs=${taskTest.docs?.length ?? 0} events=${[...taskEventTypes].join(",")}`);
    }
  }

  // Q1 真 .pptx 导出（slides → 可编辑 pptx，zip 头校验）
  {
    const cookieHdr = { headers: { Cookie: sessionCookie } }; // 二进制/文本端点直接 fetch，需手动带会话 cookie
    const slides = (await J("/documents")).body.find((d) => d.kind === "slides");
    const res = await fetch(`${BASE}/documents/${slides.id}/pptx`, cookieHdr);
    const buf = Buffer.from(await res.arrayBuffer());
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
    const report = (await J("/documents")).body.find((d) => d.kind === "report");
    const rejected = !(await fetch(`${BASE}/documents/${report.id}/pptx`, cookieHdr)).ok;
    check("Q1", "真 .pptx 导出：slides 出合法 zip 包，report 被拒", res.ok && isZip && rejected,
      `${buf.length} bytes`);
  }

  // PTPL-HTTP 上传 .pptx 模板就地改图文（端到端走 HTTP/鉴权/owner）：POST /templates 解析+持久化 → POST /template-export 改文本出 pptx
  {
    const { slidesToPptx } = await import(join(root, "server/dist/pptx.js"));
    const { parseTemplate } = await import(join(root, "server/dist/pptx-template.js"));
    const fixture = await slidesToPptx({
      id: "h", owner_id: "o", channel_id: null, task_id: null, agent_id: null, title: "夹具", kind: "slides",
      version: 1, superseded_by: null, created_at: 0, updated_at: 0,
      content: ["# 封面ECHO", "副标题", "---", "## 第二页FOXTROT", "- 要点"].join("\n"),
    });
    const fd = new FormData();
    fd.append("file", new Blob([fixture]), "brand.pptx");
    const up = await fetch(`${BASE}/templates`, { method: "POST", headers: { Cookie: sessionCookie }, body: fd });
    const doc = await up.json();
    const meta = doc.template_meta ? JSON.parse(doc.template_meta) : { slots: [] };
    const slot = meta.slots?.find((s) => s.text.includes("封面ECHO"));
    // 非 .pptx 应被拒
    const fdBad = new FormData();
    fdBad.append("file", new Blob(["x"]), "a.txt");
    const badRej = !(await fetch(`${BASE}/templates`, { method: "POST", headers: { Cookie: sessionCookie }, body: fdBad })).ok;
    // 就地改文本导出
    let exportOk = false, deltaIn = false;
    if (slot) {
      const exp = await fetch(`${BASE}/documents/${doc.id}/template-export`, {
        method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ edits: [{ slideIdx: slot.slideIdx, shapeIdx: slot.shapeIdx, paraIdx: slot.paraIdx, newText: "封面改GOLF" }] }),
      });
      const out = Buffer.from(await exp.arrayBuffer());
      exportOk = exp.ok && out[0] === 0x50 && out[1] === 0x4b; // PK
      if (exportOk) { const m2 = await parseTemplate(out); deltaIn = !!m2.slots.find((s) => s.text.includes("封面改GOLF")); }
    }
    check("PTPL-HTTP", "上传模板端到端：POST /templates 入库 kind=template+槽位清单+持久化 / 非pptx拒 / template-export 改文本出可用 pptx",
      up.ok && doc.kind === "template" && doc.binary_format === "pptx" && !!doc.original_blob_path && (meta.slots?.length > 0) && !!slot && badRej && exportOk && deltaIn,
      `kind=${doc.kind} 槽=${meta.slots?.length} 非pptx拒=${badRej} 导出=${exportOk} delta=${deltaIn}`);
  }

  // Q2 图像生成供应商配置：key 只存服务端
  {
    const imageEndpoint = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
    const saved = (await J("/image-provider", {
      method: "PUT",
      body: JSON.stringify({ api_key: "img-secret-y", base_url: imageEndpoint, model: "doubao-seedream-5-0-pro-260628" }),
    })).body;
    const got = (await J("/image-provider")).body;
    const dump = JSON.stringify((await J("/bootstrap")).body) + JSON.stringify(got);
    const leak = dump.includes("img-secret-y");
    await J("/image-provider", { method: "PUT", body: JSON.stringify({ api_key: "-" }) }); // 清除
    const offAgain = !(await J("/image-provider")).body.has_key;
    check(
      "Q2",
      "图像生成配置：保存完整端点与 Seedream 5 Pro、读取/清除时 key 永不下发",
      saved.has_key && got.base_url === imageEndpoint && got.model === "doubao-seedream-5-0-pro-260628" && !leak && offAgain,
    );
  }

  // Q3 强通道标志 + 成本估算价格字段全链路
  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归strong",
        api_key: "sk-s",
        default_model: "m-pro",
        is_strong: true,
        price_input_per_million: 1.25,
        price_output_per_million: 4.5,
        price_currency: "cny",
      }),
    })).body;
    const off = (await J(`/providers/${prov.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_strong: false, price_output_per_million: 3.25, price_currency: "USD" }),
    })).body;
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check("Q3", "强通道标志和价格字段：创建/编辑往返",
      prov.is_strong === 1 &&
      prov.price_input_per_million === 1.25 &&
      prov.price_output_per_million === 4.5 &&
      prov.price_currency === "CNY" &&
      off.is_strong === 0 &&
      off.price_input_per_million === 1.25 &&
      off.price_output_per_million === 3.25 &&
      off.price_currency === "USD");
  }

  {
    const model = "fake-hollow-model";
    const isolatedChannel = (await J("/channels", {
      method: "POST",
      body: JSON.stringify({ name: "回归空泛报告隔离频道", agent_ids: [] }),
    })).body;
    const workerBefore = qualityBenchmarkWorkerRequests.filter((request) => request.model === model).length;
    const verifierBefore = qualityBenchmarkVerifierRequests.filter((request) => request.model === model).length;
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归空泛报告供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: model,
        is_strong: true,
      }),
    })).body;
    const result = (await runProviderBenchmark(prov.id, { channel_id: isolatedChannel.id })).body;
    const workerAfter = qualityBenchmarkWorkerRequests.filter((request) => request.model === model).length;
    const verifierAfter = qualityBenchmarkVerifierRequests.filter((request) => request.model === model).length;
    const contractEvents = (result.events ?? []).filter((event) => {
      try {
        const meta = JSON.parse(event.metadata_json || "{}");
        return meta.stage === "document_contract" && meta.result === "revise" && Array.isArray(meta.gaps);
      } catch { return false; }
    });
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    await J(`/channels/${isolatedChannel.id}`, { method: "DELETE" });
    check(
      "Q6D",
      "质量基准机器预检：空泛报告自动返工且不调用强模型复核，最终 fail-closed",
      result.ok === false &&
        result.run_status === "failed" &&
        result.checks?.document_contract === false &&
        workerAfter === workerBefore + 2 &&
        verifierAfter === verifierBefore &&
        contractEvents.length === 2 &&
        result.verdicts?.length === 2 &&
        result.verdicts.every((verdict) => verdict.result === "revise" && verdict.source === "fallback"),
      `run=${result.run_status} contract=${result.checks?.document_contract} worker=${workerBefore}->${workerAfter} verifier=${verifierBefore}->${verifierAfter} contractEvents=${contractEvents.length} verdicts=${result.verdicts?.length}`,
    );
  }

  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({ name: "回归OpenAI兼容", api_key: "sk-local", base_url: fakeOpenAiBase, default_model: "fake-chat-model" }),
    })).body;
    const tested = await J(`/providers/${prov.id}/test`, { method: "POST" });
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check("Q4", "模型供应商测试：OpenAI-compatible Base URL/Key/模型名最小连通验证",
      tested.ok &&
      tested.body.protocol === "openai-compatible" &&
      tested.body.model === "fake-chat-model" &&
      tested.body.sample.includes("AiTeam 模型通道可用"),
      `protocol=${tested.body.protocol} model=${tested.body.model} sample=${tested.body.sample}`);
    check("P1S", "OpenAI 兼容真流式：请求带 stream=true，SSE 分片文本/工具参数被正确拼装",
      fakeOpenAiStreamHits > 0 && tested.body.sample === "AiTeam 模型通道可用：fake-chat-model",
      `streamHits=${fakeOpenAiStreamHits} sample=${tested.body.sample}`);
  }

  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({ name: "回归OpenAI工具循环", api_key: "sk-local", base_url: fakeOpenAiBase, default_model: "fake-chat-model", is_strong: true }),
    })).body;
    const worker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归工具同事",
        emoji: "🧪",
        role: "模型工具循环回归",
        system_prompt: "你是回归测试同事。收到任务后必须使用 write_document 交付，并接受 submit_verdict 验收。",
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    const task = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: "回归-真实通道工具循环",
        description: "用 OpenAI-compatible fake provider 走工具调用并写入交付物。",
        acceptance_criteria: "必须通过 write_document 写入 report 交付物，并进入待评审。",
        assignee_agent_id: worker.id,
      }),
    })).body;
    const delivered = await waitFor(async () => {
      const tasks = (await J("/tasks")).body;
      return tasks.some((t) => t.id === task.id && t.status === "review");
    }, 30000);
    const docs = (await J("/documents")).body.filter((d) => d.task_id === task.id);
    const events = (await J(`/tasks/${task.id}/events`)).body;
    const usage = (await J("/usage")).body;
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    const eventTypes = new Set(events.map((e) => e.type));
    const usageTracked = usage.recent?.some((r) => r.model === "fake-chat-model" && String(r.snippet || "").includes("Fake provider"));
    check("Q5", "模型供应商任务循环：OpenAI-compatible 工具调用→write_document→验收→待评审+用量归因",
      delivered &&
      docs.some((d) => d.kind === "report" && d.content.includes("fake provider used write_document")) &&
      eventTypes.has("tool") &&
      eventTypes.has("delivery") &&
      eventTypes.has("verification") &&
      usageTracked,
      `delivered=${delivered} docs=${docs.length} events=${[...eventTypes].join(",")} usage=${Boolean(usageTracked)}`);
  }

  // HC3L 停止发生在验收 await 期间：即使 verifier 已准备返回 pass，也必须停止交付；
  // worker 收尾后停止标记应已清理，用户重新指派一次即可正常重跑。
  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归验收中停止供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model",
        is_strong: true,
      }),
    })).body;
    const worker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归验收中停止同事",
        emoji: "🛑",
        role: "verification stop regression",
        system_prompt: `你是 ${STOP_DURING_VERIFICATION_MARKER} 回归同事，必须用 write_document 交付。`,
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    const task = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: `回归-${STOP_DURING_VERIFICATION_MARKER}`,
        description: "写入交付物，并在自动验收期间验证停止优先。",
        acceptance_criteria: "停止后不得进入待评审；重新指派一次即可正常重跑。",
        assignee_agent_id: worker.id,
      }),
    })).body;

    const verificationHeld = await waitFor(() => typeof heldStopVerificationResponse === "function", 30000, 25);
    const stopped = verificationHeld
      ? await J(`/tasks/${task.id}/stop`, { method: "POST" })
      : { ok: false, body: {} };
    const releaseVerification = heldStopVerificationResponse;
    heldStopVerificationResponse = null;
    if (releaseVerification) releaseVerification();

    const stoppedAtTodo = await waitFor(async () => {
      const tasks = (await J("/tasks")).body;
      return tasks.some((item) => item.id === task.id && item.status === "todo");
    }, 10000, 25);
    const workerSettled = await waitFor(async () => {
      const team = (await J("/team")).body;
      const member = team.members?.find((item) => item.agent_id === worker.id);
      return member?.state === "idle" && member.queued === 0;
    }, 10000, 25);
    const stoppedEvents = (await J(`/tasks/${task.id}/events`)).body;
    const noFinalDeliveryAfterStop = !stoppedEvents.some(
      (event) => event.type === "delivery" && event.summary.includes("转入待评审"),
    );

    let reassigned = false;
    let reran = false;
    if (stoppedAtTodo && workerSettled) {
      const unassigned = await J(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignee_agent_id: null }),
      });
      const assigned = await J(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignee_agent_id: worker.id }),
      });
      reassigned = unassigned.ok && assigned.ok;
      reran = await waitFor(async () => {
        const tasks = (await J("/tasks")).body;
        return tasks.some((item) => item.id === task.id && item.status === "review");
      }, 30000, 25);
    }
    await J(`/providers/${prov.id}`, { method: "DELETE" });

    check(
      "HC3L",
      "验收期间停止：stop 优先于 verifier pass，worker 收尾清标记后一次重指派即可重跑",
      verificationHeld &&
        stopped.ok &&
        stoppedAtTodo &&
        workerSettled &&
        noFinalDeliveryAfterStop &&
        reassigned &&
        reran,
      `held=${verificationHeld} stopped=${stopped.ok} todo=${stoppedAtTodo} settled=${workerSettled} noFinalDelivery=${noFinalDeliveryAfterStop} reassigned=${reassigned} reran=${reran}`,
    );
  }

  // HC3M 取消后立即恢复待办不能清掉旧 worker 的 stop 标记；
  // 即使验收返回 revise，旧 worker 也不得偷偷进入下一轮，排空后再重指派才允许新运行。
  {
    const workRequestsBefore = cancelReopenWorkRequests;
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归取消立即恢复供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model",
        is_strong: true,
      }),
    })).body;
    const worker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归取消立即恢复同事",
        emoji: "⏹️",
        role: "cancel reopen race regression",
        system_prompt: `你是 ${CANCEL_REOPEN_DURING_VERIFICATION_MARKER} 回归同事，必须用 write_document 交付。`,
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    const task = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: `回归-${CANCEL_REOPEN_DURING_VERIFICATION_MARKER}`,
        description: "验收被挂起时取消，再立即恢复待办，旧 worker 必须先排空。",
        acceptance_criteria: "旧 worker 不得进入第二轮；排空后重新指派才允许重新执行。",
        assignee_agent_id: worker.id,
      }),
    })).body;

    const verificationHeld = await waitFor(
      () =>
        typeof heldCancelReopenVerificationResponse === "function" &&
        cancelReopenWorkRequests === workRequestsBefore + 1,
      30000,
      25,
    );
    const cancelled = verificationHeld
      ? await J(`/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "cancelled" }),
        })
      : { ok: false, body: {} };
    const reopened = cancelled.ok
      ? await J(`/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "todo" }),
        })
      : { ok: false, body: {} };
    const releaseVerification = heldCancelReopenVerificationResponse;
    heldCancelReopenVerificationResponse = null;
    if (releaseVerification) releaseVerification();

    const oldWorkerSettled = await waitFor(async () => {
      const team = (await J("/team")).body;
      const member = team.members?.find((item) => item.agent_id === worker.id);
      return member?.state === "idle" && member.queued === 0;
    }, 10000, 25);
    const afterOldWorker = (await J("/tasks")).body.find((item) => item.id === task.id);
    const eventsAfterOldWorker = (await J(`/tasks/${task.id}/events`)).body;
    const oldWorkerDidNotRetry =
      cancelReopenWorkRequests === workRequestsBefore + 1 &&
      afterOldWorker?.status === "todo" &&
      !eventsAfterOldWorker.some(
        (event) => event.type === "delivery" && event.summary.includes("转入待评审"),
      );

    let reassigned = false;
    let reran = false;
    if (oldWorkerSettled && oldWorkerDidNotRetry) {
      const unassigned = await J(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignee_agent_id: null }),
      });
      const assigned = await J(`/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignee_agent_id: worker.id }),
      });
      reassigned = unassigned.ok && assigned.ok;
      reran = await waitFor(async () => {
        const tasks = (await J("/tasks")).body;
        return (
          tasks.some((item) => item.id === task.id && item.status === "review") &&
          cancelReopenWorkRequests === workRequestsBefore + 2
        );
      }, 30000, 25);
    }
    await J(`/providers/${prov.id}`, { method: "DELETE" });

    check(
      "HC3M",
      "验收中取消后立即恢复：旧 stop 标记保留至 worker 排空，之后一次重指派才启动新运行",
      verificationHeld &&
        cancelled.ok &&
        reopened.ok &&
        oldWorkerSettled &&
        oldWorkerDidNotRetry &&
        reassigned &&
        reran,
      `held=${verificationHeld} cancelled=${cancelled.ok} reopened=${reopened.ok} settled=${oldWorkerSettled} oldRuns=${cancelReopenWorkRequests - workRequestsBefore} oldDidNotRetry=${oldWorkerDidNotRetry} reassigned=${reassigned} reran=${reran}`,
    );
  }

  // HC3O 无工具最终响应仍在 await 时改派：旧 worker 不得进入 verification/交付；
  // 原运行排空后必须由新负责人重新执行完整 work 请求。
  {
    const workRequestsBefore = reassignWorkRequests;
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归无工具响应改派供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model",
        is_strong: true,
      }),
    })).body;
    const oldWorker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归改派旧负责人",
        emoji: "1️⃣",
        role: "old worker during final response",
        system_prompt: `你是 ${REASSIGN_DURING_WORK_MARKER} 的旧负责人，必须用 write_document 交付。`,
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    const newWorker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归改派新负责人",
        emoji: "2️⃣",
        role: "new worker after reassignment",
        system_prompt: `你是 ${REASSIGN_DURING_WORK_MARKER} 的新负责人，必须用 write_document 重新执行任务。`,
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    const task = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: `回归-${REASSIGN_DURING_WORK_MARKER}`,
        description: "旧负责人最终无工具响应等待期间改派，新负责人必须重新执行。",
        acceptance_criteria: "旧 worker 不得验收交付；新负责人必须产生第二次 work 请求并进入待评审。",
        assignee_agent_id: oldWorker.id,
      }),
    })).body;

    const workHeld = await waitFor(
      () =>
        typeof heldReassignWorkResponse === "function" &&
        reassignWorkRequests === workRequestsBefore + 1,
      30000,
      25,
    );
    const reassigned = workHeld
      ? await J(`/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ assignee_agent_id: newWorker.id }),
        })
      : { ok: false, body: {} };
    const releaseWork = heldReassignWorkResponse;
    heldReassignWorkResponse = null;
    if (releaseWork) releaseWork();

    const settled = await waitFor(async () => {
      const tasks = (await J("/tasks")).body;
      const freshTask = tasks.find((item) => item.id === task.id);
      const team = (await J("/team")).body;
      const oldMember = team.members?.find((item) => item.agent_id === oldWorker.id);
      const newMember = team.members?.find((item) => item.agent_id === newWorker.id);
      return (
        freshTask?.status === "review" &&
        oldMember?.state === "idle" &&
        newMember?.state === "idle" &&
        oldMember.queued === 0 &&
        newMember.queued === 0
      );
    }, 30000, 25);
    const freshTask = (await J("/tasks")).body.find((item) => item.id === task.id);
    const events = (await J(`/tasks/${task.id}/events`)).body;
    const handedOff = events.some(
      (event) =>
        event.type === "handoff" &&
        event.summary.includes("旧运行停止并交给新负责人"),
    );
    const newWorkerActuallyRan = reassignWorkRequests === workRequestsBefore + 2;
    await J(`/providers/${prov.id}`, { method: "DELETE" });

    check(
      "HC3O",
      "最终响应期间改派：旧 worker 退出，新负责人重新执行后才允许验收交付",
      workHeld &&
        reassigned.ok &&
        settled &&
        freshTask?.assignee_agent_id === newWorker.id &&
        handedOff &&
        newWorkerActuallyRan,
      `held=${workHeld} reassigned=${reassigned.ok} settled=${settled} assignee=${freshTask?.assignee_agent_id === newWorker.id} handoff=${handedOff} workRuns=${reassignWorkRequests - workRequestsBefore}`,
    );
  }

  // HC3P 一次性授权已消费、MCP 正在重连时 stop：连接完成后必须再次校验执行权，
  // 不得因为授权已消费就继续真实外呼。
  {
    const mcpServer = (await J("/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "network_reconnect_probe",
        kind: "stdio",
        command: process.execPath,
        args: [join(root, "scripts/fixtures/network-probe-mcp.mjs")],
        safety: "network",
        env: {
          AITEAM_NETWORK_PROBE_FILE: networkReconnectProbeFile,
          AITEAM_NETWORK_PROBE_CONNECT_FILE: networkReconnectConnectFile,
          AITEAM_NETWORK_PROBE_CONNECT_DELAY_MS: "700",
        },
      }),
    })).body;
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归network重连停止供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model",
        is_strong: true,
      }),
    })).body;
    const worker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归network重连停止同事",
        emoji: "🔌",
        role: "network reconnect stop regression",
        system_prompt: `你是 ${NETWORK_RECONNECT_MARKER} 回归同事，必须调用 network_reconnect_probe.search。`,
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    enterOwner(ownerFromUserId(testUser.id));
    const source = db.createDocument({
      channel_id: ch.id,
      title: "Network reconnect stop source",
      kind: "source",
      content: `${NETWORK_RECONNECT_MARKER}\n验证授权消费后重连期间 stop 不得外呼。`,
    });
    const task = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: `回归-${NETWORK_RECONNECT_MARKER}`,
        description: "执行一次需审批的公开查询。",
        acceptance_criteria: "重连期间 stop 后真实 MCP 调用数必须为 0。",
        assignee_agent_id: worker.id,
        source_doc_ids: [source.id],
      }),
    })).body;

    let approval = null;
    const firstBlocked = await waitFor(async () => {
      const boot = (await J("/bootstrap")).body;
      const freshTask = boot.tasks?.find((item) => item.id === task.id);
      approval = boot.approvals?.find(
        (item) => item.ref_id === task.id && item.kind === "network" && item.status === "pending",
      ) ?? null;
      return (
        freshTask?.status === "blocked" &&
        Boolean(approval) &&
        lineCount(networkReconnectConnectFile) >= 1
      );
    }, 30000, 25);
    const resolved = approval
      ? await J(`/approvals/${approval.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ approve: true }),
        })
      : { ok: false, body: {} };
    const approvedCallHeld = await waitFor(
      () => typeof heldNetworkReconnectResponse === "function",
      30000,
      25,
    );
    const disabled = approvedCallHeld
      ? await J(`/mcp-servers/${mcpServer.id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ enabled: false }),
        })
      : { ok: false, body: {} };
    const enabled = disabled.ok
      ? await J(`/mcp-servers/${mcpServer.id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ enabled: true }),
        })
      : { ok: false, body: {} };
    const connectsBeforeReconnect = lineCount(networkReconnectConnectFile);
    const releaseApprovedCall = heldNetworkReconnectResponse;
    heldNetworkReconnectResponse = null;
    if (releaseApprovedCall) releaseApprovedCall();

    const reconnectStarted = await waitFor(
      () => lineCount(networkReconnectConnectFile) > connectsBeforeReconnect,
      10000,
      10,
    );
    const consumedBeforeStop = Boolean(approval && db.getApproval(approval.id)?.consumed_at);
    const stopped = reconnectStarted
      ? await J(`/tasks/${task.id}/stop`, { method: "POST" })
      : { ok: false, body: {} };
    const settled = await waitFor(async () => {
      const tasks = (await J("/tasks")).body;
      const freshTask = tasks.find((item) => item.id === task.id);
      const team = (await J("/team")).body;
      const member = team.members?.find((item) => item.agent_id === worker.id);
      return freshTask?.status === "todo" && member?.state === "idle" && member.queued === 0;
    }, 15000, 25);
    const callsAfterStop = lineCount(networkReconnectProbeFile);
    await J(`/mcp-servers/${mcpServer.id}`, { method: "DELETE" });
    await J(`/providers/${prov.id}`, { method: "DELETE" });

    check(
      "HC3P",
      "network MCP 重连撤销：grant 已消费后 stop 仍能阻止真实 callTool 外呼",
      firstBlocked &&
        resolved.ok &&
        approvedCallHeld &&
        disabled.ok &&
        enabled.ok &&
        reconnectStarted &&
        consumedBeforeStop &&
        stopped.ok &&
        settled &&
        callsAfterStop === 0,
      `blocked=${firstBlocked} resolved=${resolved.ok} held=${approvedCallHeld} toggled=${disabled.ok}/${enabled.ok} reconnect=${reconnectStarted} consumed=${consumedBeforeStop} stopped=${stopped.ok} settled=${settled} calls=${callsAfterStop}`,
    );
  }

  // HC3J 真链路：来源任务先阻塞，批准后只外呼一次；再次运行需重新审批，停止后不得外呼
  {
    const mcpServer = (await J("/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "network_probe",
        kind: "stdio",
        command: process.execPath,
        args: [join(root, "scripts/fixtures/network-probe-mcp.mjs")],
        safety: "network",
        env: { AITEAM_NETWORK_PROBE_FILE: networkProbeFile },
      }),
    })).body;
    const mcpTest = await J(`/mcp-servers/${mcpServer.id}/test`, { method: "POST" });
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归network审批真链路",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model",
        is_strong: true,
      }),
    })).body;
    const worker = (await J("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "回归network审批同事",
        emoji: "🌐",
        role: "network approval E2E",
        system_prompt: `你是 ${NETWORK_APPROVAL_MARKER} 回归同事，必须先调用 network_probe.search，再用 write_document 交付。`,
        provider_id: prov.id,
        model: "fake-chat-model",
      }),
    })).body;
    enterOwner(ownerFromUserId(testUser.id));
    const source = db.createDocument({
      channel_id: ch.id,
      title: "Network approval E2E source",
      kind: "source",
      content: `${NETWORK_APPROVAL_MARKER}\n仅用于验证来源任务不会静默外发。`,
    });
    db.db.pragma("wal_checkpoint(FULL)");
    const task = (await J("/tasks", {
      method: "POST",
      body: JSON.stringify({
        channel_id: ch.id,
        title: `回归-${NETWORK_APPROVAL_MARKER}`,
        description: "先执行指定公开查询，再写入一份报告。",
        acceptance_criteria: "批准前不得外呼；批准后只外呼一次并进入待评审。",
        assignee_agent_id: worker.id,
        source_doc_ids: [source.id],
      }),
    })).body;

    let firstApproval = null;
    const firstBlocked = await waitFor(async () => {
      const boot = (await J("/bootstrap")).body;
      const freshTask = boot.tasks?.find((item) => item.id === task.id);
      firstApproval = boot.approvals?.find(
        (approval) => approval.ref_id === task.id && approval.kind === "network" && approval.status === "pending",
      ) ?? null;
      return freshTask?.status === "blocked" && Boolean(firstApproval);
    }, 15000, 25);
    const beforeApprovalCalls = networkProbeCalls();
    const firstResolved = firstApproval
      ? await J(`/approvals/${firstApproval.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ approve: true }),
        })
      : { ok: false, body: {} };
    const delivered = await waitFor(async () => {
      const tasks = (await J("/tasks")).body;
      return tasks.some((item) => item.id === task.id && item.status === "review");
    }, 30000, 50);
    const afterApprovalCalls = networkProbeCalls();
    const firstStoredApproval = firstApproval
      ? (await J("/bootstrap")).body.approvals?.find((approval) => approval.id === firstApproval.id)
      : null;
    const repeatedResolve = firstApproval
      ? await J(`/approvals/${firstApproval.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ approve: true }),
        })
      : { ok: false, body: {} };
    await sleep(150);
    const afterRepeatedResolveCalls = networkProbeCalls();

    const revised = await J(`/tasks/${task.id}/revise`, {
      method: "POST",
      body: JSON.stringify({ reason: "验证一次性授权不能在下一轮返工复用" }),
    });
    let secondApproval = null;
    const secondBlocked = await waitFor(async () => {
      const boot = (await J("/bootstrap")).body;
      const freshTask = boot.tasks?.find((item) => item.id === task.id);
      secondApproval = boot.approvals?.find(
        (approval) =>
          approval.ref_id === task.id &&
          approval.kind === "network" &&
          approval.status === "pending" &&
          approval.id !== firstApproval?.id,
      ) ?? null;
      return freshTask?.status === "blocked" && Boolean(secondApproval);
    }, 15000, 25);
    const beforeStopCalls = networkProbeCalls();
    const secondResolved = secondApproval
      ? await J(`/approvals/${secondApproval.id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ approve: true }),
        })
      : { ok: false, body: {} };
    const stopped = await J(`/tasks/${task.id}/stop`, { method: "POST" });
    const stoppedAtTodo = await waitFor(async () => {
      const boot = (await J("/bootstrap")).body;
      const freshTask = boot.tasks?.find((item) => item.id === task.id);
      const pendingNetworkApproval = boot.approvals?.some(
        (approval) =>
          approval.ref_id === task.id &&
          approval.kind === "network" &&
          approval.status === "pending",
      );
      const team = (await J("/team")).body;
      const member = team.members?.find((item) => item.agent_id === worker.id);
      return (
        freshTask?.status === "todo" &&
        !pendingNetworkApproval &&
        member?.state === "idle" &&
        member.queued === 0
      );
    }, 10000, 25);
    const afterStopCalls = networkProbeCalls();
    const secondStoredApproval = secondApproval
      ? (await J("/bootstrap")).body.approvals?.find((approval) => approval.id === secondApproval.id)
      : null;
    const docs = (await J("/documents")).body.filter((doc) => doc.task_id === task.id);

    check(
      "HC3J",
      "network MCP 真链路：批准前零外呼、批准后精确一次、返工需重批、停止后不再外呼",
      mcpTest.ok &&
        mcpTest.body.tools === 1 &&
        firstBlocked &&
        beforeApprovalCalls.length === 0 &&
        firstResolved.ok &&
        delivered &&
        afterApprovalCalls.length === 1 &&
        afterApprovalCalls[0]?.query === "公开资料：AiTeam scoped approval" &&
        afterApprovalCalls[0]?.limit === 2 &&
        Boolean(firstStoredApproval?.consumed_at) &&
        repeatedResolve.ok &&
        afterRepeatedResolveCalls.length === 1 &&
        revised.ok &&
        secondBlocked &&
        beforeStopCalls.length === 1 &&
        secondResolved.ok &&
        stopped.ok &&
        stoppedAtTodo &&
        afterStopCalls.length === 1 &&
        Boolean(secondStoredApproval?.consumed_at) &&
        docs.some((doc) => doc.kind === "report" && doc.content.includes(NETWORK_APPROVAL_MARKER)),
      `mcp=${mcpTest.ok}/${mcpTest.body.tools} blocked=${firstBlocked}/${secondBlocked} calls=${beforeApprovalCalls.length}->${afterApprovalCalls.length}->${afterRepeatedResolveCalls.length}->${afterStopCalls.length} delivered=${delivered} stop=${stoppedAtTodo} consumed=${Boolean(firstStoredApproval?.consumed_at)}/${Boolean(secondStoredApproval?.consumed_at)}`,
    );

    await J(`/mcp-servers/${mcpServer.id}`, { method: "DELETE" });
    await J(`/providers/${prov.id}`, { method: "DELETE" });
  }

  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归任务演练供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model",
        is_strong: true,
        price_input_per_million: 1,
        price_output_per_million: 2,
        price_currency: "USD",
      }),
    })).body;
    const preflight = await J(`/providers/${prov.id}/task-test/plan`);
    const taskCountBeforeRejectedRun = (await J("/tasks")).body.length;
    const rejectedWithoutBudgetConfirmation = await J(`/providers/${prov.id}/task-test`, { method: "POST" });
    const taskCountAfterRejectedRun = (await J("/tasks")).body.length;
    const result = (await runProviderBenchmark(prov.id)).body;
    const taskEvents = result.task?.id ? (await J(`/tasks/${result.task.id}/events`)).body : [];
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    const eventTypes = new Set((result.events ?? []).map((e) => e.type));
    const persistedResultEvent = taskEvents.find((e) => {
      try {
        const meta = JSON.parse(e.metadata_json || "{}");
        return meta.provider_task_test === true &&
          typeof meta.latency_ms === "number" &&
          meta.checks?.usage_tracked === true &&
          typeof meta.usage_summary?.billable === "number" &&
          meta.usage_summary.billable > 0 &&
          typeof meta.usage_summary?.estimated_cost === "number" &&
          meta.usage_summary.estimated_cost > 0 &&
          meta.usage_summary.price_currency === "USD";
      } catch {
        return false;
      }
    });
    const benchmark = result.benchmark;
    const workerProbe = qualityBenchmarkWorkerRequests.at(-1);
    const verifierProbe = qualityBenchmarkVerifierRequests.at(-1);
    check(
      "Q6G",
      "真实模型质量基准预算授权：先返回动态模型/预算/金额计划，未精确确认则零调用、零建任务",
      preflight.ok === true &&
        preflight.body.confirmation_version === 1 &&
        preflight.body.models?.worker === "fake-chat-model" &&
        preflight.body.models?.reviewer === "fake-chat-model" &&
        preflight.body.budget_billable === 20_000 &&
        preflight.body.review_reserve_billable === 6_000 &&
        preflight.body.estimated_cost_ceiling === 0.04 &&
        rejectedWithoutBudgetConfirmation.status === 428 &&
        rejectedWithoutBudgetConfirmation.body.code === "PROVIDER_BENCHMARK_BUDGET_CONFIRMATION_REQUIRED" &&
        taskCountAfterRejectedRun === taskCountBeforeRejectedRun,
      `plan=${preflight.status}/${preflight.body.budget_billable}/${preflight.body.review_reserve_billable}/${preflight.body.estimated_cost_ceiling} rejected=${rejectedWithoutBudgetConfirmation.status}/${rejectedWithoutBudgetConfirmation.body.code} tasks=${taskCountBeforeRejectedRun}->${taskCountAfterRejectedRun}`,
    );
    const rubricItems = result.task?.acceptance_criteria
      ?.split("\n")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
    check("Q6", "模型供应商质量基准：轻量产出→独立强模型复核→预算内交付→用量归因",
      result.ok === true &&
      result.run_status === "passed" &&
      result.task?.status === "review" &&
      benchmark?.id === "executive-decision-brief-v1" &&
      benchmark?.version === 6 &&
      benchmark?.worker_model === "fake-chat-model" &&
      benchmark?.reviewer_model === "fake-chat-model" &&
      benchmark?.budget_billable === 20000 &&
      Array.isArray(benchmark?.rubric) && benchmark.rubric.length === 7 &&
      rubricItems.length === 7 &&
      result.task?.reviewer_agent_id &&
      result.task.reviewer_agent_id !== result.task.assignee_agent_id &&
      result.task.budget_billable === 20000 &&
      result.docs?.some((d) => d.kind === "report" && d.content.includes("AiTeam 14 天产品落地决策简报")) &&
      eventTypes.has("tool") &&
      eventTypes.has("delivery") &&
      eventTypes.has("verification") &&
      result.checks?.usage_tracked === true &&
      result.checks?.quality_contract === true &&
      result.checks?.document_contract === true &&
      result.checks?.independent_reviewer === true &&
      result.checks?.verdict_recorded === true &&
      result.checks?.within_budget === true &&
      result.checks?.source_trace_clean === true &&
      result.checks?.pending_approval === false &&
      workerProbe?.tools.length === 1 && workerProbe.tools[0] === "write_document" &&
      !workerProbe.messages.includes("频道任务看板") &&
      !workerProbe.messages.includes("已启用的技能") &&
      verifierProbe?.tools.length === 1 && verifierProbe.tools[0] === "submit_verdict" &&
      !verifierProbe.messages.includes("频道任务看板") &&
      !verifierProbe.messages.includes("已启用的技能") &&
      Array.isArray(result.verdicts) && result.verdicts.at(-1)?.result === "pass" &&
      result.usage_summary?.estimated_cost > 0 &&
      Boolean(persistedResultEvent),
      `ok=${result.ok}/${result.run_status} benchmark=${benchmark?.id}@${benchmark?.version} rubric=${rubricItems.length} reviewer=${result.task?.reviewer_agent_id} docs=${result.docs?.length ?? 0} events=${[...eventTypes].join(",")} quality=${result.checks?.quality_contract}/${result.checks?.independent_reviewer}/${result.checks?.verdict_recorded}/${result.checks?.within_budget}/${result.checks?.source_trace_clean} isolated=${workerProbe?.tools?.join(",")}/${verifierProbe?.tools?.join(",")} usage=${result.checks?.usage_tracked} billable=${result.usage_summary?.billable} cost=${result.usage_summary?.estimated_cost} persisted=${Boolean(persistedResultEvent)}`);

    const missingAudit = await J(`/tasks/${result.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    const partialAudit = await J(`/tasks/${result.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        human_audit: {
          decision_useful: true,
          evidence_traceable: true,
          no_fabrication: true,
          workflow_actionable: false,
          no_padding: true,
          note: "证据充分，可以进入首批测试。",
        },
      }),
    });
    enterOwner(ownerFromUserId(testUser.id));
    const newerUnreviewedDoc = db.createDocument({
      channel_id: result.task.channel_id,
      task_id: result.task.id,
      agent_id: result.task.assignee_agent_id,
      title: "AiTeam 14 天产品落地决策简报（未复核新版）",
      content: benchmarkGoodReport,
      kind: "report",
    });
    const auditNote = "证据完整且行动与停止条件明确，同意进入首批真实用户测试。";
    const fullAuditPayload = {
      decision_useful: true,
      evidence_traceable: true,
      no_fabrication: true,
      workflow_actionable: true,
      no_padding: true,
      note: auditNote,
    };
    const staleVerdictAudit = await J(`/tasks/${result.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done", human_audit: fullAuditPayload }),
    });
    const currentDocVerdict = db.createVerdict({
      task_id: result.task.id,
      project_id: result.task.project_id,
      doc_id: newerUnreviewedDoc.id,
      verifier_agent_id: result.task.reviewer_agent_id,
      worker_agent_id: result.task.assignee_agent_id,
      attempt: 1,
      result: "pass",
      reasons: "当前文档版本逐项复核通过",
      source: "auto",
    });
    const completedAudit = await J(`/tasks/${result.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        human_audit: fullAuditPayload,
      }),
    });
    const closeEvents = (await J(`/tasks/${result.task.id}/events`)).body.filter((event) => event.type === "user_close");
    const closeMeta = (() => {
      try { return JSON.parse(closeEvents.at(-1)?.metadata_json || "{}"); } catch { return {}; }
    })();
    check(
      "Q6H",
      "真实模型质量基准人工关单：禁止 override，强制五项审计+决策说明并绑定当前文档/verdict",
      missingAudit.ok === false && missingAudit.body.code === "BENCHMARK_HUMAN_AUDIT_REQUIRED" &&
        partialAudit.ok === false && partialAudit.body.gaps?.some((gap) => gap.includes("workflow_actionable")) &&
        staleVerdictAudit.ok === false && staleVerdictAudit.body.gaps?.some((gap) => gap.includes("未绑定当前文档版本")) &&
        completedAudit.ok === true && completedAudit.body.status === "done" &&
        closeEvents.length === 1 &&
        closeMeta.human_override === false &&
        closeMeta.human_audit?.version === 1 &&
        closeMeta.human_audit?.note === auditNote &&
        closeMeta.human_audit?.machine_contract_passed === true &&
        closeMeta.human_audit?.document_id === newerUnreviewedDoc.id &&
        closeMeta.human_audit?.verdict_id === currentDocVerdict.id &&
        currentDocVerdict.doc_id === newerUnreviewedDoc.id,
      `missing=${missingAudit.status}/${missingAudit.body.code} partial=${partialAudit.status}/${partialAudit.body.gaps?.length} stale=${staleVerdictAudit.status}/${staleVerdictAudit.body.gaps?.length} completed=${completedAudit.status}/${completedAudit.body.status} close=${closeEvents.length}/${closeMeta.human_audit?.version}/${closeMeta.human_override}`,
    );
  }

  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: `回归模型角色复用碰撞-${"超长供应商名称".repeat(8)}`,
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-chat-model-collision-a",
        is_strong: true,
      }),
    })).body;
    const first = (await runProviderBenchmark(prov.id)).body;
    await J(`/providers/${prov.id}`, {
      method: "PATCH",
      body: JSON.stringify({ default_model: "fake-chat-model-collision-b" }),
    });
    const second = (await runProviderBenchmark(prov.id)).body;
    const agentsAfter = (await J("/bootstrap")).body.agents ?? [];
    const firstWorker = agentsAfter.find((agent) => agent.id === first.task?.assignee_agent_id);
    const secondWorker = agentsAfter.find((agent) => agent.id === second.task?.assignee_agent_id);
    const firstReviewer = agentsAfter.find((agent) => agent.id === first.task?.reviewer_agent_id);
    const secondReviewer = agentsAfter.find((agent) => agent.id === second.task?.reviewer_agent_id);
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check(
      "Q6A",
      "模型质量基准：截断名称碰撞时仍按 provider、model 与角色隔离执行者和复核者",
      first.ok === true &&
        second.ok === true &&
        firstWorker?.model === "fake-chat-model-collision-a" &&
        secondWorker?.model === "fake-chat-model-collision-b" &&
        firstReviewer?.model === "fake-chat-model-collision-a" &&
        secondReviewer?.model === "fake-chat-model-collision-b" &&
        firstWorker?.role === "真实交付物基准执行" &&
        secondWorker?.role === "真实交付物基准执行" &&
        firstReviewer?.role === "真实交付物独立复核" &&
        secondReviewer?.role === "真实交付物独立复核" &&
        firstWorker.id !== secondWorker.id &&
        firstReviewer.id !== secondReviewer.id,
      `ok=${first.ok}/${second.ok} workers=${firstWorker?.model}/${secondWorker?.model}/${firstWorker?.id === secondWorker?.id} reviewers=${firstReviewer?.model}/${secondReviewer?.model}/${firstReviewer?.id === secondReviewer?.id}`,
    );
  }

  {
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归超预算质量基准供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: "fake-high-usage-model",
        is_strong: true,
      }),
    })).body;
    const result = (await runProviderBenchmark(prov.id)).body;
    const taskEvents = result.task?.id ? (await J(`/tasks/${result.task.id}/events`)).body : [];
    const eventTypes = new Set(taskEvents.map((event) => event.type));
    const pendingBudgetApproval = db.listApprovals().find(
      (approval) => approval.ref_id === result.task?.id && approval.kind === "budget" && approval.status === "pending",
    );
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check(
      "Q6B",
      "质量基准预算触线：保留已生成交付物并标记等待审批，不把暂停误报成模型失败",
      result.ok === false &&
        result.run_status === "pending_approval" &&
        result.task?.status === "blocked" &&
        result.checks?.pending_approval === true &&
        result.checks?.delivered === true &&
        result.pending_approval_id === pendingBudgetApproval?.id &&
        eventTypes.has("blocked") &&
        !eventTypes.has("failure"),
      `ok=${result.ok}/${result.run_status} task=${result.task?.status} delivered=${result.checks?.delivered} approval=${result.pending_approval_id}/${pendingBudgetApproval?.id} events=${[...eventTypes].join(",")}`,
    );
  }

  {
    const model = "fake-near-budget-model";
    const workerBefore = qualityBenchmarkWorkerRequests.filter((request) => request.model === model).length;
    const verifierBefore = qualityBenchmarkVerifierRequests.filter((request) => request.model === model).length;
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "回归复核预算预留供应商",
        api_key: "sk-local",
        base_url: fakeOpenAiBase,
        default_model: model,
        is_strong: true,
      }),
    })).body;
    const result = (await runProviderBenchmark(prov.id)).body;
    const approval = result.pending_approval_id ? db.getApproval(result.pending_approval_id) : null;
    let approvalPayload = {};
    try { approvalPayload = JSON.parse(approval?.payload || "{}"); } catch { approvalPayload = {}; }
    const workerAtPause = qualityBenchmarkWorkerRequests.filter((request) => request.model === model).length;
    const verifierAtPause = qualityBenchmarkVerifierRequests.filter((request) => request.model === model).length;
    const resolved = approval
      ? await J(`/approvals/${approval.id}/resolve`, { method: "POST", body: JSON.stringify({ approve: true }) })
      : { ok: false };
    const completed = result.task?.id
      ? await waitFor(() => db.getTask(result.task.id)?.status === "review", 20000)
      : false;
    const finalTask = result.task?.id ? db.getTask(result.task.id) : null;
    const finalVerdicts = result.task?.id ? db.listVerdictsForTask(result.task.id) : [];
    const finalEvents = result.task?.id ? db.listTaskEvents(result.task.id) : [];
    const workerAfter = qualityBenchmarkWorkerRequests.filter((request) => request.model === model).length;
    const verifierAfter = qualityBenchmarkVerifierRequests.filter((request) => request.model === model).length;
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check(
      "Q6C",
      "质量基准为强模型复核预留预算：不足时先暂停，批准后从复核点续跑且不重复生成初稿",
      result.run_status === "pending_approval" &&
        result.checks?.delivered === true &&
        approvalPayload.resume_phase === "verification" &&
        approvalPayload.review_reserve_billable === 6000 &&
        workerAtPause === workerBefore + 1 &&
        verifierAtPause === verifierBefore &&
        resolved.ok === true &&
        completed === true &&
        finalTask?.status === "review" &&
        workerAfter === workerAtPause &&
        verifierAfter === verifierBefore + 1 &&
        finalVerdicts.at(-1)?.result === "pass" &&
        finalEvents.some((event) => event.type === "approval" && event.summary.includes("从独立复核继续")),
      `initial=${result.run_status} phase=${approvalPayload.resume_phase}/${approvalPayload.review_reserve_billable} worker=${workerBefore}->${workerAtPause}->${workerAfter} verifier=${verifierBefore}->${verifierAtPause}->${verifierAfter} resolved=${resolved.ok} completed=${completed}/${finalTask?.status} verdict=${finalVerdicts.at(-1)?.result}`,
    );
  }

  {
    const started = await J("/link-checks", { method: "POST", body: JSON.stringify({ channel_id: ch.id }) });
    const project = started.body.project;
    const prov = (await J("/providers", {
      method: "POST",
      body: JSON.stringify({ name: "回归链路验收供应商", api_key: "sk-local", base_url: fakeOpenAiBase, default_model: "fake-chat-model", is_strong: true }),
    })).body;
    const providerResult = (await runProviderBenchmark(prov.id, { channel_id: ch.id, project_id: project.id })).body;
    const skills = (await J("/skills")).body;
    const skill = skills.find((s) => s.name === "交付自查清单") ?? skills[0];
    const skillResult = (await J(`/skills/${skill.id}/task-test`, {
      method: "POST",
      body: JSON.stringify({ channel_id: ch.id, project_id: project.id }),
    })).body;
    let mcpResult = null;
    let mcpServer = null;
    try {
      execSync("command -v markitdown-mcp", { stdio: "ignore" });
      mcpServer = (await J("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "markitdown", kind: "stdio", command: "markitdown-mcp", args: "", safety: "local" }),
      })).body;
      mcpResult = (await J(`/mcp-servers/${mcpServer.id}/task-test`, {
        method: "POST",
        body: JSON.stringify({ channel_id: ch.id, project_id: project.id }),
      })).body;
    } catch { /* markitdown-mcp is optional in this combined project check */ }
    const tasksBeforeClose = (await J("/tasks")).body.filter((t) => t.project_id === project.id);
    const allReview = tasksBeforeClose.length >= 2 && tasksBeforeClose.every((t) => t.status === "review");
    const blockedProjectClose = await J(`/projects/${project.id}/close`, { method: "POST" });
    const auditedProviderTask = await J(`/tasks/${providerResult.task.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        human_audit: {
          decision_useful: true,
          evidence_traceable: true,
          no_fabrication: true,
          workflow_actionable: true,
          no_padding: true,
          note: "配置链路证据完整，允许该供应商进入下一阶段验证。",
        },
      }),
    });
    const closed = (await J(`/projects/${project.id}/close`, { method: "POST" })).body;
    const tasksAfterClose = (await J("/tasks")).body.filter((t) => t.project_id === project.id);
    if (mcpServer) await J(`/mcp-servers/${mcpServer.id}`, { method: "DELETE" });
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check("LC1", "配置链路验收项目：模型/MCP/Skills 演练任务归入同项目并可人工关单",
      project?.id &&
      providerResult.ok === true &&
      providerResult.task?.project_id === project.id &&
      skillResult.ok === true &&
      skillResult.task?.project_id === project.id &&
      (!mcpResult || (mcpResult.ok === true && mcpResult.task?.project_id === project.id)) &&
      allReview &&
      blockedProjectClose.ok === false && blockedProjectClose.body.code === "BENCHMARK_HUMAN_AUDIT_REQUIRED" &&
      auditedProviderTask.ok === true && auditedProviderTask.body.status === "done" &&
      closed.project?.status === "done" &&
      tasksAfterClose.length === tasksBeforeClose.length &&
      tasksAfterClose.every((t) => t.status === "done"),
      `project=${project?.id} tasks=${tasksBeforeClose.length} provider=${providerResult.task?.project_id === project.id} skill=${skillResult.task?.project_id === project.id} mcp=${mcpResult ? mcpResult.task?.project_id === project.id : "skip"} blocked=${blockedProjectClose.status}/${blockedProjectClose.body.code} audited=${auditedProviderTask.status}/${auditedProviderTask.body.status} closed=${closed.project?.status}`);
  }

  // 用量 / 导出 / 模板幂等 / 频道管理 / 记忆 / 供应商脱敏
  {
    const usage = (await J("/usage")).body;
    check("U1", "用量：14 天序列 + 活动账本（模型归因）", usage.daily?.length === 14 && Array.isArray(usage.recent));
    const exp = await fetch(`${BASE}/export.md`, { headers: { Cookie: sessionCookie } });
    check("U2", "工作区快照导出", exp.ok && (await exp.text()).includes("# AITeam 工作区快照"));
    const a1 = (await J("/agents/from-template", { method: "POST", body: JSON.stringify({ template_id: "analyst" }) })).body;
    const a2 = (await J("/agents/from-template", { method: "POST", body: JSON.stringify({ template_id: "analyst" }) })).body;
    check("T1", `角色模板：${AGENT_TEMPLATES.length} 个目录 + 实例化幂等`,
      (await J("/agent-templates")).body.length === AGENT_TEMPLATES.length && a1.id === a2.id);
    const nc = (await J("/channels", { method: "POST", body: JSON.stringify({ name: "回归tmp", agent_ids: [] }) })).body;
    const renamed = (await J(`/channels/${nc.id}`, { method: "PATCH", body: JSON.stringify({ name: "回归renamed" }) })).body;
    const deleted = (await J(`/channels/${nc.id}`, { method: "DELETE" })).ok;
    check("CH1", "频道：重命名 + 删除", renamed.name === "回归renamed" && deleted);
    db.appendMemory(pm.id, "[规则] 回归记忆");
    const mem = (await J(`/agents/${pm.id}/memory`)).body;
    const cleared = (await J(`/agents/${pm.id}/memory`, { method: "DELETE" })).ok;
    check("D2", "记忆：写入/读取/清空（沉淀质量待真实 key 观察）", mem.content.includes("回归记忆") && cleared);
    const prov = (await J("/providers", { method: "POST", body: JSON.stringify({ name: "回归prov", api_key: "sk-secret-x", base_url: "https://x.example.com" }) })).body;
    const leak = JSON.stringify((await J("/bootstrap")).body).includes("sk-secret-x");
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check("S1", "安全：API key 永不下发前端", prov.has_key === true && !leak);
  }
} finally {
  server.kill();
  fakeOpenAiServer?.close();
  rmSync(testDataDir, { recursive: true, force: true });
}

console.log("\n——— 回归结果 ———");
const passed = results.filter((r) => r.ok === true).length;
const skipped = results.filter((r) => r.ok === "SKIP").length;
console.log(`通过 ${passed} / 跳过 ${skipped} / 失败 ${failures} （共 ${results.length} 项)`);
process.exit(failures ? 1 : 0);
