/**
 * 内置预设目录（registry）——Skill/MCP 一键浏览推荐。
 * 静态常量、编译进 server、不入库、不含任何实例 token、零运行期依赖。
 * MCP 预设只列**真实存在**的包/端点；一键添加仅预填表单 ≠ 开箱可用：
 * 开发 stdio 预设需 admin 在宿主机按 install 指引装好依赖；生产 stdio
 * 必须改用已预载、digest 固定的 rootless Podman 镜像，不能复用宿主安装。
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
    install: `开发：pip install markitdown-mcp ${PIP_MIRROR}；生产：运行 npm run mcp:image:markitdown:build，并填入证据输出的 image@sha256 digest`,
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

// 精装设计模板（验收过的对外演示风格；按需经『演示风格选择法』选用，read_skill 单取一套，避免一次性灌全部）。
const HTML_DECK_NAVY_GOLD = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>商务藏蓝金 · 演示模板</title>
<style>
  :root{
    --navy:#10254a;
    --navy-2:#1b376b;
    --gold:#b08524;
    --gold-soft:#c79a3a;
    --ink:#16202f;
    --dim:#5a6678;
    --paper:#ffffff;
    --mist:#f4f6fa;
    --line:#d9dfe9;
    --line-strong:#b9c2d4;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{
    background:var(--paper);color:var(--ink);
    font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  .slide{
    min-height:100vh;scroll-snap-align:start;position:relative;
    padding:9vh 8vw 11vh;display:flex;flex-direction:column;justify-content:center;
    border-bottom:1px solid var(--line);overflow:hidden;
  }
  .slide::before{
    content:attr(data-org);position:absolute;top:4.4vh;left:8vw;right:8vw;
    display:flex;justify-content:space-between;
    font-size:.72rem;letter-spacing:.16em;color:var(--dim);
    border-bottom:1px solid var(--line);padding-bottom:1.4vh;
    text-transform:uppercase;
  }
  .pageno{position:absolute;top:4.4vh;right:8vw;font-variant-numeric:tabular-nums;color:var(--gold);font-weight:600;letter-spacing:.12em}

  .kicker{font-size:.78rem;letter-spacing:.34em;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:.9em;display:inline-flex;align-items:center;gap:.7em}
  .kicker::before{content:"";width:2.2rem;height:2px;background:var(--gold)}
  h1{font-size:clamp(2.3rem,5.4vw,4.4rem);font-weight:800;line-height:1.08;letter-spacing:-.015em;color:var(--navy);max-width:18ch}
  h2{font-size:clamp(1.55rem,3.3vw,2.6rem);font-weight:750;line-height:1.15;letter-spacing:-.01em;color:var(--navy)}
  h3{font-size:clamp(1.05rem,1.8vw,1.35rem);font-weight:700;color:var(--navy-2)}
  p{font-size:clamp(1rem,1.5vw,1.22rem);line-height:1.7;color:var(--dim);max-width:46ch}
  .lead{font-size:clamp(1.1rem,1.9vw,1.5rem);color:var(--ink);max-width:42ch;line-height:1.6}
  strong{color:var(--navy);font-weight:750}
  .muted{color:var(--dim)}

  .cover{background:linear-gradient(180deg,#0c2046 0%,var(--navy) 60%,var(--navy-2) 100%);color:#fff}
  .cover::before{color:rgba(255,255,255,.55);border-bottom-color:rgba(255,255,255,.18)}
  .cover .pageno{color:var(--gold-soft)}
  .cover h1{color:#fff;max-width:20ch}
  .cover .kicker{color:var(--gold-soft)}
  .cover .kicker::before{background:var(--gold-soft)}
  .cover p{color:rgba(255,255,255,.78)}
  .cover .meta{margin-top:3.2vh;display:flex;flex-wrap:wrap;gap:2.6em;font-size:.86rem;letter-spacing:.06em;color:rgba(255,255,255,.72)}
  .cover .meta b{display:block;color:#fff;font-size:1.02rem;font-weight:650;margin-top:.25em;letter-spacing:0}
  .cover .seal{position:absolute;right:8vw;bottom:9vh;width:clamp(120px,16vw,210px);height:clamp(120px,16vw,210px);opacity:.9}

  .chapter{background:var(--navy);color:#fff;justify-content:flex-end}
  .chapter::before{color:rgba(255,255,255,.5);border-bottom-color:rgba(255,255,255,.16)}
  .chapter .pageno{color:var(--gold-soft)}
  .chapter .big-no{font-size:clamp(5rem,18vw,15rem);font-weight:800;line-height:.8;color:rgba(255,255,255,.08);position:absolute;top:18vh;left:7vw;letter-spacing:-.04em}
  .chapter h2{color:#fff;font-size:clamp(2rem,5vw,3.8rem);max-width:20ch;position:relative}
  .chapter .kicker{color:var(--gold-soft)}.chapter .kicker::before{background:var(--gold-soft)}
  .chapter .toc{margin-top:2.4vh;display:flex;flex-direction:column;gap:.55em;color:rgba(255,255,255,.55);font-size:.95rem;max-width:30ch}
  .chapter .toc .on{color:#fff;font-weight:650}
  .chapter .toc span:first-child{color:var(--gold-soft);font-variant-numeric:tabular-nums;margin-right:.9em}

  .bullets{display:grid;grid-template-columns:repeat(2,1fr);gap:1.4em 3.2em;margin-top:2.4vh;list-style:none}
  .bullets li{display:grid;grid-template-columns:auto 1fr;gap:1em;align-items:start;padding-bottom:1.2em;border-bottom:1px solid var(--line)}
  .bullets .ix{font-variant-numeric:tabular-nums;font-weight:800;color:var(--gold);font-size:1.05rem;line-height:1.5;min-width:1.6em}
  .bullets b{display:block;color:var(--navy);font-size:1.1rem;font-weight:700;margin-bottom:.25em;letter-spacing:0}
  .bullets p{font-size:.98rem;line-height:1.55;max-width:34ch}

  .metrics{display:grid;grid-template-columns:repeat(4,1fr);margin-top:3vh;border-top:2px solid var(--navy)}
  .metric{padding:2.4vh 1.6em 2.4vh 0;border-right:1px solid var(--line)}
  .metric:last-child{border-right:none}
  .metric .n{font-size:clamp(2.6rem,6vw,4.6rem);font-weight:800;color:var(--navy);line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .metric .n em{font-style:normal;color:var(--gold);font-size:.5em;font-weight:700;margin-left:.12em}
  .metric .l{margin-top:.7em;font-size:.92rem;color:var(--dim);line-height:1.4;max-width:18ch}
  .metric .src{margin-top:.5em;font-size:.72rem;color:var(--line-strong);letter-spacing:.02em}

  .compare{display:grid;grid-template-columns:1fr 1fr;gap:2.4em;margin-top:3vh}
  .card{border:1px solid var(--line);border-top:3px solid var(--line-strong);padding:2.6vh 2em 3vh;background:var(--mist)}
  .card.hi{border-top-color:var(--gold);background:#fff;box-shadow:0 1px 0 var(--line),0 18px 40px -28px rgba(16,37,74,.4)}
  .card .tag{font-size:.74rem;letter-spacing:.22em;text-transform:uppercase;color:var(--dim);font-weight:700}
  .card.hi .tag{color:var(--gold)}
  .card h3{margin:.5em 0 1em;font-size:1.35rem}
  .card ul{list-style:none;display:flex;flex-direction:column;gap:.7em}
  .card li{display:grid;grid-template-columns:1.2em 1fr;gap:.6em;font-size:.98rem;color:var(--ink);line-height:1.5}
  .card li::before{content:"\\2014";color:var(--line-strong);font-weight:700}
  .card.hi li::before{content:"\\2713";color:var(--gold);font-weight:800}

  .roadmap{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:4vh;position:relative}
  .roadmap::before{content:"";position:absolute;top:.55rem;left:0;right:0;height:2px;background:var(--line);z-index:0}
  .phase{position:relative;padding-right:1.6em;z-index:1}
  .phase .node{width:1.1rem;height:1.1rem;border-radius:50%;background:#fff;border:3px solid var(--line-strong);margin-bottom:1.4em}
  .phase.done .node{border-color:var(--gold);background:var(--gold)}
  .phase.now .node{border-color:var(--navy);background:#fff;box-shadow:0 0 0 4px rgba(16,37,74,.12)}
  .phase .when{font-size:.74rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);font-weight:700}
  .phase h3{margin:.4em 0 .5em;font-size:1.1rem}
  .phase p{font-size:.9rem;line-height:1.5;max-width:22ch}

  .quote-slide{background:var(--mist)}
  blockquote{position:relative;max-width:24ch;margin:0 auto}
  blockquote .mark{font-family:Georgia,"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(6rem,16vw,12rem);color:var(--gold);line-height:.6;opacity:.32;position:absolute;top:-.1em;left:-.5em}
  blockquote q{display:block;quotes:none;font-family:Georgia,"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(1.8rem,4.4vw,3.4rem);font-weight:600;line-height:1.3;color:var(--navy);letter-spacing:-.01em;position:relative}
  blockquote q::before,blockquote q::after{content:""}
  blockquote cite{display:block;margin-top:1.6em;font-style:normal;font-size:.98rem;color:var(--dim);letter-spacing:.04em}
  blockquote cite b{color:var(--navy);font-weight:700}

  .cta{background:linear-gradient(135deg,var(--navy) 0%,#0c2046 100%);color:#fff;justify-content:center}
  .cta::before{color:rgba(255,255,255,.5);border-bottom-color:rgba(255,255,255,.16)}
  .cta .pageno{color:var(--gold-soft)}
  .cta .kicker{color:var(--gold-soft)}.cta .kicker::before{background:var(--gold-soft)}
  .cta h1{color:#fff}
  .cta .next{margin-top:3vh;display:grid;grid-template-columns:repeat(3,1fr);gap:2.4em;max-width:60ch}
  .cta .next div{border-top:2px solid var(--gold-soft);padding-top:1em}
  .cta .next b{display:block;color:#fff;font-size:1.05rem;font-weight:700;margin-bottom:.3em}
  .cta .next span{color:rgba(255,255,255,.72);font-size:.92rem;line-height:1.5}
  .cta .contact{margin-top:4vh;font-size:.92rem;color:rgba(255,255,255,.7);letter-spacing:.04em}
  .cta .contact b{color:var(--gold-soft);font-weight:600}

  #bar{position:fixed;right:2.4vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:1.1vh;z-index:20}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--line-strong);transition:transform .25s,background .25s}
  .dot.on{background:var(--gold);transform:scale(1.5)}
  #hint{position:fixed;bottom:2.6vh;right:2.6vw;font-size:.72rem;color:var(--line-strong);letter-spacing:.1em;z-index:20}

  @media(max-width:860px){
    .slide{padding:11vh 7vw 12vh}
    .bullets,.metrics,.compare,.roadmap,.cta .next{grid-template-columns:1fr}
    .metrics{border-top:none}
    .metric{border-right:none;border-bottom:1px solid var(--line);border-top:2px solid var(--navy)}
    .roadmap::before{display:none}
    .roadmap .phase{padding:1.4em 0;border-bottom:1px solid var(--line)}
    .chapter .big-no{font-size:9rem;top:auto;bottom:auto;opacity:.06}
    #bar{display:none}
  }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.dot{transition:none}}
</style>
</head>
<body>
<main>

  <!-- (1) 封面 -->
  <section class="slide cover" data-org="某商业银行 · 数字化战略合作">
    <span class="pageno">01</span>
    <span class="kicker">售前方案 · 机密</span>
    <h1>AI 同事工作台<br>智能运营升级方案</h1>
    <p>面向零售银行业务的全员级 AI 协作平台，以可控、可审计、可落地为前提，重塑一线运营效率。</p>
    <div class="meta">
      <div>提报对象<b>某商业银行 总行运营管理部</b></div>
      <div>方案版本<b>V2.4 · 售前评审稿</b></div>
      <div>日期<b>二〇二六年六月</b></div>
    </div>
    <svg class="seal" viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r="92" fill="none" stroke="#c79a3a" stroke-width="2.5" opacity=".7"/>
      <circle cx="100" cy="100" r="78" fill="none" stroke="#c79a3a" stroke-width="1" opacity=".5"/>
      <path d="M100 34 L118 88 L174 88 L129 121 L146 174 L100 142 L54 174 L71 121 L26 88 L82 88 Z" fill="#c79a3a" opacity=".9"/>
      <text x="100" y="190" text-anchor="middle" fill="#c79a3a" font-size="11" letter-spacing="3" opacity=".75">TRUSTED &#183; 2026</text>
    </svg>
  </section>

  <!-- (2) 章节幕页 -->
  <section class="slide chapter" data-org="AI 同事工作台 · 方案目录">
    <span class="pageno">02</span>
    <span class="big-no">01</span>
    <span class="kicker">第一章</span>
    <h2>业务现状与挑战</h2>
    <div class="toc">
      <div class="on"><span>01</span>业务现状与挑战</div>
      <div><span>02</span>方案架构与能力</div>
      <div><span>03</span>实施路线与节奏</div>
      <div><span>04</span>投入产出与保障</div>
    </div>
  </section>

  <!-- (3) 要点列表 -->
  <section class="slide" data-org="第一章 · 业务现状与挑战">
    <span class="pageno">03</span>
    <span class="kicker">核心痛点</span>
    <h2>一线运营面临的四道关口</h2>
    <ul class="bullets">
      <li><span class="ix">01</span><div><b>人力高峰难削峰</b><p>季末与营销季话务、工单量陡增，临时扩员成本高、培训周期长。</p></div></li>
      <li><span class="ix">02</span><div><b>知识沉淀难复用</b><p>规章制度与话术散落多系统，新人查找耗时，口径不一致引发投诉。</p></div></li>
      <li><span class="ix">03</span><div><b>合规留痕难闭环</b><p>对外沟通缺乏统一审批与留痕，事后追溯困难，审计成本居高不下。</p></div></li>
      <li><span class="ix">04</span><div><b>跨部门协同断点多</b><p>需求在客服、运营、风控间流转，状态不透明，响应时效难以承诺。</p></div></li>
    </ul>
  </section>

  <!-- (4) 一排关键指标（数字大字） -->
  <section class="slide" data-org="第一章 · 量化基线">
    <span class="pageno">04</span>
    <span class="kicker">现状基线 · 示意值</span>
    <h2>四项指标，划出改进空间</h2>
    <div class="metrics">
      <div class="metric"><div class="n">42<em>分钟</em></div><div class="l">复杂工单平均处理时长</div><div class="src">示意值，待核实</div></div>
      <div class="metric"><div class="n">3.6<em>&#215;</em></div><div class="l">高峰期对人工坐席的扩员倍数</div><div class="src">示意值，待核实</div></div>
      <div class="metric"><div class="n">61<em>%</em></div><div class="l">重复性咨询占总话务比例</div><div class="src">示意值，待核实</div></div>
      <div class="metric"><div class="n">7<em>天</em></div><div class="l">新人独立上岗平均培训周期</div><div class="src">示意值，待核实</div></div>
    </div>
  </section>

  <!-- (5) 两栏对比 -->
  <section class="slide" data-org="第二章 · 方案架构与能力">
    <span class="pageno">05</span>
    <span class="kicker">方式对比</span>
    <h2>传统外包扩员 对比 AI 同事工作台</h2>
    <div class="compare">
      <div class="card">
        <span class="tag">现状 · 人力外包</span>
        <h3>按量堆人，边际递减</h3>
        <ul>
          <li>成本随业务量线性上升，难削峰</li>
          <li>培训周期长，质量波动大</li>
          <li>留痕与合规依赖人工自觉</li>
          <li>知识随人员流动而流失</li>
        </ul>
      </div>
      <div class="card hi">
        <span class="tag">方案 · AI 同事工作台</span>
        <h3>能力沉淀，可控可审计</h3>
        <ul>
          <li>边际成本趋近于零，弹性削峰</li>
          <li>统一知识底座，口径一致</li>
          <li>对外动作强制审批与全程留痕</li>
          <li>私有化部署，数据不出域</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- (6) 时间线 / 路线图 -->
  <section class="slide" data-org="第三章 · 实施路线与节奏">
    <span class="pageno">06</span>
    <span class="kicker">交付路线图</span>
    <h2>四阶段稳步落地，先试点再推广</h2>
    <div class="roadmap">
      <div class="phase done"><div class="node"></div><div class="when">第 1 阶段</div><h3>调研与共识</h3><p>梳理业务场景、口径与数据边界，确认安全合规要求。</p></div>
      <div class="phase done"><div class="node"></div><div class="when">第 2 阶段</div><h3>试点验证</h3><p>选取单一业务条线小范围试点，建立指标对照与回滚预案。</p></div>
      <div class="phase now"><div class="node"></div><div class="when">第 3 阶段</div><h3>规模推广</h3><p>分批接入更多条线，沉淀知识底座与审批流，培训内部管理员。</p></div>
      <div class="phase"><div class="node"></div><div class="when">第 4 阶段</div><h3>持续运营</h3><p>建立度量看板与迭代机制，按季度复盘并扩展能力边界。</p></div>
    </div>
  </section>

  <!-- (7) 引述 / 金句 -->
  <section class="slide quote-slide" data-org="客户视角 · 价值共识">
    <span class="pageno">07</span>
    <blockquote>
      <span class="mark" aria-hidden="true">&#8220;</span>
      <q>真正的降本，不是把人换掉，而是让每个人都带着一支随叫随到、永远在线的团队。</q>
      <cite><b>某商业银行 · 运营管理部总经理</b><br>试点复盘会 · 二〇二六年五月</cite>
    </blockquote>
  </section>

  <!-- (8) 结尾 CTA -->
  <section class="slide cta" data-org="AI 同事工作台 · 下一步">
    <span class="pageno">08</span>
    <span class="kicker">即刻启动</span>
    <h1>用四周试点，<br>验证一个可规模化的答案</h1>
    <div class="next">
      <div><b>本周</b><span>确认试点条线与成功指标，签署数据安全边界。</span></div>
      <div><b>第 2 周</b><span>完成私有化部署与知识底座导入，开通管理员账号。</span></div>
      <div><b>第 4 周</b><span>交付试点复盘报告，给出规模化推广建议与预算框架。</span></div>
    </div>
    <div class="contact">方案联系人 · 售前解决方案团队　|　邮箱 <b>presales@example.com</b>　|　电话 <b>400-000-0000</b></div>
  </section>

</main>

<nav id="bar" aria-hidden="true"></nav>
<div id="hint">&#8593; / &#8595; 翻页</div>

<script>
  /* 渐进增强：进度点高亮 + 键盘翻页。脚本关闭时主结构（scroll-snap 垂直栈）仍可滚动浏览全部幻灯片。 */
  (function(){
    var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    var bar = document.getElementById('bar');
    if(!slides.length || !bar) return;
    slides.forEach(function(){ var d=document.createElement('span'); d.className='dot'; bar.appendChild(d); });
    var dots = Array.prototype.slice.call(bar.children);
    var cur = 0;
    function mark(i){ cur=i; dots.forEach(function(d,k){ d.classList.toggle('on', k===i); }); }
    if('IntersectionObserver' in window){
      var io = new IntersectionObserver(function(es){
        es.forEach(function(e){ if(e.isIntersecting){ mark(slides.indexOf(e.target)); } });
      },{threshold:.55});
      slides.forEach(function(s){ io.observe(s); });
    } else { mark(0); }
    function go(n){ var i=Math.max(0,Math.min(slides.length-1,n)); slides[i].scrollIntoView(); mark(i); }
    document.addEventListener('keydown', function(e){
      if(e.key==='ArrowDown'||e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){ e.preventDefault(); go(cur+1); }
      if(e.key==='ArrowUp'||e.key==='ArrowLeft'||e.key==='PageUp'){ e.preventDefault(); go(cur-1); }
      if(e.key==='Home'){ e.preventDefault(); go(0); }
      if(e.key==='End'){ e.preventDefault(); go(slides.length-1); }
    });
    mark(0);
  })();
