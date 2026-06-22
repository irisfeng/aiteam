/**
 * 内置预设目录（registry）——Skill/MCP 一键浏览推荐。
 * 静态常量、编译进 server、不入库、不含任何实例 token、零运行期依赖。
 * MCP 预设只列**真实存在**的包/端点；一键添加仅预填表单 ≠ 开箱可用：
 * stdio 预设需 admin 先在宿主机按 install 指引装好依赖（与另两项目共用主机，注意资源）。
 *
 * 部署红线（腾讯云大陆 VPS / 仅国内模型 / 共用主机）：
 * - 默认只推 runtime_china=yes 的本地/国产项；install_china=degrade 的必须展示大陆镜像命令；
 * - 不预置任何 github.com / 海外 SaaS 强依赖；检索类用智谱 web-search-prime 作国产替代；
 * - safety∈{network,exec} 的预设受引擎审批门约束（见 engine 的 mcpSafetyGate），exec 类默认 P2、不建议共用主机直接启用。
 */
import { BUILTIN_SKILLS } from "./seed.js";

export type Scenario = "office-doc" | "data-viz" | "code-mvp" | "research" | "general";
export type China = "yes" | "degrade" | "no";

export interface McpPreset {
  key: string;
  name: string;
  kind: "http" | "stdio";
  command?: string;
  args?: string[];
  url?: string;
  desc: string;
  scenario: Scenario;
  /** 运行期大陆可达性 */
  runtime_china: China;
  /** 安装期大陆可达性（npx/pip/Chromium 等海外源） */
  install_china: China;
  /** local 无副作用 | network 外发数据 | exec 本地执行/写盘（后两者受引擎审批门约束） */
  safety: "local" | "network" | "exec";
  /** 安装指引（含大陆镜像） */
  install: string;
  /** P0-catalog=一期仅入目录；P1-install=二期实装；P2=高危/沙箱依赖，默认关 */
  phase: "P1-install" | "P1" | "P2";
  /** stdio MCP 需要的环境变量名（如 ["BOCHA_API_KEY"]）——UI 据此提示填写，值存服务端、脱敏 */
  env_keys?: string[];
}

const NPM_MIRROR = "（大陆镜像：先 `npm config set registry https://registry.npmmirror.com`）";
const PIP_MIRROR = "（大陆镜像：加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`）";

