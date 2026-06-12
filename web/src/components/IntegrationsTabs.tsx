import { useEffect, useState } from "react";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const load = () =>
    fetch("/api/mcp-servers")
      .then((r) => r.json())
      .then(setServers)
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          url: url.trim(),
          auth_token: token.trim(),
          command: command.trim(),
          args: args.trim(),
        }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "添加失败");
      setName(""); setUrl(""); setToken(""); setCommand(""); setArgs("");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: McpServerInfo) {
    await fetch(`/api/mcp-servers/${s.id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await load();
  }

  async function test(s: McpServerInfo) {
    setTestResult((r) => ({ ...r, [s.id]: "测试中…" }));
    const res = await fetch(`/api/mcp-servers/${s.id}/test`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setTestResult((r) => ({ ...r, [s.id]: res.ok ? `✓ ${body.tools} 个工具` : `✗ ${body.error ?? "失败"}` }));
  }

  async function remove(id: string) {
    await fetch(`/api/mcp-servers/${id}`, { method: "DELETE" });
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

  const load = () =>
    fetch("/api/skills")
      .then((r) => r.json())
      .then(setSkills)
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  async function toggle(s: SkillInfo) {
    await fetch(`/api/skills/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    await load();
  }

  async function create() {
    if (!name.trim() || !content.trim()) return;
    await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), desc: desc.trim(), content: content.trim() }),
    });
    setName(""); setDesc(""); setContent(""); setCreating(false);
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/skills/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        技能是<span className="font-medium">横切的工作方法</span>（与"角色"正交）：启用后注入所有 AI
        同事的工作上下文，执行任务时遵循。总注入量封顶 4000 字，按需开启、不要全开。
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {skills.map((s) => (
          <div key={s.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(s.enabled)} onChange={() => void toggle(s)} title="启用后注入所有同事" />
              <span className="font-medium">{s.name}</span>
              {Boolean(s.builtin) && <span className="rounded bg-sel px-1 font-mono text-[10px] text-ink-3">内置</span>}
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" title={s.desc}>
                {s.desc}
              </span>
              <span className="font-mono text-[10.5px] text-ink-3">{s.content.length} 字</span>
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
          <label className={labelCls}>一句话说明</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="什么时候该用这个方法" className={inputCls} />
          <label className={labelCls}>方法内容（写给 AI 同事的工作守则）</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} className={`${inputCls} resize-none`} placeholder="1) … 2) … 3) …" />
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