</script>
</body>
</html>`;

// 精装设计模板（验收过的对外演示风格；按需经『演示风格选择法』选用，read_skill 单取一套，避免一次性灌全部）。
const HTML_DECK_WHITESPACE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>极简留白 · 战略汇报模板</title>
<style>
  :root{
    --paper:#f6f4ef;        /* 暖白纸面，不用纯白，少 AI 感 */
    --ink:#16171a;          /* 近黑，正标题 */
    --sub:#54565b;          /* 中灰，正文 */
    --faint:#9a9ca1;        /* 弱灰，编号/标签 */
    --line:#dcd8cf;         /* 发丝分隔线 */
    --rail:#e7e3da;         /* 左栏网格基线 */
    --accent:#c0341d;       /* 单一克制强调色：朱墨红 */
    --accent-soft:#f0d9d3;
    --gut:9vw;              /* 左右版心留白 */
    --serif:Georgia,"Songti SC","Noto Serif CJK SC",serif;
    --sans:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{
    background:var(--paper);color:var(--ink);
    font-family:var(--sans);
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
    font-variant-numeric:tabular-nums;
  }

  /* ── 主结构：纵向 scroll-snap 栈；每屏即一页，脚本关闭也全可见可滚动 ── */
  .slide{
    position:relative;min-height:100vh;scroll-snap-align:start;
    padding:11vh var(--gut) 12vh;
    display:flex;flex-direction:column;justify-content:center;gap:1.1rem;
  }
  .slide + .slide{border-top:1px solid var(--line)}

  /* 左侧统一对齐基线：一道极细竖轴 + 页码，强对齐感 */
  .slide::before{
    content:"";position:absolute;top:11vh;bottom:12vh;left:calc(var(--gut) - 2.4vw);
    width:1px;background:var(--rail);
  }
  .folio{
    position:absolute;left:calc(var(--gut) - 2.4vw);top:11vh;
    transform:translate(-50%,-140%);
    font-size:.72rem;letter-spacing:.18em;color:var(--faint);
    font-variant-numeric:tabular-nums;
  }
  .running{
    position:absolute;right:var(--gut);top:11vh;transform:translateY(-150%);
    font-size:.7rem;letter-spacing:.34em;text-transform:uppercase;color:var(--faint);
  }

  /* 标签 / kicker */
  .kicker{
    font-size:.74rem;letter-spacing:.36em;text-transform:uppercase;
    color:var(--accent);font-weight:600;
  }
  .kicker.muted{color:var(--faint)}

  /* 字阶：超大、强 letter-spacing 收紧 */
  h1{font-size:clamp(2.6rem,7.4vw,6.4rem);font-weight:800;line-height:1.0;letter-spacing:-.025em}
  h2{font-size:clamp(1.7rem,4.2vw,3.2rem);font-weight:750;line-height:1.08;letter-spacing:-.015em}
  h3{font-size:clamp(1.15rem,2.1vw,1.5rem);font-weight:700;letter-spacing:-.005em}
  p{font-size:clamp(1.02rem,1.55vw,1.28rem);line-height:1.62;color:var(--sub);max-width:46ch}
  .lede{font-size:clamp(1.2rem,2vw,1.6rem);line-height:1.5;color:var(--ink);max-width:42ch;font-weight:450}

  /* 发丝强调线（强调色） */
  .rule{height:3px;width:3.4rem;background:var(--accent);border-radius:2px}
  .hr{height:1px;width:100%;background:var(--line)}

  /* ── 1. 封面 ── */
  .cover h1{margin:.1em 0 .25em}
  .cover .meta{display:flex;gap:2.6rem;flex-wrap:wrap;margin-top:1.6rem;color:var(--faint);font-size:.85rem;letter-spacing:.04em}
  .cover .meta b{display:block;color:var(--ink);font-weight:700;font-size:1rem;letter-spacing:0;margin-top:.2em}

  /* ── 2. 章节幕页：超大序号 + 标题 ── */
  .chapter{justify-content:flex-end;padding-bottom:14vh}
  .chapter .idx{
    font-family:var(--serif);font-weight:700;
    font-size:clamp(6rem,26vw,22rem);line-height:.8;color:var(--accent);
    letter-spacing:-.03em;
  }
  .chapter h1{max-width:18ch}

  /* ── 3. 要点列表：编号挂左，强对齐 ── */
  .points{counter-reset:p;display:flex;flex-direction:column;gap:0;margin-top:.4rem;max-width:60ch}
  .points li{
    counter-increment:p;list-style:none;display:grid;grid-template-columns:3.2rem 1fr;
    gap:1.4rem;align-items:baseline;padding:1.05rem 0;border-top:1px solid var(--line);
  }
  .points li:last-child{border-bottom:1px solid var(--line)}
  .points li::before{
    content:counter(p,decimal-leading-zero);
    font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700;
    font-size:1.05rem;letter-spacing:.04em;
  }
  .points b{font-weight:700;color:var(--ink);font-size:1.12rem}
  .points span{display:block;color:var(--sub);font-size:.98rem;line-height:1.55;margin-top:.25rem}

  /* ── 4. 关键指标：一排数字大字 ── */
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:1.2rem;border-top:1px solid var(--line)}
  .stats .cell{padding:1.8rem 1.6rem 1.8rem 0;border-bottom:1px solid var(--line)}
  .stats .cell + .cell{border-left:1px solid var(--line);padding-left:1.6rem}
  .stats .n{font-size:clamp(2.6rem,6.5vw,4.8rem);font-weight:800;line-height:.92;letter-spacing:-.03em;color:var(--ink)}
  .stats .n em{font-style:normal;color:var(--accent)}
  .stats .l{margin-top:.7rem;font-size:.86rem;color:var(--sub);letter-spacing:.02em;line-height:1.4}

  /* ── 5. 两栏对比 ── */
  .compare{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:1.2rem;border:1px solid var(--line)}
  .compare .col{padding:2rem 2.2rem}
  .compare .col + .col{border-left:1px solid var(--line)}
  .compare .col.lead{background:var(--accent-soft)}
  .compare .col h3{margin-bottom:.2rem}
  .compare .col.lead h3{color:var(--accent)}
  .compare .tag{font-size:.72rem;letter-spacing:.24em;text-transform:uppercase;color:var(--faint);display:block;margin-bottom:.9rem}
  .compare ul{list-style:none;display:flex;flex-direction:column;gap:.7rem;margin-top:1rem}
  .compare li{font-size:1rem;line-height:1.5;color:var(--sub);padding-left:1.1rem;position:relative}
  .compare li::before{content:"—";position:absolute;left:0;color:var(--accent)}

  /* ── 6. 时间线 / 路线图 ── */
  .road{margin-top:1.4rem;border-top:1px solid var(--line)}
  .road .step{display:grid;grid-template-columns:7.5rem 1fr;gap:2rem;padding:1.5rem 0;border-bottom:1px solid var(--line);align-items:start}
  .road .when{font-weight:800;font-size:1.1rem;letter-spacing:.02em;color:var(--accent);font-variant-numeric:tabular-nums}
  .road .when small{display:block;color:var(--faint);font-weight:600;font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;margin-top:.3rem}
  .road h3{margin-bottom:.3rem}
  .road .step p{font-size:.98rem;max-width:52ch}

  /* ── 7. 引述 / 金句 ── */
  .quote{align-items:flex-start}
  .quote blockquote{
    font-family:var(--serif);font-weight:700;
    font-size:clamp(2rem,5.4vw,4.2rem);line-height:1.12;letter-spacing:-.015em;
    color:var(--ink);max-width:20ch;
  }
  .quote blockquote .mark{color:var(--accent)}
  .quote cite{display:block;margin-top:2rem;font-style:normal;color:var(--faint);font-size:.9rem;letter-spacing:.04em}
  .quote cite b{color:var(--ink);font-weight:700;letter-spacing:0}

  /* ── 8. 结尾 CTA ── */
  .cta{background:var(--ink);color:var(--paper);justify-content:center}
  .cta::before{background:#34363b}
  .cta .folio,.cta .running{color:#7f8189}
  .cta .kicker{color:var(--accent)}
  .cta h1{color:var(--paper)}
  .cta p{color:#b9bbc0}
  .cta .row{display:flex;gap:3rem;flex-wrap:wrap;margin-top:1.8rem}
  .cta .row .item small{display:block;color:#7f8189;font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;margin-bottom:.45rem}
  .cta .row .item b{font-size:1.15rem;font-weight:700;color:var(--paper)}
  .cta .rule{background:var(--accent)}

  /* ── 右侧进度点（渐进增强；脚本关闭仍是静态点，不影响内容） ── */
  #rail{position:fixed;right:2.2vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:.85vh;z-index:20}
  #rail a{display:block;width:7px;height:7px;border-radius:50%;background:var(--line);transition:transform .2s,background .2s}
  #rail a.on{background:var(--accent);transform:scale(1.7)}
  #hint{position:fixed;left:50%;bottom:2.2vh;transform:translateX(-50%);font-size:.72rem;letter-spacing:.22em;color:var(--faint);z-index:20;text-transform:uppercase}

  /* ── 窄屏：防两栏挤压，统一塌成单栏 ── */
  @media(max-width:820px){
    :root{--gut:7vw}
    .slide::before,.folio{display:none}
    .stats{grid-template-columns:1fr 1fr}
    .stats .cell + .cell{border-left:0;padding-left:0}
    .compare{grid-template-columns:1fr}
    .compare .col + .col{border-left:0;border-top:1px solid var(--line)}
    .road .step{grid-template-columns:1fr;gap:.5rem}
    #rail{display:none}
  }
  @media(max-width:480px){
    .stats{grid-template-columns:1fr}
    .points li{grid-template-columns:2.4rem 1fr;gap:1rem}
  }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
  @media print{.slide{min-height:auto;page-break-after:always;border:0}#rail,#hint{display:none}}
</style>
</head>
<body>
<main>

  <!-- 1 · 封面 -->
  <section class="slide cover" id="s1">
    <span class="folio">01</span><span class="running">战略汇报</span>
    <div class="kicker">AI 同事工作台 · 季度评审</div>
    <div class="rule"></div>
    <h1>把判断力<br>装进流程里</h1>
    <p class="lede">在此填一句话主张：让团队的每一次决策，都带着可复用的上下文与证据。</p>
    <div class="meta">
      <div>汇报对象<b>管理层 / 决策委员会</b></div>
      <div>负责人<b>张三 · 战略与运营</b></div>
      <div>日期<b>2026 年 Q2</b></div>
    </div>
  </section>

  <!-- 2 · 章节幕页 -->
  <section class="slide chapter" id="s2">
    <span class="folio">02</span><span class="running">第一章</span>
    <div class="kicker muted">Section 01</div>
    <div class="idx">01</div>
    <h1>我们要解决的<br>是什么问题</h1>
  </section>

  <!-- 3 · 要点列表 -->
  <section class="slide" id="s3">
    <span class="folio">03</span><span class="running">现状诊断</span>
    <div class="kicker">三个结构性痛点</div>
    <div class="rule"></div>
    <ul class="points">
      <li><div><b>上下文流失</b><span>在此填要点：知识散落在聊天与文档之间，新人接手成本高。</span></div></li>
      <li><div><b>决策无据可循</b><span>在此填要点：关键判断缺少留痕，复盘时难以还原当时的依据。</span></div></li>
      <li><div><b>重复劳动</b><span>在此填要点：同类任务反复从零开始，缺少可沉淀的模板与流程。</span></div></li>
    </ul>
  </section>

  <!-- 4 · 一排关键指标（数字大字） -->
  <section class="slide" id="s4">
    <span class="folio">04</span><span class="running">关键指标</span>
    <div class="kicker">一年内的目标基线（示意值，待核实）</div>
    <div class="stats">
      <div class="cell"><div class="n">3.2<em>×</em></div><div class="l">人均产出效率提升</div></div>
      <div class="cell"><div class="n"><em>↓</em>62%</div><div class="l">重复性任务工时</div></div>
      <div class="cell"><div class="n">48<em>h</em></div><div class="l">交付周期缩短</div></div>
      <div class="cell"><div class="n">9<em>/10</em></div><div class="l">决策可追溯率</div></div>
    </div>
  </section>

  <!-- 5 · 两栏对比 -->
  <section class="slide" id="s5">
    <span class="folio">05</span><span class="running">方案抉择</span>
    <div class="kicker">两条路径，一个取舍</div>
    <div class="rule"></div>
    <div class="compare">
      <div class="col lead">
        <span class="tag">推荐 · 方案 A</span>
        <h3>嵌入现有工作流</h3>
        <ul>
          <li>在此填优势：上手快，无需迁移成本</li>
          <li>在此填优势：与现有审批/留痕打通</li>
          <li>在此填代价：初期需投入流程梳理</li>
        </ul>
      </div>
      <div class="col">
        <span class="tag">备选 · 方案 B</span>
        <h3>独立新建系统</h3>
        <ul>
          <li>在此填优势：自由度高，长期可塑</li>
          <li>在此填代价：迁移与培训成本大</li>
          <li>在此填代价：见效周期更长</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- 6 · 时间线 / 路线图 -->
  <section class="slide" id="s6">
    <span class="folio">06</span><span class="running">实施路线</span>
    <div class="kicker">四个阶段，循序推进</div>
    <div class="road">
      <div class="step"><div class="when">Q2<small>试点</small></div><div><h3>选定一条主流程跑通</h3><p>在此填阶段说明：圈定一个高频场景，验证价值闭环与留痕机制。</p></div></div>
      <div class="step"><div class="when">Q3<small>扩面</small></div><div><h3>沉淀模板与最佳实践</h3><p>在此填阶段说明：把试点经验抽象成可复用模板，覆盖更多团队。</p></div></div>
      <div class="step"><div class="when">Q4<small>规模化</small></div><div><h3>接入核心决策链路</h3><p>在此填阶段说明：将能力嵌入关键评审节点，形成组织默认动作。</p></div></div>
      <div class="step"><div class="when">次年<small>常态</small></div><div><h3>度量、迭代、固化</h3><p>在此填阶段说明：以指标驱动持续优化，让工具成为基础设施。</p></div></div>
    </div>
  </section>

  <!-- 7 · 引述 / 金句 -->
  <section class="slide quote" id="s7">
    <span class="folio">07</span><span class="running">一句话</span>
    <blockquote><span class="mark">「</span>少做、做对，<br>把判断留痕。<span class="mark">」</span></blockquote>
    <cite>在此填出处 — <b>受访的一线负责人</b>，内部访谈纪要</cite>
  </section>

  <!-- 8 · 结尾 CTA -->
  <section class="slide cta" id="s8">
    <span class="folio">08</span><span class="running">下一步</span>
    <div class="kicker">现在就能开始的一件事</div>
    <div class="rule"></div>
    <h1>本周内圈定<br>第一个试点场景</h1>
    <p>在此填行动建议：由你拍板，一个流程、一个负责人、两周一评审。</p>
    <div class="row">
      <div class="item"><small>对接人</small><b>张三 · 战略与运营</b></div>
      <div class="item"><small>邮箱</small><b>team@example.com</b></div>
      <div class="item"><small>评审节奏</small><b>每两周一次</b></div>
    </div>
  </section>

</main>

<nav id="rail" aria-hidden="true"></nav>
<div id="hint">↓ 滚动 · ← → 翻页</div>

<script>
  // 渐进增强：仅做进度点 + 键盘翻页。脚本关闭时，上面全部内容仍可正常滚动浏览。
  (function () {
    var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    var rail = document.getElementById('rail');
    if (!slides.length || !rail) return;

    slides.forEach(function (s, i) {
      var a = document.createElement('a');
      a.href = '#' + (s.id || ('s' + (i + 1)));
      a.setAttribute('aria-label', '第 ' + (i + 1) + ' 页');
      rail.appendChild(a);
    });
    var dots = Array.prototype.slice.call(rail.children);

    var cur = 0;
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            cur = slides.indexOf(e.target);
            dots.forEach(function (d, k) { d.classList.toggle('on', k === cur); });
          }
        });
      }, { threshold: 0.55 });
      slides.forEach(function (s) { io.observe(s); });
    } else {
      dots[0].classList.add('on');
    }

    function go(n) {
      cur = Math.max(0, Math.min(slides.length - 1, n));
      slides[cur].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(cur + 1); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1); }
      if (e.key === 'Home') { e.preventDefault(); go(0); }
      if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
    });
  })();
</script>
</body>
</html>`;

