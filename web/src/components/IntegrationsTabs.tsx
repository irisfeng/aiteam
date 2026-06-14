import { useEffect, useState } from "react";
import { API_BASE } from "../api";
import type { McpPreset } from "../types";

const SCENARIO_LABEL: Record<McpPreset["scenario"], string> = {
  "office-doc": "办公文档", "data-viz": "数据可视化", "code-mvp": "代码 MVP", research: "研究", general: "通用",
};
const CHINA_DOT: Record<McpPreset["runtime_china"], string> = { yes: "🟢", degrade: "🟡", no: "🔴" };
const SAFETY_LABEL: Record<McpPreset["safety"], string> = { local: "本地", network: "联网", exec: "执行·高危" };

const inputCls =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13.5px] outline-none focus:border-accent/50";
const labelCls = "mb-1 mt-3 block text-[12.5px] font-medium text-ink-2 first:mt-0";

interface McpServerInfo {
  id: string;
  name: string;
  kind: "http" | "stdio";
  url: string;
  command: string;
  args_json: string;
  enabled: number;
  has_token: boolean;
}

/** MCP 插件管理（Osaurus 插件面 / Helio 集成面的 v0） */
export function McpTab() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [safety, setSafety] = useState<"local" | "network" | "exec">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [showCatalog, setShowCatalog] = useState(false);

  const load = () =>
    fetch(`${API_BASE}/mcp-servers`)
      .then((r) => r.json())
      .then(setServers)
      .catch(() => undefined);
  useEffect(() => {
    void load();
    fetch(`${API_BASE}/registry`)
      .then((r) => r.json())
      .then((d) => setPresets(d.mcp ?? []))
      .catch(() => undefined);
  }, []);

  /** 一键预填：把预设填进下方添加表单（仍需 admin 确认/补 token，且 stdio 需宿主先按 install 装好依赖）。 */
  function prefill(p: McpPreset) {
    setName(p.key);
    setKind(p.kind);
    setUrl(p.url ?? "");
    setCommand(p.command ?? "");
    setArgs((p.args ?? []).join(" "));
    setSafety(p.safety);
    setToken("");
    setShowCatalog(false);
    setError(p.kind === "stdio" ? `已预填「${p.name}」。stdio 预设需先在服务器执行：${p.install}` : `已预填「${p.name}」，补好 Token 后添加。`);
  }

  async function add() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/mcp-servers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          url: url.trim(),
          auth_token: token.trim(),
          command: command.trim(),
          args: args.trim(),
          safety,
        }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "添加失败");
      setName(""); setUrl(""); setToken(""); setCommand(""); setArgs(""); setSafety("local");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: McpServerInfo) {
    await fetch(`${API_BASE}/mcp-servers/${s.id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await load();
  }

  async function test(s: McpServerInfo) {
    setTestResult((r) => ({ ...r, [s.id]: "测试中…" }));
    const res = await fetch(`${API_BASE}/mcp-servers/${s.id}/test`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setTestResult((r) => ({ ...r, [s.id]: res.ok ? `✓ ${body.tools} 个工具` : `✗ ${body.error ?? "失败"}` }));
  }

  async function remove(id: string) {
    await fetch(`${API_BASE}/mcp-servers/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        接入 <span className="font-medium">MCP server</span> 后，其工具会自动注入所有 AI
        同事的工作循环（工具名带 <code className="rounded bg-sel px-1 font-mono text-[11px]">mcp__</code> 前缀）。
        支持远程 HTTP 端点（可带 Bearer 认证）与本地 stdio 命令（如 <code className="rounded bg-sel px-1 font-mono text-[11px]">npx -y @modelcontextprotocol/server-filesystem /data</code>）。
        高风险动作仍受审批门约束。
      </div>

      {presets.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowCatalog((v) => !v)}
            className="rounded-lg border border-dashed border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:border-accent/40 hover:text-ink"
          >
            {showCatalog ? "▾" : "▸"} 浏览推荐预设（{presets.length}）
          </button>
          {showCatalog && (
            <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-line bg-sel/30 p-2">
              <div className="px-1 text-[11.5px] leading-relaxed text-ink-3">
                「预填」只填好下方表单 ≠ 开箱可用：stdio 预设需先在<span className="font-medium">服务器</span>按 install 指引装好依赖。
                可达性 运行/安装：🟢大陆可达 · 🟡需大陆镜像 · 🔴需海外网络。<span className="font-medium">执行·高危/联网</span>项受审批门约束，共用主机慎用。
              </div>
              {presets.map((p) => (
                <div key={p.key} className="rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{p.name}</span>
                    <span className="rounded bg-sel px-1 text-[10px] text-ink-3">{SCENARIO_LABEL[p.scenario]}</span>
                    <span className="rounded bg-sel px-1 font-mono text-[10px] text-ink-3">{p.kind}</span>
                    <span className="text-[10px] text-ink-3" title={`运行期 ${p.runtime_china}，安装期 ${p.install_china}`}>
                      运行{CHINA_DOT[p.runtime_china]} 装{CHINA_DOT[p.install_china]}
                    </span>
                    <span className={`rounded px-1 text-[10px] ${p.safety === "local" ? "bg-sel text-ink-3" : "bg-accent-soft text-ink-2"}`}>
                      {SAFETY_LABEL[p.safety]}
                    </span>
                    <button
                      onClick={() => prefill(p)}
                      className="ml-auto rounded border border-accent/50 px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent-soft"
                    >
                      预填
                    </button>
                  </div>
                  <div className="mt-1 text-ink-3">{p.desc}</div>
                  <div className="mt-1 break-all font-mono text-[10.5px] text-ink-3">install: {p.install}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {servers.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {servers.map((s) => (
            <div key={s.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean(s.enabled)} onChange={() => void toggle(s)} title="启用/停用" />
                <span className="font-medium">{s.name}</span>
                <span className="rounded bg-sel px-1 font-mono text-[10px] text-ink-3">{s.kind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
                  {s.kind === "stdio" ? `${s.command} ${JSON.parse(s.args_json || "[]").join(" ")}` : s.url}
                </span>
                <button onClick={() => void test(s)} className="rounded px-1.5 text-[12px] text-ink-2 hover:bg-sel">
                  测试
                </button>
                <button onClick={() => void remove(s.id)} className="rounded px-1 text-ink-3 hover:bg-sel hover:text-red-500">
                  ✕
                </button>
              </div>
              {testResult[s.id] && (
                <div className={`mt-1 pl-6 font-mono text-[11px] ${testResult[s.id].startsWith("✓") ? "text-green-600" : "text-ink-3"}`}>
                  {testResult[s.id]}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <label className={labelCls}>名称</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 github / filesystem" className={inputCls} />
      <label className={labelCls}>类型</label>
      <div className="flex gap-2">
        {(["http", "stdio"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${kind === k ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2"}`}
          >
            {k === "http" ? "远程 HTTP" : "本地 stdio"}
          </button>
        ))}
      </div>
      {kind === "http" ? (
        <>
          <label className={labelCls}>Server URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className={inputCls} />
          <label className={labelCls}>Bearer Token（可选，仅存服务端）</label>
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="…" className={inputCls} />
        </>
      ) : (
        <>
          <label className={labelCls}>命令</label>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className={inputCls} />
          <label className={labelCls}>参数（空格分隔）</label>
          <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /data" className={inputCls} />
        </>
      )}
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
      <button
        onClick={() => void add()}
        disabled={!name.trim() || busy}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        添加 MCP server
      </button>
    </div>
  );
}

interface SkillInfo {
  id: string;
  name: string;
  desc: string;
  content: string;
  kind: "method" | "capability";
  trigger: string;
  when_to_use: string;
  body: string;
  enabled: number;
  builtin: number;
}

/** 技能管理（Osaurus：横切的工作方法，启用后注入所有同事） */
export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [content, setContent] = useState("");
  const [trigger, setTrigger] = useState("");
  const [whenToUse, setWhenToUse] = useState("");

  const load = () =>
    fetch(`${API_BASE}/skills`)
      .then((r) => r.json())
      .then(setSkills)
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  async function toggle(s: SkillInfo) {
    await fetch(`${API_BASE}/skills/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await load();
  }

  async function create() {
    if (!name.trim() || !content.trim()) return;
    await fetch(`${API_BASE}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        desc: desc.trim(),
        body: content.trim(), // v2：正文存 body，read_skill 按需拉取
        when_to_use: whenToUse.trim(),
        trigger: trigger.trim(),
        kind: "method",
      }),
    });
    setName(""); setDesc(""); setContent(""); setTrigger(""); setWhenToUse(""); setCreating(false);
    await load();
  }

  async function remove(id: string) {
    await fetch(`${API_BASE}/skills/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        技能是<span className="font-medium">横切的工作方法</span>（与"角色"正交）：启用后，其
        <span className="font-medium">索引</span>（名称/何时用/触发词）注入所有 AI 同事的上下文，正文由同事按需用
        <code className="rounded bg-sel px-1 font-mono text-[11px]">read_skill</code> 拉取——所以可以放心多开，
        几乎不占常驻预算。<span className="font-medium">能力型</span>技能还会指向某个工具/MCP，依赖未就绪时自动标注。
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {skills.map((s) => (
          <div key={s.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(s.enabled)} onChange={() => void toggle(s)} title="启用后把索引注入所有同事" />
              <span className="font-medium">{s.name}</span>
              {Boolean(s.builtin) && <span className="rounded bg-sel px-1 font-mono text-[10px] text-ink-3">内置</span>}
              {s.kind === "capability" && <span className="rounded bg-accent-soft px-1 font-mono text-[10px] text-ink-2" title="能力型：指向工具/MCP">能力</span>}
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" title={s.when_to_use || s.desc}>
                {s.when_to_use || s.desc}
              </span>
              <span className="font-mono text-[10.5px] text-ink-3">{(s.body || s.content).length} 字</span>
              {!s.builtin && (
                <button onClick={() => void remove(s.id)} className="rounded px-1 text-ink-3 hover:bg-sel hover:text-red-500">
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {creating ? (
        <>
          <label className={labelCls}>技能名</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 客户邮件礼仪" className={inputCls} />
          <label className={labelCls}>一句话说明（desc，列表展示用）</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个方法是做什么的" className={inputCls} />
          <label className={labelCls}>何时使用（when_to_use，注入索引，触发同事来 read_skill）</label>
          <input value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} placeholder="例如 起草对外邮件时" className={inputCls} />
          <label className={labelCls}>触发词（trigger，逗号分隔；命中任务/消息时该技能索引排前）</label>
          <input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="邮件,回复,跟进,致谢" className={inputCls} />
          <label className={labelCls}>方法正文（body，写给 AI 同事的工作守则；按需才注入，可写长）</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} className={`${inputCls} resize-none`} placeholder="结论先行：… 1) … 2) … 3) …" />
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void create()}
              disabled={!name.trim() || !content.trim()}
              className="flex-1 rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
            >
              创建技能
            </button>
            <button onClick={() => setCreating(false)} className="rounded-lg border border-line px-4 text-[13px] text-ink-2 hover:bg-sel">
              取消
            </button>
          </div>
        </>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="mt-3 w-full rounded-lg border border-dashed border-line py-1.5 text-[12.5px] text-ink-3 hover:border-accent/40 hover:text-ink-2"
        >
          ✚ 创建自定义技能
        </button>
      )}
    </div>
  );
}