export const MCP_REGISTRY: McpPreset[] = [
  {
    key: "markitdown",
    name: "文档转 Markdown",
    kind: "stdio",
    command: "markitdown-mcp",
    args: [],
    desc: "把 PDF / Word(docx) / PPT(pptx) / Excel(xlsx) / 图片 转成 Markdown 供 AI 同事读取处理（微软官方）。配合「文档解析能力」技能(C1)。",
    scenario: "office-doc",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "local",
    install: `pip install markitdown-mcp ${PIP_MIRROR}`,
    phase: "P1-install",
  },
  {
    key: "web-search-prime",
    name: "智谱联网搜索（国产替代）",
    kind: "http",
    url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    desc: "智谱 BigModel 联网搜索 MCP，大陆可达；仅国内模型部署下作主检索路径，替代不可用的官方 web_search。配合「国产联网检索能力」技能(C3)。",
    scenario: "research",
    runtime_china: "yes",
    install_china: "yes",
    safety: "network",
    install: "在智谱开放平台 open.bigmodel.cn 申请 API Key（注意 web_search_prime 属 GLM Coding 套餐能力，需套餐有效），填入 Bearer Token；无需本地安装。",
    phase: "P1",
  },
  {
    key: "bocha",
    name: "博查 AI 搜索（国产）",
    kind: "stdio",
    command: "uvx",
    args: ["--with", "mcp[cli]<1.10", "bocha-search-mcp"],
    desc: "博查 Bocha 国产 AI 网页搜索/语义搜索（bocha_web_search / bocha_ai_search）。读为主、按次计费，需 BOCHA_API_KEY（env 注入）。",
    scenario: "research",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "network",
    env_keys: ["BOCHA_API_KEY"],
    install: `在 open.bochaai.com 申请 API Key；官方包 PyPI \`bocha-search-mcp\`（需 uv / Python≥3.12）。⚠️官方包依赖未封顶、与最新 mcp SDK 不兼容，故用 \`uvx --with "mcp[cli]<1.10" bocha-search-mcp\` 钉旧版规避（社区 npm 包 @humansean/mcp-bocha 当前已损坏，勿用）。大陆可设 UV_DEFAULT_INDEX 镜像。Key 在 UI"环境变量"填 BOCHA_API_KEY。`,
    phase: "P1",
  },
  {
    key: "fetch",
    name: "网页抓取",
    kind: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    desc: "抓取 URL 并转 Markdown（官方 reference server）。research 场景；需 Python uv。",
    scenario: "research",
    runtime_china: "degrade",
    install_china: "degrade",
    safety: "network",
    install: `安装 uv 后 \`uvx mcp-server-fetch\`（或 \`pip install mcp-server-fetch\` ${PIP_MIRROR}）`,
    phase: "P1",
  },
  {
    key: "sequential-thinking",
    name: "结构化思考",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    desc: "给 AI 同事一条显式的多步推理草稿纸（官方 reference server）。通用增强，纯本地无副作用。",
    scenario: "general",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "local",
    install: `\`npx -y @modelcontextprotocol/server-sequential-thinking\` ${NPM_MIRROR}`,
    phase: "P1",
  },
  {
    key: "sqlite",
    name: "本地 SQLite 查询",
    kind: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "./server/data/aiteam.db"],
    desc: "对本地 SQLite 库做查询/分析（官方 reference server）。data-viz 场景。含写操作=高危，受审批门约束。",
    scenario: "data-viz",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "exec",
    install: `安装 uv 后 \`uvx mcp-server-sqlite --db-path <你的库>\`（db-path 指向只读副本更安全）`,
    phase: "P2",
  },
  {
    key: "filesystem",
    name: "本地文件系统",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/scoped/dir"],
    desc: "在指定目录内读写文件（官方 reference server）。code-mvp 场景。可写主机=高危，默认关、受审批门约束、共用主机慎用。",
    scenario: "code-mvp",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "exec",
    install: `\`npx -y @modelcontextprotocol/server-filesystem <限定目录>\` ${NPM_MIRROR}；务必把目录限定到独立沙箱路径`,
    phase: "P2",
  },
  {
    key: "git",
    name: "本地 Git 仓库",
    kind: "stdio",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "/path/to/repo"],
    desc: "读取/操作本地 Git 仓库（官方 reference server）。code-mvp 场景。含写操作=高危，受审批门约束。",
    scenario: "code-mvp",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "exec",
    install: "安装 uv 后 `uvx mcp-server-git --repository <仓库路径>`",
    phase: "P2",
  },
  {
    key: "playwright-qa",
    name: "浏览器自动化 / QA",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    desc: "无头浏览器导航/截图/表单/网页 QA（微软官方）。code-mvp 场景；首装需下载 Chromium(~150MB)。高危(执行+联网)，受审批门约束。",
    scenario: "code-mvp",
    runtime_china: "degrade",
    install_china: "degrade",
    safety: "exec",
    install: `\`npx -y @playwright/mcp@latest\` ${NPM_MIRROR}；Chromium 下载设 \`PLAYWRIGHT_DOWNLOAD_HOST\` 指向镜像`,
    phase: "P2",
  },
  {
    key: "pptx-native",
    name: "可编辑 PPTX · 母版级增强（自托管，可选）",
    kind: "stdio",
    command: "python",
    args: ["-m", "ppt_master"],
    desc: "母版级 DrawingML 高保真 PPTX（社区 ppt-master，本地 Python）。注意：常规演示用内置 slides(Marp→pptx) 一键导出即可，本预设仅为需要母版级保真时的可选自托管增强。本地执行=高危，默认关、不建议共用主机直接启用。",
    scenario: "office-doc",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "exec",
    install: `可选自托管增强（非必需，默认关）：常规演示用内置 slides(Marp→pptx) 一键导出即可；仅当确需母版级保真，再自行获取社区 ppt-master 源码自托管（Python，依赖装清华源 ${PIP_MIRROR}；大陆访问 GitHub 需自备镜像/代理）`,
    phase: "P2",
  },
];

export interface SkillPreset {
  name: string;
  desc: string;
  kind: "method" | "capability";
  when_to_use: string;
  trigger: string;
  builtin: true;
}