// 精装设计模板（验收过的对外演示风格；按需经『演示风格选择法』选用，read_skill 单取一套，避免一次性灌全部）。
const HTML_DECK_CIRCUIT = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>电光脉冲 · 产品发布 Deck</title>
<style>
  :root{
    --bg:#070a0f;            /* 近黑、带一丝冷蓝 */
    --bg-2:#0b1016;          /* 次级面板 */
    --ink:#eef3f8;           /* 主文字 */
    --dim:#7e8b9a;           /* 次级文字 */
    --faint:#4a5563;         /* 极弱文字/编号 */
    --accent:#27e0d8;        /* 电光青——本套唯一主色承诺 */
    --accent-deep:#0bb8c4;   /* 主色深档 */
    --line:#19222d;          /* 描边/分隔 */
    --grid:rgba(39,224,216,.05); /* 细网格 */
    --glow:0 0 0 1px rgba(39,224,216,.18), 0 14px 60px -22px rgba(39,224,216,.4);
    --serif:Georgia,"Songti SC","Noto Serif CJK SC",serif;
    --sans:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
    --mono:"SF Mono",ui-monospace,"JetBrains Mono",Menlo,"Cascadia Code",monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth;-webkit-text-size-adjust:100%}
  body{
    background:var(--bg);color:var(--ink);font-family:var(--sans);
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
    /* 细网格底纹（克制、低对比，全局可见） */
    background-image:
      linear-gradient(var(--grid) 1px,transparent 1px),
      linear-gradient(90deg,var(--grid) 1px,transparent 1px);
    background-size:46px 46px,46px 46px;
  }

  /* ── 单页骨架：scroll-snap 垂直栈，默认全部可见可滚动（脚本关也完整） ── */
  .slide{
    min-height:100vh;scroll-snap-align:start;position:relative;
    display:flex;flex-direction:column;justify-content:center;
    padding:9vh 8vw;gap:.7em;overflow:hidden;
  }
  .slide+.slide{border-top:1px solid var(--line)}
  /* 每页左上角的坐标编号——网格感 + 仪表盘气质 */
  .slide::before{
    content:attr(data-idx);position:absolute;top:5.2vh;left:8vw;
    font-family:var(--mono);font-size:.72rem;letter-spacing:.22em;color:var(--faint);
  }
  /* 顶部一条极细电光导轨（章节标识用） */
  .rail{position:absolute;top:5.2vh;right:8vw;display:flex;align-items:center;gap:.5rem;
    font-family:var(--mono);font-size:.7rem;letter-spacing:.24em;text-transform:uppercase;color:var(--accent)}
  .rail::before{content:"";width:1.6rem;height:1px;background:linear-gradient(90deg,transparent,var(--accent))}

  /* ── 字阶 ── */
  .kicker{font-family:var(--mono);font-size:.78rem;letter-spacing:.34em;text-transform:uppercase;color:var(--accent)}
  h1{font-size:clamp(2.4rem,7vw,6.4rem);font-weight:800;line-height:1.02;letter-spacing:-.022em}
  h1 .glow{color:var(--accent);text-shadow:0 0 28px rgba(39,224,216,.45)}
  h2{font-size:clamp(1.5rem,3.6vw,2.8rem);font-weight:750;line-height:1.12;letter-spacing:-.01em}
  h3{font-size:clamp(1.05rem,1.9vw,1.4rem);font-weight:700;color:var(--ink)}
  p,li{font-size:clamp(1rem,1.55vw,1.3rem);line-height:1.62;color:var(--dim);max-width:54ch}
  .lead{color:var(--ink);max-width:46ch}
  a{color:var(--accent);text-decoration:none}

  /* 主色横杠（标题装饰） */
  .bar{height:3px;width:3.4rem;background:linear-gradient(90deg,var(--accent),transparent);margin:.2em 0 .5em;border-radius:2px}

  /* ── 封面 ── */
  .cover h1{margin-top:.1em}
  .cover .meta{display:flex;flex-wrap:wrap;gap:1.4rem 2.6rem;margin-top:2.2em;
    font-family:var(--mono);font-size:.8rem;letter-spacing:.06em;color:var(--faint)}
  .cover .meta b{color:var(--dim);font-weight:500}
  /* 封面右下的电光弧光——克制发光 */
  .cover::after{content:"";position:absolute;right:-18vw;bottom:-22vh;width:60vw;height:60vw;
    background:radial-gradient(closest-side,rgba(39,224,216,.16),transparent 70%);
    filter:blur(8px);pointer-events:none}

  /* ── 章节幕页 ── */
  .chapter{justify-content:center}
  .chapter .no{font-family:var(--mono);font-size:clamp(3rem,11vw,9rem);font-weight:800;color:var(--line);line-height:.9;
    -webkit-text-stroke:1px var(--accent-deep);color:transparent}
  .chapter h2{font-size:clamp(2rem,5.5vw,4.4rem);margin-top:-.1em}

  /* ── 要点列表 ── */
  .points{list-style:none;padding:0;display:flex;flex-direction:column;gap:1.1em;margin-top:.6em;max-width:64ch}
  .points li{display:grid;grid-template-columns:auto 1fr;gap:1rem;align-items:start;max-width:none}
  .points .ix{font-family:var(--mono);font-size:.85rem;color:var(--accent);padding-top:.28em;
    border-left:2px solid var(--accent);padding-left:.8rem;letter-spacing:.05em}
  .points h3{margin-bottom:.15em}
  .points p{color:var(--dim);max-width:52ch}

  /* ── 关键指标（数字大字报） ── */
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);
    border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-top:1em;box-shadow:var(--glow)}
  .stat{background:var(--bg-2);padding:2.2em 1.6em;display:flex;flex-direction:column;gap:.35em}
  .stat .n{font-size:clamp(2.4rem,6.5vw,4.6rem);font-weight:800;color:var(--ink);line-height:.95;
    font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .stat .n em{font-style:normal;color:var(--accent);text-shadow:0 0 22px rgba(39,224,216,.4)}
  .stat .l{font-size:.9rem;color:var(--dim);letter-spacing:.04em;max-width:none}
  .stat .s{font-family:var(--mono);font-size:.72rem;color:var(--faint);letter-spacing:.08em}

  /* ── 两栏对比 ── */
  .versus{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);
    border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-top:.8em}
  .pane{background:var(--bg-2);padding:2.2em 2em;display:flex;flex-direction:column;gap:.6em}
  .pane.hi{background:linear-gradient(180deg,rgba(39,224,216,.07),var(--bg-2));box-shadow:inset 2px 0 0 var(--accent)}
  .pane .tag{font-family:var(--mono);font-size:.72rem;letter-spacing:.2em;text-transform:uppercase}
  .pane.old .tag{color:var(--faint)} .pane.hi .tag{color:var(--accent)}
  .pane ul{list-style:none;display:flex;flex-direction:column;gap:.55em;margin-top:.3em}
  .pane li{position:relative;padding-left:1.3em;max-width:none}
  .pane li::before{content:"–";position:absolute;left:0;color:var(--faint)}
  .pane.hi li::before{content:"▸";color:var(--accent)}

  /* ── 时间线 / 路线图 ── */
  .timeline{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:1.4em;position:relative}
  .timeline::before{content:"";position:absolute;left:0;right:0;top:.52rem;height:1px;
    background:linear-gradient(90deg,var(--accent-deep),var(--line))}
  .mile{position:relative;padding:0 1.2rem 0 0;display:flex;flex-direction:column;gap:.4em}
  .mile .dot{width:.85rem;height:.85rem;border-radius:50%;background:var(--bg);border:2px solid var(--accent);
    box-shadow:0 0 14px rgba(39,224,216,.5);position:relative;z-index:1;margin-bottom:.7em}
  .mile.done .dot{background:var(--accent)}
  .mile .when{font-family:var(--mono);font-size:.78rem;color:var(--accent);letter-spacing:.06em}
  .mile h3{font-size:1.05rem}
  .mile p{font-size:.95rem;max-width:24ch}

  /* ── 引述 / 金句 ── */
  .quote{justify-content:center}
  .quote blockquote{font-family:var(--serif);font-size:clamp(1.8rem,4.6vw,3.6rem);font-weight:500;
    line-height:1.28;letter-spacing:-.01em;color:var(--ink);max-width:24ch;position:relative}
  .quote blockquote .mark{color:var(--accent);font-size:1.2em;line-height:0}
  .quote cite{display:block;margin-top:1.4em;font-style:normal;font-family:var(--mono);
    font-size:.82rem;letter-spacing:.12em;color:var(--dim)}
  .quote cite::before{content:"— "}

  /* ── 结尾 CTA ── */
  .cta{justify-content:center;text-align:left}
  .cta h2{font-size:clamp(2rem,6vw,4.6rem)}
  .cta .row{display:flex;flex-wrap:wrap;gap:1rem;margin-top:1.8em;align-items:center}
  .btn{display:inline-flex;align-items:center;gap:.6rem;padding:.85em 1.6em;border-radius:999px;
    font-weight:700;font-size:1rem;letter-spacing:.02em}
  .btn.solid{background:var(--accent);color:#04181a;box-shadow:0 0 0 1px var(--accent),0 12px 40px -14px rgba(39,224,216,.7)}
  .btn.ghost{border:1px solid var(--line);color:var(--ink)}
  .btn.ghost::before{content:"›";color:var(--accent);font-weight:800}
  .cta .meta{margin-top:2em;font-family:var(--mono);font-size:.8rem;color:var(--faint);letter-spacing:.06em}

  /* ── 右侧进度点（渐进增强；脚本关也无碍——它本就空，不挡内容） ── */
  #bar{position:fixed;right:1.8vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:1vh;z-index:20}
  .pdot{width:7px;height:7px;border-radius:50%;background:#26323f;transition:all .3s}
  .pdot.on{background:var(--accent);box-shadow:0 0 12px rgba(39,224,216,.8);transform:scale(1.35)}
  #hint{position:fixed;bottom:2.4vh;right:2.4vw;font-family:var(--mono);font-size:.72rem;color:var(--faint);letter-spacing:.1em;z-index:20}

  /* ── 窄屏：所有两栏/四栏退化为单列，防挤压 ── */
  @media(max-width:860px){
    .stats{grid-template-columns:repeat(2,1fr)}
    .versus{grid-template-columns:1fr}
    .timeline{grid-template-columns:1fr;gap:1.4em}
    .timeline::before{left:.4rem;top:0;bottom:0;right:auto;width:1px;height:auto;background:linear-gradient(180deg,var(--accent-deep),var(--line))}
    .mile{padding-left:1.6rem}
    .cover .meta{gap:.8rem 1.6rem}
    #bar{display:none}
  }
  @media(max-width:520px){ .stats{grid-template-columns:1fr} }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.pdot{transition:none}}
</style>
</head>
<body>
<main>

  <!-- 1 · 封面 -->
  <section class="slide cover" data-idx="01 / 08">
    <div class="rail">PRODUCT LAUNCH</div>
    <div class="kicker">在此填产品代号 · 版本号</div>
    <h1>在此填<span class="glow">主标题</span><br>一句承诺式主张</h1>
    <p class="lead">在此填副标题：用一句话说清这是什么、为谁解决什么问题。克制，不堆形容词。</p>
    <div class="meta">
      <span><b>发布</b> 2026 春季</span>
      <span><b>团队</b> AI 同事工作台</span>
      <span><b>主讲</b> 在此填姓名 / 职务</span>
    </div>
  </section>

  <!-- 2 · 章节幕页 -->
  <section class="slide chapter" data-idx="02 / 08">
    <div class="rail">CHAPTER</div>
    <div class="no">01</div>
    <div class="bar"></div>
    <h2>背景与机会</h2>
    <p class="lead">用幕页切换叙事节奏：每个大章一页，编号 + 一句话概述，给观众喘息与定位。</p>
  </section>

  <!-- 3 · 要点列表 -->
  <section class="slide" data-idx="03 / 08">
    <div class="rail">KEY POINTS</div>
    <div class="kicker">为什么是现在</div>
    <div class="bar"></div>
    <h2>三个不可逆的趋势</h2>
    <ul class="points">
      <li><span class="ix">01</span><div><h3>在此填要点标题一</h3><p>一句话展开：动词开头，给出具体而非空泛的判断。</p></div></li>
      <li><span class="ix">02</span><div><h3>在此填要点标题二</h3><p>一句话展开：把抽象趋势落到一个可感知的现象上。</p></div></li>
      <li><span class="ix">03</span><div><h3>在此填要点标题三</h3><p>一句话展开：点明它对目标用户意味着什么改变。</p></div></li>
    </ul>
  </section>

  <!-- 4 · 关键指标（数字大字报） -->
  <section class="slide" data-idx="04 / 08">
    <div class="rail">METRICS</div>
    <div class="kicker">一眼看清量级</div>
    <div class="bar"></div>
    <h2>关键指标</h2>
    <div class="stats">
      <div class="stat"><div class="n"><em>3.2</em>×</div><div class="l">效率提升</div><div class="s">示意值 · 待核实</div></div>
      <div class="stat"><div class="n">↓<em>68</em>%</div><div class="l">单任务成本</div><div class="s">示意值 · 待核实</div></div>
      <div class="stat"><div class="n"><em>12</em>k</div><div class="l">日均处理量</div><div class="s">示意值 · 待核实</div></div>
      <div class="stat"><div class="n"><em>99.9</em>%</div><div class="l">交付可用性</div><div class="s">示意值 · 待核实</div></div>
    </div>
  </section>

  <!-- 5 · 两栏对比 -->
  <section class="slide" data-idx="05 / 08">
    <div class="rail">BEFORE / AFTER</div>
    <div class="kicker">改变了什么</div>
    <div class="bar"></div>
    <h2>从「人盯流程」到「AI 跑流程」</h2>
    <div class="versus">
      <div class="pane old">
        <div class="tag">过去 · 现状</div>
        <ul>
          <li>在此填旧流程的痛点一</li>
          <li>在此填旧流程的痛点二</li>
          <li>在此填旧流程的痛点三</li>
        </ul>
      </div>
      <div class="pane hi">
        <div class="tag">现在 · 本方案</div>
        <ul>
          <li>在此填对应的改进一</li>
          <li>在此填对应的改进二</li>
          <li>在此填对应的改进三</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- 6 · 时间线 / 路线图 -->
  <section class="slide" data-idx="06 / 08">
    <div class="rail">ROADMAP</div>
    <div class="kicker">我们走到哪、要去哪</div>
    <div class="bar"></div>
    <h2>发布路线图</h2>
    <div class="timeline">
      <div class="mile done"><div class="dot"></div><div class="when">2025 Q4</div><h3>内测启动</h3><p>在此填阶段成果。</p></div>
      <div class="mile done"><div class="dot"></div><div class="when">2026 Q1</div><h3>公开预览</h3><p>在此填阶段成果。</p></div>
      <div class="mile"><div class="dot"></div><div class="when">2026 Q2</div><h3>正式发布</h3><p>在此填阶段目标。</p></div>
      <div class="mile"><div class="dot"></div><div class="when">2026 Q3</div><h3>生态开放</h3><p>在此填阶段目标。</p></div>
    </div>
  </section>

  <!-- 7 · 引述 / 金句 -->
  <section class="slide quote" data-idx="07 / 08">
    <div class="rail">QUOTE</div>
    <blockquote><span class="mark">「</span>在此填一句能被复述的金句——<br>它该是结论，不是过渡。<span class="mark">」</span></blockquote>
    <cite>在此填出处 / 角色</cite>
  </section>

  <!-- 8 · 结尾 CTA -->
  <section class="slide cta" data-idx="08 / 08">
    <div class="rail">NEXT</div>
    <div class="kicker">下一步</div>
    <div class="bar"></div>
    <h2>现在就让 AI 同事<br>替你跑起来。</h2>
    <div class="row">
      <span class="btn solid">立即体验</span>
      <span class="btn ghost">预约演示</span>
    </div>
    <div class="meta">在此填联系方式 · 官网 · 二维码占位</div>
  </section>

</main>

<nav id="bar" aria-hidden="true"></nav>
<div id="hint">↑ ↓ / 空格 翻页</div>

<script>
  // 渐进增强：键盘翻页 + 右侧进度点高亮。关闭脚本时全部 .slide 仍可滚动阅读。
  (function(){
    var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    var bar = document.getElementById('bar');
    slides.forEach(function(){ var d = document.createElement('div'); d.className = 'pdot'; bar.appendChild(d); });
    var dots = Array.prototype.slice.call(bar.children);
    var cur = 0;
    function mark(i){ cur = i; dots.forEach(function(d,k){ d.classList.toggle('on', k === i); }); }
    if ('IntersectionObserver' in window){
      var io = new IntersectionObserver(function(es){
        es.forEach(function(e){ if (e.isIntersecting) mark(slides.indexOf(e.target)); });
      }, { threshold: 0.55 });
      slides.forEach(function(s){ io.observe(s); });
    }
    function go(n){ var i = Math.max(0, Math.min(slides.length - 1, n)); slides[i].scrollIntoView(); mark(i); }
    document.addEventListener('keydown', function(e){
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown'){ e.preventDefault(); go(cur + 1); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp'){ e.preventDefault(); go(cur - 1); }
      if (e.key === 'Home'){ go(0); } if (e.key === 'End'){ go(slides.length - 1); }
    });
    mark(0);
  })();
