#!/usr/bin/env node
/**
 * AITeam 自动化回归（机制级，Mock 模式零 token）
 * 覆盖 docs/TESTING.md 中可自动化的用例；智能质量类用例需真实 key 人工执行。
 *
 * 用法：npm run build && node scripts/regression.mjs
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 隔离测试库：所有读写（含 Phase 2 spawn 的子进程，env 继承）落在临时目录，
// 绝不触碰 server/data 生产工作区（那里有用户的密钥配置/项目/文档）。
const testDataDir = mkdtempSync(join(tmpdir(), "aiteam-regress-"));
process.env.AITEAM_DATA_DIR = testDataDir;
const PORT = 8799;
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
const { enterOwner, ownerFromUserId } = await import(join(root, "server/dist/ownerScope.js"));
const { hashPassword } = await import(join(root, "server/dist/password.js"));
const engine = await import(join(root, "server/dist/agents/engine.js"));

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

// DOC-HTML html 交付物：格式 + 防 XSS 校验（外链 script / 内联事件 / javascript: URI 全拒）
{
  const v = engine.validateDocContent;
  const ok =
    v("html", "<section><h1>原型</h1><p>hi</p></section>") === null &&     // 合法
    typeof v("html", "纯文本无标签") === "string" &&                       // 非 HTML 拒
    typeof v("html", '<div></div><script src="//evil/x.js"></script>') === "string" && // 外链 script 拒
    typeof v("html", '<img src=x onerror="alert(1)">') === "string" &&     // 内联事件 拒
    typeof v("html", '<a href="javascript:alert(1)">x</a>') === "string";  // javascript: URI 拒
  check("DOC-HTML", "html 交付物：合法放行 + 外链script/内联事件/js:URI 全拒（防存储型 XSS）", ok);
}

// ---------------------------------------------------------------------------
// Phase 2：拉起服务，走 HTTP API（聊天/引用/文档/技能/MCP/用量/导出/模板/频道）
// ---------------------------------------------------------------------------
const server = spawn("node", [join(root, "server/dist/index.js")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
const up = await waitFor(async () => {
  try {
    const r = await fetch(`${BASE}/auth/me`); // 未登录返回 401（仍表示服务已起）
    return r.status === 401 || r.ok;
  } catch {
    return false;
  }
}, 15000);
check("A1", "服务启动可达", up);

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
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
};

try {
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
    check("AUTH2", "角色门控：member 注册为 member + 被挡在 admin 配置外(403) + 看不到他人频道",
      regBody.role === "member" && forbidden && isolated);
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

  // G2 MCP 容错（坏 URL 测试应报错不卡死）
  {
    const bad = (await J("/mcp-servers", { method: "POST", body: JSON.stringify({ name: "bad", kind: "http", url: "https://invalid.example.com/mcp" }) })).body;
    const t0 = Date.now();
    const test = await J(`/mcp-servers/${bad.id}/test`, { method: "POST" });
    await J(`/mcp-servers/${bad.id}`, { method: "DELETE" });
    check("G2", "MCP 容错：坏端点测试报错且不悬挂", !test.ok && Date.now() - t0 < 90000, `耗时${Date.now() - t0}ms`);
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

  // Q2 图像生成供应商配置：key 只存服务端
  {
    const saved = (await J("/image-provider", { method: "PUT", body: JSON.stringify({ api_key: "img-secret-y", model: "doubao-seedream-5-0-260128" }) })).body;
    const got = (await J("/image-provider")).body;
    const dump = JSON.stringify((await J("/bootstrap")).body) + JSON.stringify(got);
    const leak = dump.includes("img-secret-y");
    await J("/image-provider", { method: "PUT", body: JSON.stringify({ api_key: "-" }) }); // 清除
    const offAgain = !(await J("/image-provider")).body.has_key;
    check("Q2", "图像生成配置：保存/读取/清除，key 永不下发", saved.has_key && got.model.includes("seedream") && !leak && offAgain);
  }

  // Q3 强通道标志 is_strong 全链路
  {
    const prov = (await J("/providers", { method: "POST", body: JSON.stringify({ name: "回归strong", api_key: "sk-s", default_model: "m-pro", is_strong: true }) })).body;
    const off = (await J(`/providers/${prov.id}`, { method: "PATCH", body: JSON.stringify({ is_strong: false }) })).body;
    await J(`/providers/${prov.id}`, { method: "DELETE" });
    check("Q3", "强通道标志：创建/编辑往返", prov.is_strong === 1 && off.is_strong === 0);
  }

  // 用量 / 导出 / 模板幂等 / 频道管理 / 记忆 / 供应商脱敏
  {
    const usage = (await J("/usage")).body;
    check("U1", "用量：14 天序列 + 活动账本（模型归因）", usage.daily?.length === 14 && Array.isArray(usage.recent));
    const exp = await fetch(`${BASE}/export.md`, { headers: { Cookie: sessionCookie } });
    check("U2", "工作区快照导出", exp.ok && (await exp.text()).includes("# AITeam 工作区快照"));
    const a1 = (await J("/agents/from-template", { method: "POST", body: JSON.stringify({ template_id: "analyst" }) })).body;
    const a2 = (await J("/agents/from-template", { method: "POST", body: JSON.stringify({ template_id: "analyst" }) })).body;
    check("T1", "角色模板：12 个目录 + 实例化幂等",
      (await J("/agent-templates")).body.length === 12 && a1.id === a2.id);
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
  rmSync(testDataDir, { recursive: true, force: true });
}

console.log("\n——— 回归结果 ———");
const passed = results.filter((r) => r.ok === true).length;
const skipped = results.filter((r) => r.ok === "SKIP").length;
console.log(`通过 ${passed} / 跳过 ${skipped} / 失败 ${failures} （共 ${results.length} 项)`);
process.exit(failures ? 1 : 0);