/** 内置技能目录视图（从 BUILTIN_SKILLS 派生，供前端"已内置技能"浏览；实际启用走 /skills）。 */
export const SKILL_PACK_REGISTRY: SkillPreset[] = BUILTIN_SKILLS.map((s) => ({
  name: s.name,
  desc: s.desc,
  kind: s.kind,
  when_to_use: s.when_to_use,
  trigger: s.trigger,
  builtin: true,
}));

// ───────────────────────────────────────────────────────────────────────────
// L3 技能模板资源：技能可在 resources_json 里用 `tpl:<id>` 引用；read_skill 时把模板正文附带返回。
// 模板本身必须是合法 html 交付物（内联脚本/样式、无外链 <script src>、无内联事件处理器、无 javascript:），
// 这样 AI 同事照模板产出的 html 交付物能直接通过 validateDocContent。
// ───────────────────────────────────────────────────────────────────────────
export interface SkillTemplate {
  id: string;
  name: string;
  desc: string;
  lang: string;
  content: string;
}

const HTML_DECK_HORIZONTAL = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#0f1115; --ink:#f4f1ea; --dim:#9aa0a6; --accent:#ffd84d; }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;overflow:hidden}
  #stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
  .deck{aspect-ratio:16/9;width:min(100vw,calc(100vh*16/9));height:min(100vh,calc(100vw*9/16));position:relative;overflow:hidden}
  .slide{position:absolute;inset:0;padding:7% 9%;display:flex;flex-direction:column;justify-content:center;gap:.6em;opacity:0;transition:opacity .35s;pointer-events:none}
  .slide.active{opacity:1;pointer-events:auto}
  html:not(.js) .slide:first-of-type{opacity:1;pointer-events:auto}
  h1{font-size:5.2vmin;font-weight:800;letter-spacing:-.01em}
  h2{font-size:3.4vmin;font-weight:700;color:var(--accent)}
  p,li{font-size:2.4vmin;line-height:1.5;color:var(--dim)}
  ul{padding-left:1.2em;display:flex;flex-direction:column;gap:.4em}
  .kicker{font-size:1.8vmin;letter-spacing:.3em;text-transform:uppercase;color:var(--accent)}
  #bar{position:fixed;bottom:2.4vmin;left:50%;transform:translateX(-50%);display:flex;gap:.8vmin}
  .dot{width:1vmin;height:1vmin;border-radius:50%;background:#3a3f47}
  .dot.on{background:var(--accent)}
  #hint{position:fixed;bottom:2vmin;right:2.4vmin;font-size:1.5vmin;color:#5b6068}
</style>
</head>
<body>
<div id="stage"><div class="deck" id="deck">
  <section class="slide"><div class="kicker">封面</div><h1>在此填标题</h1><p>副标题 / 一句话主张</p></section>
  <section class="slide"><h2>要点一</h2><ul><li>用 ← / → 或点击翻页</li><li>每页一个要点群、宁多分页</li></ul></section>
  <section class="slide"><h2>结尾</h2><p>行动建议 / 联系方式</p></section>
</div></div>
<div id="bar"></div><div id="hint">← / → 翻页</div>
<script>
  document.documentElement.classList.add('js');
  const slides=[...document.querySelectorAll('.slide')];
  const bar=document.getElementById('bar');
  let i=0;
  slides.forEach(()=>{const d=document.createElement('div');d.className='dot';bar.appendChild(d);});
  const dots=[...bar.children];
  function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,k)=>s.classList.toggle('active',k===i));dots.forEach((d,k)=>d.classList.toggle('on',k===i));}
  document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1);});
  document.getElementById('deck').addEventListener('click',()=>show(i+1));
  show(0);