</script>
</body>
</html>`;

// 精装设计模板（验收过的对外演示风格；按需经『演示风格选择法』选用，read_skill 单取一套，避免一次性灌全部）。
const HTML_DECK_MAGAZINE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>编辑杂志 · 演示</title>
<style>
  :root{
    --paper:#f3ece1;        /* 米色纸感底 */
    --paper-2:#ece3d4;      /* 略深的纸 */
    --ink:#1f1b16;          /* 近黑墨色正文 */
    --ink-soft:#5a5147;     /* 次级文字 */
    --faint:#8a8073;        /* 极弱说明 */
    --accent:#9c2b1b;       /* 砖红强调（默认）*/
    --accent-ink:#fbf6ec;   /* 强调底上的文字 */
    --line:#cabfa9;         /* 细分隔线 */
    --line-strong:#3a3128;  /* 重分隔线 */
    --dot:#c6bba4;          /* 网格点阵 */
    --serif: Georgia,"Songti SC","Noto Serif CJK SC","Times New Roman",serif;
    --sans: -apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
  }
  /* 备选主色：把 <html> 加 class="theme-green" 即换墨绿（设计师承诺的二选一） */
  html.theme-green{ --accent:#1f4d3a; }

  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{
    background:var(--paper);
    color:var(--ink);
    font-family:var(--sans);
    -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility;
  }
  ::selection{background:var(--accent);color:var(--accent-ink)}

  /* ── 幻灯片骨架：纵向 scroll-snap 栈，脚本关也全可见 ───────────────── */
  .slide{
    min-height:100vh;
    scroll-snap-align:start;
    padding:7vh 8vw 9vh;
    position:relative;
    display:flex;
    flex-direction:column;
    justify-content:center;
    /* 纸感：极淡网格点阵 + 顶部细噪纹 */
    background-image:radial-gradient(var(--dot) .6px,transparent .7px);
    background-size:22px 22px;
    background-position:-1px -1px;
  }
  .slide+.slide{border-top:1px solid var(--line)}

  /* ── 栏目页眉：编号 + 栏目名 + 右侧刊名（每页统一节奏感）──────────── */
  .masthead{
    position:absolute;top:4.4vh;left:8vw;right:8vw;
    display:flex;align-items:baseline;justify-content:space-between;
    font-size:.72rem;letter-spacing:.26em;text-transform:uppercase;color:var(--faint);
  }
  .masthead .no{color:var(--accent);font-weight:700}
  .masthead .sec{flex:1;margin:0 1.4em;border-bottom:1px solid var(--line);transform:translateY(-.18em)}
  .folio{position:absolute;bottom:4.4vh;left:8vw;right:8vw;display:flex;justify-content:space-between;font-size:.7rem;letter-spacing:.22em;color:var(--faint)}

  .kicker{font-size:.74rem;letter-spacing:.32em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:1.1em}
  .kicker.ink{color:var(--ink-soft)}

  h1{font-family:var(--serif);font-weight:700;font-size:clamp(2.8rem,8.4vw,6.6rem);line-height:1.0;letter-spacing:-.01em;font-feature-settings:"ss01"}
  h2{font-family:var(--serif);font-weight:700;font-size:clamp(1.9rem,4.6vw,3.4rem);line-height:1.08;letter-spacing:-.005em}
  h3{font-family:var(--sans);font-weight:700;font-size:1.05rem;letter-spacing:.02em}
  p,li{font-size:clamp(1rem,1.55vw,1.22rem);line-height:1.62;color:var(--ink-soft);max-width:46ch}
  .lede{font-size:clamp(1.15rem,2vw,1.5rem);color:var(--ink);max-width:40ch;line-height:1.5}
  em{font-style:italic;color:var(--accent);font-family:var(--serif)}
  .accent{color:var(--accent)}

  .rule{height:2px;background:var(--line-strong);width:64px;margin:1.4em 0}
  .rule.full{width:100%;height:1px;background:var(--line)}

  /* ── 封面 ─────────────────────────────────────────────────────── */
  .cover{justify-content:space-between}
  .cover-top{display:flex;align-items:baseline;justify-content:space-between;font-size:.78rem;letter-spacing:.28em;text-transform:uppercase;color:var(--ink-soft)}
  .cover-top b{color:var(--accent)}
  .cover-main{margin:auto 0}
  .cover-main h1{font-size:clamp(3.2rem,11vw,9rem)}
  .cover-sub{font-family:var(--serif);font-style:italic;font-size:clamp(1.2rem,2.6vw,1.9rem);color:var(--ink-soft);margin-top:.6em;max-width:30ch}
  .cover-foot{display:flex;justify-content:space-between;align-items:flex-end;border-top:2px solid var(--line-strong);padding-top:1em;font-size:.82rem;letter-spacing:.04em;color:var(--ink-soft)}

  /* ── 章节幕页（大编号 + 反白/砖红块）───────────────────────────── */
  .chapter{background:var(--accent);color:var(--accent-ink);background-image:radial-gradient(rgba(255,255,255,.10) .6px,transparent .7px);background-size:22px 22px}
  .chapter .kicker{color:var(--accent-ink);opacity:.8}
  .chapter h1{color:var(--accent-ink)}
  .chapter .bignum{font-family:var(--serif);font-size:clamp(7rem,30vw,22rem);line-height:.8;opacity:.16;position:absolute;right:6vw;bottom:2vh;pointer-events:none}
  .chapter p{color:var(--accent-ink);opacity:.85;max-width:42ch}
  .chapter .folio,.chapter .masthead{color:rgba(255,255,255,.6)}
  .chapter .masthead .sec{border-color:rgba(255,255,255,.4)}
  .chapter .masthead .no{color:var(--accent-ink)}

  /* ── 要点列表（编号 + 悬挂缩进，编辑体）─────────────────────────── */
  .points{list-style:none;padding:0;max-width:60ch;display:flex;flex-direction:column;gap:1.1em;margin-top:.4em}
  .points li{display:grid;grid-template-columns:2.4em 1fr;gap:.4em 1em;align-items:baseline;max-width:none;padding-bottom:1.1em;border-bottom:1px solid var(--line)}
  .points li:last-child{border-bottom:0}
  .points .idx{font-family:var(--serif);font-size:1.5rem;color:var(--accent);font-weight:700;line-height:1}
  .points h3{margin-bottom:.25em;color:var(--ink)}
  .points p{margin:0;color:var(--ink-soft)}

  /* ── 关键指标（数字大字一排）───────────────────────────────────── */
  .stats{display:flex;flex-wrap:wrap;gap:clamp(2rem,6vw,5rem);margin-top:.8em}
  .stat{min-width:8em}
  .stat .n{font-family:var(--serif);font-weight:700;font-size:clamp(2.8rem,8vw,5.4rem);line-height:.95;color:var(--accent);letter-spacing:-.02em}
  .stat .l{font-size:.92rem;letter-spacing:.06em;color:var(--ink-soft);margin-top:.5em}
  .stat .s{font-size:.74rem;color:var(--faint);margin-top:.2em}

  /* ── 两栏对比 ─────────────────────────────────────────────────── */
  .cols{display:grid;grid-template-columns:1fr 1px 1fr;gap:0 clamp(2rem,5vw,4rem);margin-top:.6em;align-items:start}
  .cols .vline{background:var(--line);align-self:stretch}
  .col h3{color:var(--ink);margin-bottom:.8em;display:flex;align-items:center;gap:.6em}
  .col h3 .tag{font-family:var(--sans);font-size:.66rem;letter-spacing:.2em;text-transform:uppercase;padding:.25em .6em;border-radius:2px}
  .col.a h3 .tag{background:var(--ink);color:var(--paper)}
  .col.b h3 .tag{background:var(--accent);color:var(--accent-ink)}
  .col ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:.7em}
  .col li{position:relative;padding-left:1.2em;max-width:34ch}
  .col li::before{content:"—";position:absolute;left:0;color:var(--accent)}

  /* ── 时间线 / 路线图 ───────────────────────────────────────────── */
  .timeline{list-style:none;padding:0;margin-top:1em;border-left:2px solid var(--line-strong);max-width:none}
  .timeline li{position:relative;padding:0 0 1.6em 2em;max-width:52ch}
  .timeline li:last-child{padding-bottom:0}
  .timeline li::before{content:"";position:absolute;left:-7px;top:.35em;width:12px;height:12px;border-radius:50%;background:var(--paper);border:2px solid var(--accent)}
  .timeline .when{font-family:var(--serif);font-weight:700;color:var(--accent);font-size:1.1rem}
  .timeline h3{color:var(--ink);margin:.15em 0 .3em}
  .timeline p{margin:0}

  /* ── 引述 / 金句 ───────────────────────────────────────────────── */
  .quote{justify-content:center;text-align:left}
  .quote blockquote{font-family:var(--serif);font-size:clamp(1.8rem,5vw,3.6rem);line-height:1.18;color:var(--ink);max-width:20ch;position:relative}
  .quote blockquote::before{content:"“";font-family:var(--serif);position:absolute;left:-.55em;top:-.2em;color:var(--accent);font-size:1.3em;line-height:1}
  .quote cite{display:block;font-style:normal;font-size:.95rem;letter-spacing:.08em;color:var(--ink-soft);margin-top:1.6em}
  .quote cite b{color:var(--accent)}

  /* ── 结尾 CTA ─────────────────────────────────────────────────── */
  .cta{background:var(--ink);color:var(--paper);background-image:radial-gradient(rgba(255,255,255,.06) .6px,transparent .7px);background-size:22px 22px}
  .cta .kicker{color:var(--accent)}
  .cta h1{color:var(--paper)}
  .cta p{color:#cdc6b9}
  .cta .actions{display:flex;flex-wrap:wrap;gap:1.2em;margin-top:1.8em;align-items:center}
  .cta .btn{font-size:1.02rem;letter-spacing:.04em;padding:.7em 1.4em;border:1px solid var(--accent);color:var(--paper);background:var(--accent);border-radius:2px}
  .cta .btn.ghost{background:transparent;border-color:#6b6253;color:var(--paper)}
  .cta .folio,.cta .masthead{color:rgba(255,255,255,.5)}
  .cta .masthead .sec{border-color:rgba(255,255,255,.3)}

  /* ── 进度点（右侧）──────────────────────────────────────────────── */
  #bar{position:fixed;right:2.2vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:1vh;z-index:9}
  .dot{width:8px;height:8px;border-radius:50%;background:transparent;border:1.5px solid var(--faint);transition:all .25s}
  .dot.on{background:var(--accent);border-color:var(--accent);transform:scale(1.35)}
  #hint{position:fixed;bottom:2.4vh;right:2.2vw;font-size:.7rem;letter-spacing:.2em;color:var(--faint);z-index:9}

  /* ── 窄屏：两栏退化为单栏、缩小页边距 ───────────────────────────── */
  @media(max-width:720px){
    .slide{padding:8vh 7vw 9vh}
    .cols{grid-template-columns:1fr;gap:2.2em}
    .cols .vline{display:none}
    .stats{gap:1.6rem 2.4rem}
    .masthead,.folio{left:7vw;right:7vw}
    #bar{display:none}
    .points li{grid-template-columns:1.8em 1fr}
  }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.dot{transition:none}}
</style>
</head>
<body>
<main>

  <!-- 1 ▸ 封面 -->
  <section class="slide cover">
    <div class="cover-top"><span><b>季刊</b> · VOL.07</span><span>AI 同事工作台 · 编辑部出品</span></div>
    <div class="cover-main">
      <div class="kicker">封面故事 · COVER STORY</div>
      <h1>在此填主标题<br>一行压住版面</h1>
      <p class="cover-sub">副标题写在这里，一句话讲清这期讲什么，留白即态度。</p>
    </div>
    <div class="cover-foot"><span>2026 年春季号</span><span>主笔 / 占位作者　摄影 / 占位</span></div>
  </section>

  <!-- 2 ▸ 章节幕页 -->
  <section class="slide chapter">
    <div class="masthead"><span class="no">第 01 章</span><span class="sec"></span><span>SECTION ONE</span></div>
    <div class="kicker">本章导语</div>
    <h1>章节标题：<br>一个清晰的主张</h1>
    <p>用一两句话交代这一章要回答什么问题，给读者一个进入的理由。</p>
    <div class="bignum">01</div>
    <div class="folio"><span>AI 同事工作台</span><span>02</span></div>
  </section>

  <!-- 3 ▸ 要点列表 -->
  <section class="slide">
    <div class="masthead"><span class="no">02 · 要点</span><span class="sec"></span><span>KEY POINTS</span></div>
    <div class="kicker ink">三条主线</div>
    <h2>把观点拆成可读的条目</h2>
    <ol class="points">
      <li><span class="idx">01</span><div><h3>第一条要点标题</h3><p>展开一句解释，说清这条为什么重要，控制在两行内最佳。</p></div></li>
      <li><span class="idx">02</span><div><h3>第二条要点标题</h3><p>每条只讲一件事，编号与悬挂缩进让节奏统一、好扫读。</p></div></li>
      <li><span class="idx">03</span><div><h3>第三条要点标题</h3><p>宁可多分一页，也别把版面堆满；留白是编辑的判断。</p></div></li>
    </ol>
    <div class="folio"><span>AI 同事工作台</span><span>03</span></div>
  </section>

  <!-- 4 ▸ 关键指标（数字大字一排）-->
  <section class="slide">
    <div class="masthead"><span class="no">03 · 数据</span><span class="sec"></span><span>BY THE NUMBERS</span></div>
    <div class="kicker ink">一眼看懂的量级</div>
    <h2>关键指标</h2>
    <div class="rule"></div>
    <div class="stats">
      <div class="stat"><div class="n">268亿</div><div class="l">目标市场规模</div><div class="s">示意值，待核实</div></div>
      <div class="stat"><div class="n">3.2×</div><div class="l">效率提升</div><div class="s">示意值，待核实</div></div>
      <div class="stat"><div class="n">↓ 80%</div><div class="l">人力成本下降</div><div class="s">示意值，待核实</div></div>
      <div class="stat"><div class="n">12 周</div><div class="l">上线周期</div><div class="s">示意值，待核实</div></div>
    </div>
    <div class="folio"><span>AI 同事工作台</span><span>04</span></div>
  </section>

  <!-- 5 ▸ 两栏对比 -->
  <section class="slide">
    <div class="masthead"><span class="no">04 · 对比</span><span class="sec"></span><span>BEFORE / AFTER</span></div>
    <div class="kicker ink">改变了什么</div>
    <h2>过去 与 现在</h2>
    <div class="rule"></div>
    <div class="cols">
      <div class="col a">
        <h3>过去 <span class="tag">现状</span></h3>
        <ul>
          <li>占位：旧流程的第一个痛点</li>
          <li>占位：靠人工、易出错、不可追溯</li>
          <li>占位：响应慢，跨部门协作摩擦大</li>
        </ul>
      </div>
      <div class="vline"></div>
      <div class="col b">
        <h3>现在 <span class="tag">方案</span></h3>
        <ul>
          <li>占位：新方案如何解决该痛点</li>
          <li>占位：自动化、可审计、留痕</li>
          <li>占位：分钟级响应，统一在一处协作</li>
        </ul>
      </div>
    </div>
    <div class="folio"><span>AI 同事工作台</span><span>05</span></div>
  </section>

  <!-- 6 ▸ 时间线 / 路线图 -->
  <section class="slide">
    <div class="masthead"><span class="no">05 · 路线</span><span class="sec"></span><span>ROADMAP</span></div>
    <div class="kicker ink">分阶段推进</div>
    <h2>路线图</h2>
    <div class="rule"></div>
    <ol class="timeline">
      <li><div class="when">第一阶段 · Q1</div><h3>打地基</h3><p>占位：明确范围、跑通最小闭环，先做对再做多。</p></li>
      <li><div class="when">第二阶段 · Q2</div><h3>扩能力</h3><p>占位：补齐核心场景，引入多角色协作与验收。</p></li>
      <li><div class="when">第三阶段 · Q3</div><h3>提质量</h3><p>占位：接地校验、来源标注、对外交付物可信化。</p></li>
      <li><div class="when">第四阶段 · Q4</div><h3>规模化</h3><p>占位：稳定运维、成本分级、复制到更多团队。</p></li>
    </ol>
    <div class="folio"><span>AI 同事工作台</span><span>06</span></div>
  </section>

  <!-- 7 ▸ 引述 / 金句 -->
  <section class="slide quote">
    <div class="masthead"><span class="no">06 · 金句</span><span class="sec"></span><span>PULL QUOTE</span></div>
    <blockquote>把一句最有分量的话<em>放到最大</em>，让它独自占一页。</blockquote>
    <cite>— 占位受访者，<b>职位 / 机构</b></cite>
    <div class="folio"><span>AI 同事工作台</span><span>07</span></div>
  </section>

  <!-- 8 ▸ 结尾 CTA -->
  <section class="slide cta">
    <div class="masthead"><span class="no">尾声</span><span class="sec"></span><span>NEXT STEPS</span></div>
    <div class="kicker">下一步</div>
    <h1>一句话呼吁行动</h1>
    <p>把希望读者做的事说清楚：预约演示、扫码加入、或留下联系方式。</p>
    <div class="actions">
      <span class="btn">主行动 · 立即开始</span>
      <span class="btn ghost">次行动 · 了解更多</span>
      <span style="color:#cdc6b9;letter-spacing:.04em">占位邮箱 · hello@example.com</span>
    </div>
    <div class="folio"><span>AI 同事工作台 · 编辑部</span><span>08</span></div>
  </section>

</main>

<nav id="bar" aria-hidden="true"></nav>
<div id="hint">↑ / ↓ 翻页</div>

<script>
  // 渐进增强：脚本关闭时全部幻灯片照样可见可滚动（上方为默认静态结构）。
  const slides=[...document.querySelectorAll('.slide')];
  const bar=document.getElementById('bar');
  slides.forEach(()=>{const d=document.createElement('div');d.className='dot';bar.appendChild(d);});
  const dots=[...bar.children];
  let cur=0;
  const io=new IntersectionObserver((entries)=>{
    entries.forEach((e)=>{
      if(e.isIntersecting){
        cur=slides.indexOf(e.target);
        dots.forEach((d,k)=>d.classList.toggle('on',k===cur));
      }
    });
  },{threshold:.55});
  slides.forEach((s)=>io.observe(s));
  function go(n){cur=Math.max(0,Math.min(slides.length-1,n));slides[cur].scrollIntoView();}
  document.addEventListener('keydown',(e)=>{
    if(e.key==='ArrowDown'||e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();go(cur+1);}
    if(e.key==='ArrowUp'||e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(cur-1);}
    if(e.key==='Home'){e.preventDefault();go(0);}
    if(e.key==='End'){e.preventDefault();go(slides.length-1);}
  });
  dots.forEach((d,k)=>d.addEventListener('click',()=>go(k)));
</script>
</body>
</html>`;

