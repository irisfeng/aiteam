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
    install: "在智谱开放平台 open.bigmodel.cn 申请 API Key，填入 Bearer Token；无需本地安装。",
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
    args: ["mcp-server-sqlite", "--db-path", "./server/data/app.db"],
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
    name: "高保真可编辑 PPTX",
    kind: "stdio",
    command: "python",
    args: ["-m", "ppt_master"],
    desc: "生成真 DrawingML、可在 PowerPoint 继续编辑的 PPTX（社区 ppt-master，本地 Python）。office-doc 场景。本地执行=高危，默认关、不建议共用主机直接启用。",
    scenario: "office-doc",
    runtime_china: "yes",
    install_china: "degrade",
    safety: "exec",
    install: `参考 github.com/hugohe3/ppt-master 本地部署（Python，依赖装清华源 ${PIP_MIRROR}）；不可用时降级用 slides(Marp→pptx)`,
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
