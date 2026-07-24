import { useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, ShieldCheck, Sparkles } from "lucide-react";
import { useWorkspace } from "../store";
import { BrandLockup } from "./Brand";
import { queueFirstRun } from "./FirstRunGuide";

const inputCls = "w-full rounded-lg border border-line bg-panel px-3 py-2.5 text-[14px] outline-none transition-colors focus:border-accent/50";

export function LoginView() {
  const ws = useWorkspace();
  const { allow_signup, needs_setup } = ws.authInfo;
  const [mode, setMode] = useState<"login" | "register">(needs_setup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "register") {
        if (password !== confirmPassword) throw new Error("两次输入的密码不一致");
        await ws.register(email.trim(), password, name.trim());
        queueFirstRun(needs_setup ? "admin" : "member");
      } else await ws.login(email.trim(), password);
      // 成功后 store 会切到工作区；不必复位 busy
    } catch (e2: any) {
      setErr(e2?.message || "操作失败");
      setBusy(false);
    }
  }

  const subtitle = needs_setup
    ? "创建工作区管理员账号"
    : mode === "login"
    ? "登录你的 AI 团队工作台"
    : "注册新成员账号";

  const registering = mode === "register";
  const canSubmit = Boolean(email && password) && (!registering || (name.trim() && password.length >= 6 && password === confirmPassword));

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-paper px-4 py-8">
      <div className={`grid w-full overflow-hidden rounded-3xl border border-line bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.12)] ${registering ? "max-w-[900px] md:grid-cols-[1.05fr_0.95fr]" : "max-w-[430px]"}`}>
        {registering && (
          <section className="hidden border-r border-line bg-accent-soft/55 p-9 md:flex md:flex-col">
            <div><BrandLockup /></div>
            <div className="my-auto py-10">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-panel/70 px-3 py-1 text-[11.5px] font-medium text-accent">
                <Sparkles size={13} /> 新用户首次设置
              </div>
              <h1 className="mt-5 text-[30px] font-semibold leading-[1.18] tracking-[-0.035em] text-ink">
                先建立身份，<br />再开始第一项真实工作。
              </h1>
              <p className="mt-4 max-w-[360px] text-[13px] leading-6 text-ink-2">
                注册后会进入 3 步引导：认识工作方式、接入模型、发起首个任务。高级参数不会挡在你面前。
              </p>
              <div className="mt-7 space-y-3 text-[12.5px] text-ink-2">
                {["AI 执行，独立同事复核", "最终完成始终由你确认", "API Key 仅保存在服务端"].map((item) => (
                  <div key={item} className="flex items-center gap-2"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white"><Check size={12} /></span>{item}</div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-ink-3"><ShieldCheck size={14} /> 不捆绑订阅 · 未接模型也可先体验流程</div>
          </section>
        )}

        <form onSubmit={submit} className="p-7 sm:p-9">
          {!registering && <div className="mb-6"><BrandLockup /></div>}
          <div className="mb-6">
            <h2 className="text-[22px] font-semibold tracking-[-0.025em] text-ink">{subtitle}</h2>
            <p className="mt-1.5 text-[12.5px] leading-5 text-ink-3">
              {needs_setup ? "这是本工作区的第一个账号，将负责模型与成员设置。" : registering ? "加入后即可与团队共享任务进度和交付物。" : "继续推进你的任务、审批与交付。"}
            </p>
          </div>

          <div className="space-y-3.5">
            {registering && (
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-ink-2">你的名字</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="显示名（如 张三）" autoComplete="name" className={inputCls} />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink-2">邮箱</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="name@company.com" autoComplete="username" className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink-2">密码</span>
              <span className="relative block">
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type={showPassword ? "text" : "password"}
                  placeholder="密码（至少 6 位）"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className={`${inputCls} pr-10`}
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-3 hover:bg-sel hover:text-ink" aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
              {registering && <span className="mt-1 block text-[11px] text-ink-3">至少 6 位；建议使用字母、数字和符号组合。</span>}
            </label>
            {registering && (
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-ink-2">确认密码</span>
                <input value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} type={showPassword ? "text" : "password"} placeholder="再次输入密码" autoComplete="new-password" className={inputCls} />
                {confirmPassword && password !== confirmPassword && <span className="mt-1 block text-[11px] text-red-500">两次输入的密码不一致</span>}
              </label>
            )}
          </div>

          {err && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600" role="alert">{err}</div>}
          <button type="submit" disabled={busy || !canSubmit} className="mt-5 w-full rounded-lg bg-accent py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? "请稍候…" : mode === "login" ? "登录" : needs_setup ? "创建工作区并继续" : "创建账号并继续"}
          </button>

          {!needs_setup && (
            <div className="mt-4 text-center text-[12.5px] text-ink-3">
              {mode === "login" ? (
                allow_signup ? <>还没有账号？<button type="button" onClick={() => { setMode("register"); setErr(""); }} className="ml-1 text-accent hover:underline">注册</button></> : "如需账号请联系管理员开通"
              ) : (
                <>已有账号？<button type="button" onClick={() => { setMode("login"); setErr(""); }} className="ml-1 text-accent hover:underline">登录</button></>
              )}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