</script>
</body>
</html>`;

// 三套移植自 frontend-slides 的风格（CJK 友好、脚本关闭可渲染 scroll-snap、过 validateDocContent）。
const HTML_DECK_BROADSIDE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#0c0d10; --ink:#f5f3ee; --dim:#8b9099; --accent:#e8b53a; --line:#23262d; }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .slide{min-height:100vh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:8vh 9vw;gap:.6em;position:relative}
  .slide+.slide{border-top:1px solid var(--line)}
  .kicker{font-size:.8rem;letter-spacing:.34em;text-transform:uppercase;color:var(--accent)}
  h1{font-size:clamp(2.4rem,7vw,6rem);font-weight:800;line-height:1.02;letter-spacing:-.02em}
  h2{font-size:clamp(1.6rem,4vw,3rem);font-weight:700}
  p,li{font-size:clamp(1rem,1.7vw,1.4rem);line-height:1.55;color:var(--dim);max-width:48ch}
  ul{padding-left:1.1em;display:flex;flex-direction:column;gap:.5em}
  .big{font-size:clamp(3rem,12vw,9rem);font-weight:800;color:var(--accent);line-height:.95}
  .stat-row{display:flex;flex-wrap:wrap;gap:5vw;margin-top:.4em}
  .stat .n{font-size:clamp(2.2rem,6vw,4.5rem);font-weight:800;color:var(--accent)}
  .stat .l{font-size:.95rem;color:var(--dim);letter-spacing:.04em}
  #bar{position:fixed;right:2vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:.7vh;z-index:9}
  .dot{width:.55vh;height:.55vh;border-radius:50%;background:#3a3f47}
  .dot.on{background:var(--accent);transform:scale(1.6)}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
  <section class="slide"><div class="kicker">封面</div><h1>在此填主标题</h1><p>副标题 / 一句话主张</p></section>
  <section class="slide"><div class="kicker">关键指标</div><div class="stat-row">
    <div class="stat"><div class="n">268亿</div><div class="l">市场规模</div></div>
    <div class="stat"><div class="n">↓80%</div><div class="l">人力成本</div></div>
    <div class="stat"><div class="n">3.2×</div><div class="l">效率提升</div></div>
  </div></section>
  <section class="slide"><h2>核心主张</h2><p class="big">一句压舱石</p></section>
  <section class="slide"><h2>要点</h2><ul><li>每页一个观点群</li><li>宁可多分页，别堆密</li></ul></section>
  <section class="slide"><h2>结尾</h2><p>行动建议 / 联系方式</p></section>
</main>
<nav id="bar" aria-hidden="true"></nav>
<script>
  const slides=[...document.querySelectorAll('.slide')];
  const bar=document.getElementById('bar');
  slides.forEach(()=>{const d=document.createElement('div');d.className='dot';bar.appendChild(d);});
  const dots=[...bar.children];
  const io=new IntersectionObserver((es)=>{es.forEach(e=>{if(e.isIntersecting){const i=slides.indexOf(e.target);dots.forEach((d,k)=>d.classList.toggle('on',k===i));}});},{threshold:.6});
  slides.forEach(s=>io.observe(s));
  let cur=0;function go(n){cur=Math.max(0,Math.min(slides.length-1,n));slides[cur].scrollIntoView();}
  document.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowRight'||e.key===' '){go(cur+1);}if(e.key==='ArrowUp'||e.key==='ArrowLeft'){go(cur-1);}});
</script>
</body>
</html>`;