// 精装设计模板（验收过的对外演示风格；按需经『演示风格选择法』选用，read_skill 单取一套，避免一次性灌全部）。
const HTML_DECK_COLORBLOCK = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>撞色海报演示</title>
<style>
  :root{
    --ink:#15110d;          /* 近黑墨，带暖 */
    --paper:#f5ede0;        /* 暖米白 */
    --vermilion:#ff3b1f;    /* 主色：朱红 */
    --amber:#ffb400;        /* 副色：琥珀橙 */
    --teal:#0c5c4c;         /* 撞色：深松绿（克制点缀） */
    --dim:rgba(21,17,13,.62);
    --dim-on-dark:rgba(245,237,224,.72);
    --line:rgba(21,17,13,.16);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{
    background:var(--paper);color:var(--ink);
    font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  /* ── 幻灯片骨架：scroll-snap 垂直栈，默认全可见可滚动（脚本关也能读） ── */
  .slide{
    min-height:100vh;scroll-snap-align:start;position:relative;overflow:hidden;
    display:flex;flex-direction:column;justify-content:center;
    padding:9vh 8vw;gap:.7em;
  }
  /* 色块分区：每页用大色块承载，强对比 */
  .s-paper{background:var(--paper);color:var(--ink)}
  .s-ink{background:var(--ink);color:var(--paper)}
  .s-vermilion{background:var(--vermilion);color:var(--paper)}
  .s-amber{background:var(--amber);color:var(--ink)}
  .s-teal{background:var(--teal);color:var(--paper)}

  /* ── 字阶 ── */
  .kicker{
    display:inline-block;font-size:clamp(.72rem,1.1vw,.92rem);font-weight:800;
    letter-spacing:.32em;text-transform:uppercase;
  }
  .kicker.box{padding:.4em .8em;background:var(--ink);color:var(--paper)}
  .s-ink .kicker.box,.s-vermilion .kicker.box,.s-teal .kicker.box{background:var(--paper);color:var(--ink)}
  .s-amber .kicker.box{background:var(--vermilion);color:var(--paper)}
  h1{font-size:clamp(2.6rem,8.4vw,7.2rem);font-weight:900;line-height:.96;letter-spacing:-.025em}
  h2{font-size:clamp(1.7rem,4.6vw,3.4rem);font-weight:900;line-height:1.04;letter-spacing:-.015em}
  h3{font-size:clamp(1.1rem,2vw,1.5rem);font-weight:800;letter-spacing:-.01em}
  p,li{font-size:clamp(1rem,1.7vw,1.32rem);line-height:1.58;max-width:46ch}
  .lead{font-size:clamp(1.15rem,2.2vw,1.7rem);font-weight:600;line-height:1.45;max-width:32ch;color:inherit}
  .dim{color:var(--dim)}
  .s-ink .dim,.s-vermilion .dim,.s-teal .dim{color:var(--dim-on-dark)}
  .mark{color:var(--vermilion)}
  .s-vermilion .mark,.s-amber .mark{color:var(--ink)}
  .s-ink .mark{color:var(--amber)}

  /* 封面：超大标题 + 角落色块 */
  .cover h1{max-width:14ch}
  .cover-meta{display:flex;flex-wrap:wrap;gap:1.4em 2.2em;margin-top:1.6em;font-size:clamp(.85rem,1.3vw,1.05rem);font-weight:700}
  .cover-meta span{display:flex;align-items:center;gap:.5em}
  .swatch{width:.85em;height:.85em;border-radius:2px;display:inline-block}
  .corner-block{position:absolute;right:-6vw;bottom:-6vw;width:38vw;height:38vw;background:var(--vermilion);border-radius:50% 50% 0 50%;opacity:.92;z-index:0}
  .corner-block.two{right:14vw;bottom:auto;top:-8vw;width:18vw;height:18vw;background:var(--amber);border-radius:50%}
  .cover>*:not(.corner-block){position:relative;z-index:1}

  /* 章节幕页：满版色块 + 巨号序号 */
  .chapter{justify-content:flex-end}
  .chapter .num{position:absolute;top:6vh;right:8vw;font-size:clamp(6rem,26vw,22rem);font-weight:900;line-height:.8;opacity:.16;letter-spacing:-.04em;z-index:0}
  .chapter>*{position:relative;z-index:1}
  .chapter h2{max-width:18ch}

  /* 要点列表：左侧粗竖条 + 序号块 */
  .points{list-style:none;display:flex;flex-direction:column;gap:1.1em;margin-top:.6em;max-width:none}
  .points li{display:flex;gap:1em;align-items:flex-start;max-width:52ch}
  .points .idx{flex:0 0 auto;width:2.1em;height:2.1em;display:grid;place-items:center;font-weight:900;font-size:1.05rem;background:var(--vermilion);color:var(--paper);border-radius:6px}
  .s-vermilion .points .idx{background:var(--ink);color:var(--paper)}
  .s-amber .points .idx{background:var(--vermilion);color:var(--paper)}
  .points .txt{padding-top:.15em}
  .points .txt b{font-weight:800}

  /* 关键指标：一排大字数字 */
  .stat-row{display:flex;flex-wrap:wrap;gap:2.4em 4vw;margin-top:1em}
  .stat{min-width:6em}
  .stat .n{font-size:clamp(2.8rem,9vw,6rem);font-weight:900;line-height:.92;letter-spacing:-.03em}
  .stat .l{font-size:clamp(.85rem,1.3vw,1.05rem);font-weight:700;margin-top:.3em}
  .stat .sub{font-size:.82rem;font-weight:500;margin-top:.15em}

  /* 两栏对比 */
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:1.2em;border:3px solid var(--ink)}
  .s-ink .cols,.s-vermilion .cols,.s-teal .cols{border-color:var(--paper)}
  .col{padding:clamp(1.2rem,3vw,2.2rem)}
  .col+.col{border-left:3px solid var(--ink)}
  .s-ink .col+.col,.s-vermilion .col+.col,.s-teal .col+.col{border-left-color:var(--paper)}
  .col.hot{background:var(--vermilion);color:var(--paper)}
  .col .tag{font-size:.78rem;font-weight:800;letter-spacing:.2em;text-transform:uppercase;opacity:.8}
  .col h3{margin:.4em 0 .6em}
  .col ul{list-style:none;display:flex;flex-direction:column;gap:.5em}
  .col li{font-size:clamp(.95rem,1.5vw,1.15rem);max-width:none;display:flex;gap:.5em}
  .col li::before{content:"—";font-weight:900;opacity:.6}

  /* 时间线 / 路线图 */
  .road{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:1.6em}
  .road .step{padding:0 1.4em 0 0;position:relative;border-top:4px solid var(--ink)}
  .s-ink .road .step,.s-teal .road .step{border-top-color:var(--paper)}
  .road .step .dot{width:1.1em;height:1.1em;border-radius:50%;background:var(--vermilion);margin:-.62em 0 .9em;border:3px solid var(--paper)}
  .s-paper .road .step .dot{border-color:var(--paper)}
  .road .step .when{font-size:.82rem;font-weight:800;letter-spacing:.12em;color:var(--vermilion)}
  .s-ink .road .step .when{color:var(--amber)}
  .road .step h3{margin:.3em 0}
  .road .step p{font-size:.95rem;max-width:none}

  /* 引述 / 金句 */
  .quote{justify-content:center;align-items:flex-start}
  .quote blockquote{font-size:clamp(2rem,6.5vw,5rem);font-weight:900;line-height:1.06;letter-spacing:-.02em;max-width:16ch;position:relative}
  .quote blockquote::before{content:"\\201C";position:absolute;left:-.55em;top:-.25em;font-size:1.4em;opacity:.45}
  .quote .by{margin-top:1.4em;font-size:clamp(1rem,1.6vw,1.25rem);font-weight:700}
  .quote .by .role{font-weight:500;opacity:.7}

  /* 结尾 CTA */
  .cta{justify-content:center;align-items:flex-start;text-align:left}
  .cta h2{max-width:18ch}
  .cta .btn{
    display:inline-flex;align-items:center;gap:.6em;margin-top:1.6em;
    padding:.85em 1.6em;background:var(--ink);color:var(--paper);
    font-weight:800;font-size:clamp(1rem,1.6vw,1.25rem);border-radius:8px;letter-spacing:.01em;
  }
  .s-vermilion .cta .btn,.s-amber .cta .btn{background:var(--ink);color:var(--paper)}
  .cta .btn .arr{font-weight:900}
  .cta .lines{margin-top:1.8em;display:flex;flex-wrap:wrap;gap:.4em 2em;font-size:clamp(.9rem,1.4vw,1.1rem);font-weight:600}

  /* ── 进度点（右侧，渐进增强；脚本关时 hidden 不留空位） ── */
  #bar{position:fixed;right:2.2vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:1vh;z-index:50}
  .dot{width:9px;height:9px;border-radius:50%;background:rgba(21,17,13,.22);transition:transform .25s,background .25s;cursor:pointer}
  .dot.on{background:var(--vermilion);transform:scale(1.7)}
  html:not(.js) #bar{display:none}

  /* ── 窄屏防挤压 ── */
  @media(max-width:720px){
    .slide{padding:8vh 7vw}
    .cols{grid-template-columns:1fr}
    .col+.col{border-left:0;border-top:3px solid var(--ink)}
    .s-ink .col+.col,.s-vermilion .col+.col,.s-teal .col+.col{border-top-color:var(--paper);border-left-color:transparent}
    .road{grid-template-columns:1fr 1fr;gap:2em 0}
    .stat-row{gap:1.6em 8vw}
    #bar{display:none}
  }
  @media(max-width:440px){ .road{grid-template-columns:1fr} }
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.dot{transition:none}}
</style>
</head>
<body>
<main>

  <!-- 1 ▸ 封面 -->
  <section class="slide s-paper cover">
    <div class="corner-block"></div>
    <div class="corner-block two"></div>
    <span class="kicker box">2026 产品发布</span>
    <h1>把<span class="mark">每个人</span>的<br>AI 同事，<br>请进工作台</h1>
    <p class="lead dim">一句话主张放这里：让团队像调度同事一样调度智能体。</p>
    <div class="cover-meta">
      <span><i class="swatch" style="background:var(--vermilion)"></i>主讲人 · 张三</span>
      <span><i class="swatch" style="background:var(--amber)"></i>产品负责人</span>
      <span><i class="swatch" style="background:var(--teal)"></i>2026.06</span>
    </div>
  </section>

  <!-- 2 ▸ 章节幕页 -->
  <section class="slide s-vermilion chapter">
    <div class="num">01</div>
    <span class="kicker box">第一章</span>
    <h2>我们要解决的<br>是什么问题</h2>
    <p class="dim">用一句话交代这一章的承诺，给观众一个清晰的预期。</p>
  </section>

  <!-- 3 ▸ 要点列表 -->
  <section class="slide s-paper">
    <span class="kicker box">核心要点</span>
    <h2>三件值得记住的事</h2>
    <ul class="points">
      <li><span class="idx">1</span><span class="txt"><b>要点标题占位。</b>一句补充说明，控制在两行内，别堆密。</span></li>
      <li><span class="idx">2</span><span class="txt"><b>要点标题占位。</b>每条只讲一个观点，宁可多分页也别挤。</span></li>
      <li><span class="idx">3</span><span class="txt"><b>要点标题占位。</b>结论先行，证据放后续页或附录。</span></li>
    </ul>
  </section>

  <!-- 4 ▸ 一排关键指标（数字大字） -->
  <section class="slide s-ink">
    <span class="kicker box">关键指标</span>
    <h2>数字会自己说话</h2>
    <div class="stat-row">
      <div class="stat"><div class="n mark">268亿</div><div class="l">目标市场规模</div><div class="sub dim">示意值，待核实</div></div>
      <div class="stat"><div class="n mark">3.2×</div><div class="l">交付效率提升</div><div class="sub dim">示意值，待核实</div></div>
      <div class="stat"><div class="n mark">↓80%</div><div class="l">单任务人力成本</div><div class="sub dim">示意值，待核实</div></div>
      <div class="stat"><div class="n mark">98%</div><div class="l">客户续约率</div><div class="sub dim">示意值，待核实</div></div>
    </div>
  </section>

  <!-- 5 ▸ 两栏对比 -->
  <section class="slide s-amber">
    <span class="kicker box">前后对比</span>
    <h2>从「手动堆活」到「调度同事」</h2>
    <div class="cols">
      <div class="col">
        <div class="tag">过去</div>
        <h3>人盯人、活堆活</h3>
        <ul>
          <li>跨工具反复复制粘贴</li>
          <li>上下文丢失、重复返工</li>
          <li>结果难追溯、口径不一</li>
        </ul>
      </div>
      <div class="col hot">
        <div class="tag">现在</div>
        <h3>派单给 AI 同事</h3>
        <ul>
          <li>一处下达、多角色协作</li>
          <li>上下文持久、有据可查</li>
          <li>交付物可预览可复用</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- 6 ▸ 时间线 / 路线图 -->
  <section class="slide s-teal">
    <span class="kicker box">产品路线图</span>
    <h2>四步走，稳交付</h2>
    <div class="road">
      <div class="step"><div class="dot"></div><div class="when">Q1</div><h3>立项与对齐</h3><p>明确角色分工与验收口径。</p></div>
      <div class="step"><div class="dot"></div><div class="when">Q2</div><h3>核心闭环</h3><p>打通派单到交付的主链路。</p></div>
      <div class="step"><div class="dot"></div><div class="when">Q3</div><h3>规模放量</h3><p>接入更多场景与团队。</p></div>
      <div class="step"><div class="dot"></div><div class="when">Q4</div><h3>生态开放</h3><p>开放技能与模板市场。</p></div>
    </div>
  </section>

  <!-- 7 ▸ 引述 / 金句 -->
  <section class="slide s-vermilion quote">
    <blockquote>最好的工具，<br>让人忘了它的存在。</blockquote>
    <div class="by">— 某位用户<span class="role"> · 增长团队负责人</span></div>
  </section>

  <!-- 8 ▸ 结尾 CTA -->
  <section class="slide s-ink cta">
    <span class="kicker box">现在开始</span>
    <h2>把第一个任务<br>交给 AI 同事</h2>
    <span class="btn">立即体验 <span class="arr">→</span></span>
    <div class="lines dim">
      <span>官网 example.com</span>
      <span>邮箱 hello@example.com</span>
      <span>微信 AIteam2026</span>
    </div>
  </section>

