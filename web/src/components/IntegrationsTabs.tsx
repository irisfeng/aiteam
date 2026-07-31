import { useEffect, useState } from "react";
import { API_BASE } from "../api";
import type { McpPreset } from "../types";
import { useWorkspace } from "../store";

const SCENARIO_LABEL: Record<McpPreset["scenario"], string> = {
  "office-doc": "办公文档", "data-viz": "数据可视化", "code-mvp": "代码 MVP", research: "研究", general: "通用",
};
const CHINA_DOT: Record<McpPreset["runtime_china"], string> = { yes: "🟢", degrade: "🟡", no: "🔴" };
const SAFETY_LABEL: Record<McpPreset["safety"], string> = { local: "本地", network: "联网", exec: "执行·高危" };

const inputCls =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13.5px] outline-none focus:border-accent/50";
const labelCls = "mb-1 mt-3 block text-[12.5px] font-medium text-ink-2 first:mt-0";
export const INTEGRATIONS_UPDATED_EVENT = "aiteam:integrations-updated";

function notifyIntegrationsUpdated() {
  window.dispatchEvent(new Event(INTEGRATIONS_UPDATED_EVENT));
}

interface McpServerInfo {
  id: string;
  name: string;
  kind: "http" | "stdio";
  url: string;
  command: string;
  container_image: string;
  args_json: string;
  safety: "local" | "network" | "exec";
  env_keys?: string[];
  enabled: number;
  has_token: boolean;
  runtime_available?: boolean;
  runtime_blocked_code?: string | null;
}

interface TaskTestState {
  text: string;
  taskId?: string;
}

