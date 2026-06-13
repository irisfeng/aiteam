import { useState, type FormEvent } from "react";
import { useWorkspace } from "../store";

const inputCls = "mb-2 w-full rounded-lg border border-line bg-panel px-3 py-2 text-[14px] outline-none focus:border-accent/50";

export function LoginView() {
  const ws = useWorkspace();
  const { allow_signup, needs_setup } = ws.authInfo;
  const [mode, setMode] = useState<"login" | "register">(needs_setup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "register") await ws.register(email.trim(), password, name.trim());
      else await ws.login(email.trim(), password);
      // 成功后 store 会切到工作区；不必复位 busy
    } catch (e2: any) {
      setErr(e2?.message || "操作失败");
      setBusy(false);
    }
  }

  const subtitle = needs_setup
    ? "创建第一个账号（将成为管理员）"
    : mode === "login"
    ? "登录你的 AI 团队工作台"
    : "注册新成员账号";

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-[360px] rounded-2xl border border-line bg-panel p-7 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-[15px] font-semibold text-white">A</div>
          <span className="text-[17px] font-semibold">AITeam</span>
        </div>
        <p className="mb-5 text-[13px] text-ink-3">{subtitle}</p>

        {mode === "register" && (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="显示名（如 张三）" className={inputCls} />
        )}
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="邮箱" autoComplete="username" className={inputCls} />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="密码（至少 6 位）"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          className={`${inputCls} mb-3`}
        />
        {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">{err}</div>}
        <button
          type="submit"
          disabled={busy || !email || !password || (mode === "register" && password.length < 6)}
          className="w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white disabled:opacity-40"
        >
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册"}
        </button>

        {!needs_setup && (
          <div className="mt-3 text-center text-[12.5px] text-ink-3">
            {mode === "login" ? (
              allow_signup ? (
                <>还没有账号？<button type="button" onClick={() => { setMode("register"); setErr(""); }} className="text-accent hover:underline">注册</button></>
              ) : (
                "如需账号请联系管理员开通"
              )
            ) : (
              <>已有账号？<button type="button" onClick={() => { setMode("login"); setErr(""); }} className="text-accent hover:underline">登录</button></>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