const HTML_DECK_SIGNAL = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#f4f1ea; --ink:#1c1a16; --dim:#6b675e; --accent:#b5471f; --line:#ddd6c8; }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif}
  .slide{min-height:100vh;scroll-snap-align:start;display:grid;grid-template-columns:1fr 1fr;gap:4vw;align-content:center;padding:9vh 8vw;position:relative;background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:26px 26px}
  .full{grid-column:1/-1}
  .num{font-variant-numeric:tabular-nums;font-size:.8rem;letter-spacing:.3em;color:var(--accent)}
  h1{font-family:Georgia,"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(2.4rem,6vw,5rem);font-weight:700;line-height:1.05;letter-spacing:-.01em}
  h2{font-family:Georgia,"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(1.5rem,3.4vw,2.6rem);font-weight:700;color:var(--accent)}
  p,li{font-size:clamp(1rem,1.5vw,1.25rem);line-height:1.6;color:var(--dim)}
  ul{padding-left:1.1em;display:flex;flex-direction:column;gap:.5em}
  .rule{height:3px;width:3.5rem;background:var(--accent);margin:.2em 0 .6em}
  @media(max-width:760px){.slide{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
  <section class="slide"><div class="full"><div class="num">01 — 封面</div><div class="rule"></div><h1>在此填主标题</h1><p>副标题 / 一句话主张</p></div></section>
  <section class="slide"><div><div class="num">02</div><h2>论点</h2><div class="rule"></div><p>左栏放主张，右栏放展开或证据。</p></div>
    <div><ul><li>支撑点一</li><li>支撑点二</li><li>支撑点三</li></ul></div></section>
  <section class="slide"><div class="full"><div class="num">03</div><h2>引述 / 重点</h2><div class="rule"></div><h1>一句金句压版</h1></div></section>
  <section class="slide"><div class="full"><div class="num">04 — 结尾</div><div class="rule"></div><h2>行动建议</h2><p>联系方式 / 下一步</p></div></section>
</main>
<script>
  const slides=[...document.querySelectorAll('.slide')];let cur=0;
  function go(n){cur=Math.max(0,Math.min(slides.length-1,n));slides[cur].scrollIntoView();}
  document.addEventListener('keydown',e=>{if(['ArrowDown','ArrowRight',' '].includes(e.key))go(cur+1);if(['ArrowUp','ArrowLeft'].includes(e.key))go(cur-1);});
</script>
</body>
</html>`;

const HTML_DECK_MONOCHROME = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#ffffff; --ink:#111316; --dim:#6a6f76; --accent:#111316; --line:#e6e8ea; }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif}
  .slide{min-height:100vh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:10vh 9vw;gap:.7em;border-bottom:1px solid var(--line)}
  .tag{font-size:.78rem;letter-spacing:.32em;text-transform:uppercase;color:var(--dim)}
  h1{font-size:clamp(2.2rem,6vw,5rem);font-weight:800;line-height:1.04;letter-spacing:-.02em}
  h2{font-size:clamp(1.4rem,3.4vw,2.4rem);font-weight:700}
  p,li{font-size:clamp(1rem,1.6vw,1.25rem);line-height:1.6;color:var(--dim)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:4vw;margin-top:.4em}
  ul{padding-left:1.1em;display:flex;flex-direction:column;gap:.45em}
  .line{height:2px;width:100%;background:var(--ink);margin:.3em 0}
  @media(max-width:640px){.cols{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
  <section class="slide"><div class="tag">封面</div><div class="line"></div><h1>在此填主标题</h1><p>副标题 / 一句话主张</p></section>
  <section class="slide"><div class="tag">对比</div><h2>两栏并列</h2><div class="cols">
    <div><h2>方案 A</h2><ul><li>优点</li><li>代价</li></ul></div>
    <div><h2>方案 B</h2><ul><li>优点</li><li>代价</li></ul></div></div></section>
  <section class="slide"><div class="tag">主张</div><div class="line"></div><h1>一句压舱石</h1></section>
  <section class="slide"><div class="tag">结尾</div><div class="line"></div><h2>行动建议</h2><p>联系方式 / 下一步</p></section>
</main>
<script>
  const s=[...document.querySelectorAll('.slide')];let c=0;
  const go=n=>{c=Math.max(0,Math.min(s.length-1,n));s[c].scrollIntoView();};
  document.addEventListener('keydown',e=>{if(['ArrowDown','ArrowRight',' '].includes(e.key))go(c+1);if(['ArrowUp','ArrowLeft'].includes(e.key))go(c-1);});
</script>
</body>
</html>`;

export const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    id: "html-deck-horizontal",
    name: "横向翻页网页 PPT（单文件 HTML）",
    desc: "16:9 锁定舞台、← / → 或点击翻页、进度点；瑞士国际主义骨架。脚本关闭也显首页。替换 .slide 内容即用。",
    lang: "html",
    content: HTML_DECK_HORIZONTAL,
  },
  {
    id: "html-deck-broadside",
    name: "满版大字网页 PPT（单文件 HTML）",
    desc: "纵向 scroll-snap、满版大标题与数字大字报、右侧进度点；脚本关闭可滚动浏览全部。深色暖金。",
    lang: "html",
    content: HTML_DECK_BROADSIDE,
  },
  {
    id: "html-deck-signal",
    name: "编辑杂志风网页 PPT（单文件 HTML）",
    desc: "网格点阵底、衬线主标题、双栏论点/证据；窄屏自动单栏；脚本关闭可渲染。米底砖红。",
    lang: "html",
    content: HTML_DECK_SIGNAL,
  },
  {
    id: "html-deck-monochrome",
    name: "极简单色网页 PPT（单文件 HTML）",
    desc: "黑白极简、双栏对比、640px 断点单栏；脚本关闭可滚动浏览。最克制。",
    lang: "html",
    content: HTML_DECK_MONOCHROME,
  },
];

export function getSkillTemplate(id: string): SkillTemplate | undefined {
  return SKILL_TEMPLATES.find((t) => t.id === id);
}