</main>

<nav id="bar" aria-label="幻灯片进度"></nav>

<script>
  // 渐进增强：脚本关闭时全部幻灯片仍可见可滚动（上面已是常显结构），这里只加进度点与键盘/点击导航。
  document.documentElement.classList.add('js');
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var bar = document.getElementById('bar');
  var cur = 0;
  slides.forEach(function(s, k){
    var d = document.createElement('button');
    d.className = 'dot';
    d.type = 'button';
    d.setAttribute('aria-label', '第 ' + (k + 1) + ' 页');
    d.addEventListener('click', function(){ go(k); });
    bar.appendChild(d);
  });
  var dots = Array.prototype.slice.call(bar.children);
  function paint(i){ dots.forEach(function(d, k){ d.classList.toggle('on', k === i); }); }
  function go(n){ cur = Math.max(0, Math.min(slides.length - 1, n)); slides[cur].scrollIntoView(); }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if (e.isIntersecting) { cur = slides.indexOf(e.target); paint(cur); } });
    }, { threshold: 0.6 });
    slides.forEach(function(s){ io.observe(s); });
  }
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(cur + 1); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); }
    if (e.key === 'Home') { go(0); }
    if (e.key === 'End') { go(slides.length - 1); }
  });
  paint(0);
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
  {
    id: "html-deck-navy-gold",
    name: "商务藏蓝金·精装演示（单文件 HTML）",
    desc: "深藏蓝渐变底 + 烫金徽标、机密提报版式、版本/日期元信息、右侧进度点；金融/政企/银行对外提报。脚本关闭可滚动浏览全部。套用：替换每页 .slide 文案、保留结构与配色，勿重画。",
    lang: "html",
    content: HTML_DECK_NAVY_GOLD,
  },
  {
    id: "html-deck-whitespace",
    name: "极简留白·朱墨·精装演示（单文件 HTML）",
    desc: "暖白大留白 + 超大无衬线标题 + 朱红点睛、左侧细线轴；咨询/战略/管理汇报。脚本关闭可滚动浏览。套用：替换文案、勿改版式配色。",
    lang: "html",
    content: HTML_DECK_WHITESPACE,
  },
  {
    id: "html-deck-circuit",
    name: "电光脉冲·科技·精装演示（单文件 HTML）",
    desc: "深色网格底 + 青色辉光主标题；科技/AI/产品发布会。脚本关闭可滚动浏览。套用：替换文案、保留辉光与栅格。",
    lang: "html",
    content: HTML_DECK_CIRCUIT,
  },
  {
    id: "html-deck-magazine",
    name: "编辑杂志·衬线·精装演示（单文件 HTML）",
    desc: "暖米底 + 超大衬线主标题 + 刊号版式；文化/品牌/内容向汇报。脚本关闭可滚动浏览。套用：替换文案、保留衬线版式。",
    lang: "html",
    content: HTML_DECK_MAGAZINE,
  },
  {
    id: "html-deck-colorblock",
    name: "撞色海报·朱橙黑·精装演示（单文件 HTML）",
    desc: "撞色大色块（朱红/琥珀）+ 极粗黑标题；营销/发布会/路演。脚本关闭可滚动浏览。套用：替换文案、保留撞色块。",
    lang: "html",
    content: HTML_DECK_COLORBLOCK,
  },
];

export function getSkillTemplate(id: string): SkillTemplate | undefined {
  return SKILL_TEMPLATES.find((t) => t.id === id);
}
