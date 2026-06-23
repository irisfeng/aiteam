import { useMemo, useState } from "react";
import { api } from "../api";
import { useWorkspace } from "../store";
import type { Doc } from "../types";

interface Slot { slideIdx: number; shapeIdx: number; paraIdx: number; text: string; kind: "ph" | "sp"; phType?: string }
interface Meta { slideCount: number; slots: Slot[]; warnings: string[] }
interface Row { value: string; checked: boolean }

/** 上传 .pptx 模板「就地改图文」编辑器（方案① MVP）：逐槽确认 + AI 按来源建议 + 导出保真 pptx。
 *  只改文本、保留母版/版式/配色；表格/图表/SmartArt 列入告警、不就地改。 */
export function TemplateEditor({ doc }: { doc: Doc }) {
  const ws = useWorkspace();
  const meta = useMemo<Meta | null>(() => {
    try { const m = JSON.parse(doc.template_meta || "{}"); return Array.isArray(m.slots) ? m : null; } catch { return null; }
  }, [doc.template_meta]);

  const [rows, setRows] = useState<Row[]>(() => (meta?.slots ?? []).map((s) => ({ value: s.text, checked: false })));
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState<"" | "propose" | "export">("");
  const [note, setNote] = useState<string>("");

  const sourceDocs = ws.documents.filter((d) => d.kind === "source");
  if (!meta) return <div className="p-6 text-[13px] text-ink-3">无法解析该模板的槽位信息（template_meta 缺失或损坏）。请重新上传 .pptx。</div>;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }

  async function aiPropose() {
    setBusy("propose"); setNote("");
    try {
      const { suggestions } = await api.proposeTemplateEdits(doc.id, { sourceDocIds: [...sources], brief: brief.trim() || undefined });
      if (!suggestions.length) { setNote("AI 未给出可替换建议（可能来源不足或都属固定文案）。可手动编辑。"); return; }
      setRows((rs) => rs.map((r, i) => {
        const s = suggestions.find((x) => x.idx === i);
        return s ? { value: s.suggestion, checked: true } : r;
      }));
      setNote(`AI 给出 ${suggestions.length} 处建议（已勾选，可逐条改/取消）。`);
    } catch (e) { setNote("AI 建议失败：" + ((e as Error)?.message ?? e)); }
    finally { setBusy(""); }
  }

  async function exportPptx() {
    const edits = (meta!.slots).map((s, i) => ({ s, i }))
      .filter(({ i }) => rows[i].checked && rows[i].value.trim() && rows[i].value !== meta!.slots[i].text)
      .map(({ s, i }) => ({ slideIdx: s.slideIdx, shapeIdx: s.shapeIdx, paraIdx: s.paraIdx, newText: rows[i].value }));
    if (!edits.length) { setNote("没有勾选并改动的槽位——勾选要替换的槽、改好文案再导出。"); return; }
    setBusy("export"); setNote("");
    try {
      const blob = await api.templateExport(doc.id, edits);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = doc.title.replace(/\.pptx$/i, "") + "-已编辑.pptx";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setNote(`已导出：替换 ${edits.length} 处，其余 ${meta!.slots.length - edits.length} 处保留原样。母版/版式/配色未改。`);
    } catch (e) { setNote("导出失败：" + ((e as Error)?.message ?? e)); }
    finally { setBusy(""); }
  }

  // 按页分组
  const byPage = new Map<number, number[]>();
  meta.slots.forEach((s, i) => { const a = byPage.get(s.slideIdx) ?? []; a.push(i); byPage.set(s.slideIdx, a); });
  const checkedCount = rows.filter((r, i) => r.checked && r.value !== meta.slots[i].text && r.value.trim()).length;

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-[12.5px] text-ink-2">
        🪄 模板就地改图文：勾选要替换的文字槽、改好文案后「导出已编辑 .pptx」。只换文本，<b>母版/版式/配色原样保留</b>；本迭代不换图。
      </div>

      {meta.warnings.length > 0 && (
        <div className="rounded-lg border border-line bg-sel/60 px-3 py-2 text-[12px] text-ink-2">
          ⚠️ 保真边界（以下结构本迭代保留原样、不就地改）：
          <ul className="ml-4 mt-1 list-disc">{meta.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {/* AI 按来源建议 */}
      <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
        <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">让 AI 按来源产替换文案（建议，仍需你逐槽确认）</div>
        {sourceDocs.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {sourceDocs.map((d) => {
              const on = sources.has(d.id);
              return (
                <button key={d.id}
                  onClick={() => setSources((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
                  className={`rounded-full border px-2 py-0.5 text-[11.5px] ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-3 hover:bg-sel"}`}
                  title={d.title}>
                  {on ? "✓ " : "📎 "}{d.title.length > 16 ? d.title.slice(0, 16) + "…" : d.title}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mb-2 text-[11.5px] text-ink-3">还没有「来源」文档。可先在文档面板「📎 上传来源」，AI 会据此接地改写；也可只填下面的目标，仅做语义润色（不编造数字）。</div>
        )}
        <div className="flex gap-2">
          <input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="目标/语气（可选）：如『改成面向银行客户的售前版、口吻稳重』"
            className="min-w-0 flex-1 rounded-lg border border-line bg-sel px-3 py-1.5 text-[12px] outline-none focus:border-accent/50" />
          <button onClick={aiPropose} disabled={busy !== ""}
            className="shrink-0 rounded-lg border border-accent/50 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
            {busy === "propose" ? "生成中…" : "✨ AI 按来源建议"}
          </button>
        </div>
      </div>

      {note && <div className="rounded-lg border border-line bg-sel/50 px-3 py-1.5 text-[12px] text-ink-2">{note}</div>}

      {/* 槽位清单（按页） */}
      <div className="flex flex-col gap-3">
        {[...byPage.keys()].sort((a, b) => a - b).map((page) => (
          <div key={page} className="rounded-lg border border-line">
            <div className="border-b border-line bg-sel/40 px-3 py-1.5 text-[12px] font-medium text-ink-2">第 {page + 1} 页</div>
            <div className="flex flex-col divide-y divide-line">
              {byPage.get(page)!.map((i) => {
                const s = meta.slots[i]; const r = rows[i];
                const changed = r.value !== s.text && r.value.trim() !== "";
                return (
                  <div key={i} className="flex gap-2 px-3 py-2">
                    <input type="checkbox" checked={r.checked} onChange={(e) => setRow(i, { checked: e.target.checked })}
                      className="mt-1 shrink-0" title="勾选 = 用下方文案替换此槽" />
                    <div className="min-w-0 flex-1">
                      {s.text ? (
                        <div className="mb-1 truncate text-[11px] text-ink-3" title={s.text}>原文：{s.text}</div>
                      ) : (
                        <div className="mb-1 text-[11px] text-accent/80">空占位（{s.phType || "内容"}）· 待填入</div>
                      )}
                      <textarea value={r.value} onChange={(e) => setRow(i, { value: e.target.value })}
                        placeholder={s.text ? "" : `按「${s.phType || "内容"}」填写…`}
                        rows={Math.min(4, Math.max(1, Math.ceil((r.value.length || 12) / 38)))}
                        className={`w-full resize-y rounded border px-2 py-1 text-[12.5px] outline-none ${changed ? "border-accent/60 bg-accent-soft/40" : "border-line bg-sel/40"} focus:border-accent/60`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 导出 */}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-panel py-2">
        <span className="text-[12px] text-ink-3">已勾选改动 {checkedCount} 处 · 共 {meta.slots.length} 槽 · {meta.slideCount} 页</span>
        <button onClick={exportPptx} disabled={busy !== ""}
          className="ml-auto rounded-lg border border-accent/50 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
          {busy === "export" ? "导出中…" : "⬇ 导出已编辑 .pptx"}
        </button>
      </div>
    </div>
  );
}