/** 把 "KEY=VALUE" 多行文本解析为对象（值里允许含 =，按首个 = 切分） */
function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** MCP 插件管理（Osaurus 插件面 / Helio 集成面的 v0） */
export function McpTab({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const ws = useWorkspace();
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [containerImage, setContainerImage] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState(""); // KEY=VALUE 多行（stdio 子进程环境变量，如 BOCHA_API_KEY）
  const [safety, setSafety] = useState<"local" | "network" | "exec">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [taskTestResult, setTaskTestResult] = useState<Record<string, TaskTestState>>({});
  const [taskTestBusy, setTaskTestBusy] = useState<Record<string, boolean>>({});
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [stdioAvailable, setStdioAvailable] = useState(true);
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
      .then((d) => {
        setPresets(d.mcp ?? []);
        setStdioAvailable(d.runtime?.stdio_available !== false);
      })
      .catch(() => undefined);
  }, []);

  /** 一键预填：把预设填进下方添加表单（仍需 admin 确认/补 token，且 stdio 需宿主先按 install 装好依赖）。 */
  function prefill(p: McpPreset) {
    if (p.runtime_available === false) {
      setError(
        p.runtime_blocked_code === "MCP_STDIO_PRODUCTION_SAFETY_DISABLED"
          ? "生产沙箱当前只开放 local stdio；network/exec 预设继续禁用。"
          : "生产环境未配置可用的 rootless Podman stdio 沙箱运行器，本地 MCP 暂不可用。",
      );
      setShowCatalog(false);
      return;
    }
    setName(p.key);
    setKind(p.kind);
    setUrl(p.url ?? "");
    setCommand(p.command ?? "");
    setContainerImage("");
    setArgs((p.args ?? []).join(" "));
    setSafety(p.safety);
    setToken("");
    // 预填该预设需要的环境变量名（值留空待 admin 填，如 BOCHA_API_KEY=你的key）
    setEnvText((p.env_keys ?? []).map((k) => `${k}=`).join("\n"));
    setShowCatalog(false);
    const envHint = p.env_keys?.length ? `；并在"环境变量"里填好 ${p.env_keys.join("/")}` : "";
    setError(p.kind === "stdio" ? `已预填「${p.name}」。stdio 预设需先在服务器执行：${p.install}${envHint}` : `已预填「${p.name}」，补好 Token 后添加。`);
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
          container_image: containerImage.trim(),
          args: args.trim(),
          safety,
          env: parseEnvLines(envText),
        }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "添加失败");
      setName(""); setUrl(""); setToken(""); setCommand(""); setContainerImage(""); setArgs(""); setEnvText(""); setSafety("local");
      await load();
      notifyIntegrationsUpdated();
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
    notifyIntegrationsUpdated();
  }

  async function test(s: McpServerInfo) {
    setTestResult((r) => ({ ...r, [s.id]: "测试中…" }));
    const res = await fetch(`${API_BASE}/mcp-servers/${s.id}/test`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setTestResult((r) => ({ ...r, [s.id]: res.ok ? `✓ ${body.tools} 个工具` : `✗ ${body.error ?? "失败"}` }));
  }

  async function runTaskTest(s: McpServerInfo) {
    if (taskTestBusy[s.id]) return;
    setTaskTestBusy((r) => ({ ...r, [s.id]: true }));
    setTaskTestResult((r) => ({ ...r, [s.id]: { text: "能力演练中…" } }));
    try {
      const out = await ws.runMcpTaskTest(s.id);
      const checks = [
        out.checks.connected ? `${out.checks.tools} 工具` : "未连接",
        out.checks.source_document_created ? "来源文档" : out.checks.converted ? "已转换" : "无来源文档",
        out.task.status,
      ].join(" / ");
      setTaskTestResult((r) => ({ ...r, [s.id]: { text: `${out.ok ? "通过" : "未通过"} · ${checks} · ${out.latency_ms}ms`, taskId: out.task.id } }));
      await load();
      notifyIntegrationsUpdated();
    } catch (e: any) {
      setTaskTestResult((r) => ({ ...r, [s.id]: { text: `失败：${String(e?.message ?? e).slice(0, 160)}` } }));
    } finally {
      setTaskTestBusy((r) => ({ ...r, [s.id]: false }));
    }
  }

  async function remove(id: string) {
    await fetch(`${API_BASE}/mcp-servers/${id}`, { method: "DELETE" });
    await load();
    notifyIntegrationsUpdated();
  }

  return (
    <div>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        接入 <span className="font-medium">MCP server</span> 后，其工具会自动注入所有 AI
        同事的工作循环（工具名带 <code className="rounded bg-sel px-1 font-mono text-[11px]">mcp__</code> 前缀）。
        支持远程 HTTP 端点（可带 Bearer 认证）
        {stdioAvailable ? (
          <>与隔离 stdio；生产仅开放 rootless Podman 中的 <code className="rounded bg-sel px-1 font-mono text-[11px]">local</code> 插件，并要求镜像按 sha256 digest 固定</>
        ) : (
          <>；当前生产运行时在独立沙箱落地前已禁用本地 stdio</>
        )}。
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
                    {p.runtime_available === false && (
                      <span className="rounded bg-red-50 px-1 text-[10px] text-red-600">
                        生产禁用
                      </span>
                    )}
                    <button
                      onClick={() => prefill(p)}
                      disabled={p.runtime_available === false}
                      className="ml-auto rounded border border-accent/50 px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
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
                <input
                  type="checkbox"
                  checked={Boolean(s.enabled)}
                  onChange={() => void toggle(s)}
                  disabled={s.runtime_available === false && !Boolean(s.enabled)}
                  title={
                    s.runtime_available === false
                      ? s.enabled
                        ? "运行时不可用；可停用此插件"
                        : "生产运行时已禁用 stdio"
                      : "启用/停用"
                  }
                />
                <span className="font-medium">{s.name}</span>
                <span className="rounded bg-sel px-1 font-mono text-[10px] text-ink-3">{s.kind}</span>
                {s.safety && s.safety !== "local" && (
                  <span
                    className="rounded bg-accent-soft px-1 text-[10px] text-ink-2"
                    title={s.safety === "exec" ? "执行类高危：AI 调用前强制走审批门" : "联网：会外发查询（读为主，不拦截）"}
                  >
                    {SAFETY_LABEL[s.safety]}
                  </span>
                )}
                {s.env_keys && s.env_keys.length > 0 && (
                  <span className="rounded bg-sel px-1 text-[10px] text-ink-3" title={`已设环境变量：${s.env_keys.join(", ")}`}>🔑{s.env_keys.length}</span>
                )}
                {s.runtime_available === false && (
                  <span className="rounded bg-red-50 px-1 text-[10px] text-red-600">
                    生产禁用
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
                  {s.kind === "stdio" ? `${s.command} ${JSON.parse(s.args_json || "[]").join(" ")}` : s.url}
                </span>
                <button
                  onClick={() => void test(s)}
                  disabled={s.runtime_available === false}
                  className="rounded px-1.5 text-[12px] text-ink-2 hover:bg-sel disabled:cursor-not-allowed disabled:opacity-40"
                >
                  测试
                </button>
                <button
                  onClick={() => void runTaskTest(s)}
                  disabled={Boolean(taskTestBusy[s.id]) || s.runtime_available === false}
                  className="rounded px-1.5 text-[12px] text-ink-2 hover:bg-sel disabled:opacity-40"
                  title="创建一条 MCP 能力演练任务，记录工具、交付、验收事件；markitdown 会生成来源文档"
                >
                  {taskTestBusy[s.id] ? "演练中…" : "能力演练"}
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
              {taskTestResult[s.id] && (
                <div className={`mt-1 flex items-center gap-2 pl-6 font-mono text-[11px] ${taskTestResult[s.id].text.startsWith("通过") ? "text-green-600" : "text-ink-3"}`}>
                  <span className="min-w-0 flex-1 truncate">能力演练：{taskTestResult[s.id].text}</span>
                  {taskTestResult[s.id].taskId && (
                    <button
                      onClick={() => onOpenTask?.(taskTestResult[s.id]!.taskId!)}
                      className="shrink-0 rounded px-1.5 font-sans text-[12px] text-accent hover:bg-accent-soft"
                      title="打开该 MCP 演练任务详情"
                    >
                      打开任务
                    </button>
                  )}
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
            disabled={k === "stdio" && !stdioAvailable}
            className={`rounded-lg border px-3 py-1.5 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-40 ${kind === k ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2"}`}
          >
            {k === "http" ? "远程 HTTP" : "本地 stdio"}
          </button>
        ))}
      </div>
      <label className={labelCls}>安全分级（联网/执行=高危，AI 调用前强制走审批门）</label>
      <div className="flex gap-2">
        {(["local", "network", "exec"] as const).map((sv) => (
          <button
            key={sv}
            onClick={() => setSafety(sv)}
            className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${safety === sv ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2"}`}
          >
            {sv === "local" ? "本地" : sv === "network" ? "联网" : "执行·高危"}
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
          <label className={labelCls}>生产容器镜像（必须固定 sha256 digest）</label>
          <input
            value={containerImage}
            onChange={(e) => setContainerImage(e.target.value)}
            placeholder="registry.example/aiteam-mcp@sha256:…"
            className={`${inputCls} font-mono text-[12px]`}
          />
          <div className="mt-1 text-[11px] leading-relaxed text-ink-3">
            生产 runner 使用预拉取镜像（<code>--pull=never</code>）、禁网、只读根文件系统和独立 Mission 工作区；可变 tag 会被拒绝。
          </div>
          <label className={labelCls}>参数（空格分隔）</label>
          <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /data" className={inputCls} />
          <label className={labelCls}>环境变量（每行 KEY=VALUE，密钥仅存服务端、不下发前端）</label>
          <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={2} className={`${inputCls} resize-none font-mono text-[12px]`} placeholder="BOCHA_API_KEY=sk-..." />
        </>
      )}
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
      <button
        onClick={() => void add()}
        disabled={!name.trim() || busy || (kind === "stdio" && !stdioAvailable)}
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
export function SkillsTab({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const ws = useWorkspace();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [content, setContent] = useState("");
  const [trigger, setTrigger] = useState("");
  const [whenToUse, setWhenToUse] = useState("");
  const [error, setError] = useState("");
  const [taskTestResult, setTaskTestResult] = useState<Record<string, TaskTestState>>({});
  const [taskTestBusy, setTaskTestBusy] = useState<Record<string, boolean>>({});

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
    notifyIntegrationsUpdated();
  }

  async function create() {
    if (!name.trim() || !content.trim()) return;
    setError("");
    const res = await fetch(`${API_BASE}/skills`, {
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
    if (!res.ok) {
      setError((await res.json().catch(() => ({})))?.error ?? "创建失败，请重试");
      return; // 失败时保留用户输入，不清空、不收起表单
    }
    setName(""); setDesc(""); setContent(""); setTrigger(""); setWhenToUse(""); setError(""); setCreating(false);
    await load();
    notifyIntegrationsUpdated();
  }

  async function remove(id: string) {
    await fetch(`${API_BASE}/skills/${id}`, { method: "DELETE" });
    await load();
    notifyIntegrationsUpdated();
  }

  async function runTaskTest(s: SkillInfo) {
    if (taskTestBusy[s.id]) return;
    setTaskTestBusy((r) => ({ ...r, [s.id]: true }));
    setTaskTestResult((r) => ({ ...r, [s.id]: { text: "演练中…" } }));
    try {
      const out = await ws.runSkillTaskTest(s.id);
      const checks = [
        out.checks.enabled ? "已启用" : "未启用",
        out.checks.read_hint ? "索引" : "无索引",
        out.checks.body_loaded ? "正文" : "无正文",
        out.task.status,
      ].join(" / ");
      setTaskTestResult((r) => ({ ...r, [s.id]: { text: `${out.ok ? "通过" : "未通过"} · ${checks}`, taskId: out.task.id } }));
      await load();
      notifyIntegrationsUpdated();
    } catch (e: any) {
      setTaskTestResult((r) => ({ ...r, [s.id]: { text: `失败：${String(e?.message ?? e).slice(0, 160)}` } }));
    } finally {
      setTaskTestBusy((r) => ({ ...r, [s.id]: false }));
    }
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
              <button
                onClick={() => void runTaskTest(s)}
                disabled={Boolean(taskTestBusy[s.id])}
                className="rounded px-1.5 text-[12px] text-ink-2 hover:bg-sel disabled:opacity-40"
                title="创建一条技能演练任务，验证技能索引、read_skill 正文读取和报告交付"
              >
                {taskTestBusy[s.id] ? "演练中…" : "演练"}
              </button>
              {!s.builtin && (
                <button onClick={() => void remove(s.id)} className="rounded px-1 text-ink-3 hover:bg-sel hover:text-red-500">
                  ✕
                </button>
              )}
            </div>
            {taskTestResult[s.id] && (
              <div className={`mt-1 flex items-center gap-2 pl-6 font-mono text-[11px] ${taskTestResult[s.id].text.startsWith("通过") ? "text-green-600" : "text-ink-3"}`}>
                <span className="min-w-0 flex-1 truncate">技能演练：{taskTestResult[s.id].text}</span>
                {taskTestResult[s.id].taskId && (
                  <button
                    onClick={() => onOpenTask?.(taskTestResult[s.id]!.taskId!)}
                    className="shrink-0 rounded px-1.5 font-sans text-[12px] text-accent hover:bg-accent-soft"
                    title="打开该技能演练任务详情"
                  >
                    打开任务
                  </button>
                )}
              </div>
            )}
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
          {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
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
